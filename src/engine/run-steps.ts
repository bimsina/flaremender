import { and, eq, inArray } from 'drizzle-orm'
import { NonRetryableError } from 'cloudflare:workflows'

import { recordRunError, recordRunResult } from './run-records.ts'
import { createDb } from '#/db/index.ts'
import type { ArtifactKeys, RunPurpose, RunStatus } from '#/db/schema/app.ts'
import { environment, environmentVariable, project, run, scriptVersion } from '#/db/schema/app.ts'
import type { RunEvent, RunOutcome, RunResult } from '#/engine/contract.ts'
import { artifactPrefix, writeArtifacts } from '#/engine/runner/artifacts.ts'
import { executeInDynamicWorker, releaseBrowserSession } from '#/engine/runner/loader.ts'
import { createScrubber } from '#/engine/runner/scrub.ts'
import { decryptSecret } from '#/server/core/crypto.ts'

export interface LoadedRun {
  intentId: string
  projectId: string
  environmentId: string
  scriptVersionId: string
  code: string
  baseUrl: string
  prefix: string
  purpose: RunPurpose
  startedAt: number
}

export interface ExecutedRun {
  result: RunResult
  artifactKeys: ArtifactKeys
  artifactWarnings?: Array<string>
  sessionId: string | null
}

export interface SessionReuse {
  sessionId: string | null
  keepAlive: boolean
}

export const EXECUTE_STEP_CONFIG = {
  retries: { limit: 1, delay: '5 seconds' },
  timeout: '10 minutes',
} as const

export const PERSIST_ERROR_STEP_CONFIG = {
  retries: { limit: 2, delay: '2 seconds' },
} as const

class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserUnavailableError'
  }
}

const OUTCOME_TO_RUN_STATUS: Record<RunOutcome, RunStatus> = {
  passed: 'passed',
  failed: 'failed',
  error: 'error',
}

export async function loadRun(
  env: Cloudflare.Env,
  runId: string,
  organizationId: string,
): Promise<LoadedRun> {
  const db = createDb(env.DB)

  const [row] = await db
    .select({
      run,
      environment,
      scriptVersion,
      projectId: project.id,
    })
    .from(run)
    .innerJoin(project, eq(project.id, run.projectId))
    .innerJoin(environment, eq(environment.id, run.environmentId))
    .innerJoin(scriptVersion, eq(scriptVersion.id, run.scriptVersionId))
    .where(and(eq(run.id, runId), eq(project.organizationId, organizationId)))
    .limit(1)

  if (!row) {
    throw new NonRetryableError(`Run ${runId} does not exist in this organization.`)
  }

  const prefix = artifactPrefix({ organizationId, projectId: row.projectId, runId })

  await db
    .update(run)
    .set({
      status: 'running',
      artifactPrefix: prefix,
      workflowInstanceId: runId,
      environmentName: row.run.environmentName ?? row.environment.name,
      baseUrl: row.run.baseUrl ?? row.environment.baseUrl,
    })
    .where(and(eq(run.id, runId), inArray(run.status, ['queued', 'running'])))

  await announceRun(env, runId, { type: 'run.started', runId, at: Date.now() })

  return {
    intentId: row.run.intentId,
    projectId: row.projectId,
    environmentId: row.run.environmentId,
    scriptVersionId: row.run.scriptVersionId,
    code: row.scriptVersion.code,
    baseUrl: row.run.baseUrl ?? row.environment.baseUrl,
    purpose: row.run.purpose,
    startedAt: row.run.startedAt.getTime(),
    prefix,
  }
}

export async function executeRun(
  env: Cloudflare.Env,
  runId: string,
  loaded: LoadedRun,
  reuse?: SessionReuse | null,
): Promise<ExecutedRun> {
  const db = createDb(env.DB)

  const rows = await db
    .select({
      name: environmentVariable.name,
      encryptedValue: environmentVariable.encryptedValue,
    })
    .from(environmentVariable)
    .where(eq(environmentVariable.environmentId, loaded.environmentId))

  const creds: Record<string, string> = {}
  const undecryptable: Array<string> = []
  for (const row of rows) {
    try {
      creds[row.name] = await decryptSecret(row.encryptedValue)
    } catch {
      undecryptable.push(row.name)
    }
  }

  const scrubber = createScrubber(Object.values(creds))

  let result: RunResult
  let captureWarnings: Array<string> = []
  let screenshot: ArrayBuffer | null = null
  let trace: ArrayBuffer | null = null
  let sessionId: string | null = reuse?.keepAlive ? (reuse.sessionId ?? null) : null

  const startedAt = Date.now()

  try {
    const response = await executeInDynamicWorker({
      loader: env.LOADER,
      browser: env.BROWSER,
      runId,
      code: loaded.code,
      baseUrl: loaded.baseUrl,
      creds,
      channel: env.RUN_CHANNEL.getByName(runId),
      sessionId: reuse?.sessionId ?? null,
      keepSessionAlive: reuse?.keepAlive ?? false,
    })

    if (reuse?.keepAlive) {
      sessionId = response.sessionId
      console.log(
        `[run-steps] ${runId} used browser session ${response.sessionId ?? 'none'} (${
          response.sessionReused ? 'reused' : 'new'
        })`,
      )
    }

    if (response.errorKind === 'browser') {
      throw new BrowserUnavailableError(
        response.result.errorMessage ?? 'The browser session could not be started.',
      )
    }

    captureWarnings = response.artifactWarnings ?? []
    result = response.result
    screenshot = response.screenshot
    trace = response.trace
  } catch (error) {
    if (error instanceof BrowserUnavailableError) throw error

    result = {
      outcome: 'error',
      steps: [],
      errorMessage: error instanceof Error ? error.message : String(error),
      logs: [],
      durationMs: Date.now() - startedAt,
    }
  }

  if (undecryptable.length > 0) {
    result.logs.push(
      `[engine] could not decrypt ${undecryptable.join(', ')} — ENCRYPTION_KEY has changed since they were saved.`,
    )
  }

  const scrubbed: RunResult = {
    outcome: result.outcome,
    steps: result.steps.map((step) => ({
      ...step,
      label: scrubber.text(step.label),
      ...(step.error === undefined ? {} : { error: scrubber.text(step.error) }),
    })),
    errorMessage: scrubber.nullable(result.errorMessage),
    logs: scrubber.lines(result.logs),
    durationMs: result.durationMs,
  }

  const { keys, failures } = await writeArtifacts(env.ARTIFACTS, loaded.prefix, {
    screenshot,
    trace,
    result: scrubbed,
  })

  return {
    result: scrubbed,
    artifactKeys: keys,
    artifactWarnings: [...captureWarnings, ...failures].map(scrubber.text),
    sessionId,
  }
}

export async function releaseRunSession(
  env: Cloudflare.Env,
  sessionId: string,
): Promise<{ released: boolean }> {
  try {
    const result = await releaseBrowserSession({
      loader: env.LOADER,
      browser: env.BROWSER,
      sessionId,
    })

    if (!result.released) {
      console.warn(`[run-steps] session ${sessionId} was already gone: ${result.message}`)
    }

    return { released: result.released }
  } catch (error) {
    console.error(`[run-steps] could not release session ${sessionId}:`, error)
    return { released: false }
  }
}

export async function persistRun(
  env: Cloudflare.Env,
  runId: string,
  loaded: LoadedRun,
  executed: ExecutedRun,
): Promise<{ runId: string; status: RunStatus }> {
  const db = createDb(env.DB)
  const status = await recordRunResult(
    db,
    runId,
    loaded,
    executed,
    OUTCOME_TO_RUN_STATUS[executed.result.outcome],
  )

  await announceRun(
    env,
    runId,
    {
      type: 'run.finished',
      runId,
      outcome:
        status === 'passed' || status === 'healed'
          ? 'passed'
          : status === 'failed'
            ? 'failed'
            : 'error',
      errorMessage: executed.result.errorMessage,
      at: Date.now(),
    },
    { final: true },
  )

  return { runId, status }
}

export async function persistRunError(
  env: Cloudflare.Env,
  runId: string,
  error: unknown,
): Promise<void> {
  const db = createDb(env.DB)

  const stored = await recordRunError(
    db,
    runId,
    'Execution could not finish. The browser or workflow was unavailable.',
  )

  console.error(`[run-steps] ${runId} failed:`, error)

  await announceRun(
    env,
    runId,
    {
      type: 'run.finished',
      runId,
      outcome:
        stored.status === 'passed' || stored.status === 'healed'
          ? 'passed'
          : stored.status === 'failed'
            ? 'failed'
            : 'error',
      errorMessage: stored.errorMessage,
      at: Date.now(),
    },
    { final: true },
  )
}

export async function announceRun(
  env: Cloudflare.Env,
  runId: string,
  event: RunEvent,
  options?: { final?: boolean },
): Promise<void> {
  try {
    const channel = env.RUN_CHANNEL.getByName(runId)
    await (options?.final ? channel.finish(event) : channel.push(event))
  } catch (error) {
    console.error(`[run-steps] ${runId} could not reach its channel:`, error)
  }
}
