/**
 * What one run *is*, independent of who is orchestrating it.
 *
 * A run is three pieces of work — work out what to execute, execute it, record
 * what happened — plus a safety net for when one of them will not complete.
 * They live here rather than inside `RunWorkflow` because a suite runs the same
 * three pieces, in the same order, with the same retry policy, for each of its
 * members: two copies of this logic would drift, and the copy that drifted
 * would be the one that decides whether a run is allowed to say it passed.
 *
 * Each function is written to be the body of a Workflow step, which is a
 * stronger constraint than it looks:
 *
 * - **Every one of them is re-runnable.** A step that fails after committing is
 *   retried from the top, so `persistRun` inserts its attempt row under a
 *   deterministic id with `onConflictDoNothing`, and `persistRunError` guards
 *   its update on the run still being unfinished.
 * - **Nothing live crosses a boundary.** Workflows serialise step return values,
 *   so a Durable Object stub is resolved inside the step that uses it, never
 *   carried in.
 * - **Nothing secret crosses one either.** Decryption happens inside
 *   `executeRun` and the plaintext dies with it; what comes back has already
 *   been through the scrubber.
 *
 * The distinction that shapes all of it: a **script failure is a result, not an
 * error**. A failing assertion returns normally, so Workflows never retries the
 * browser dance over something that would fail identically the second time.
 * Only a browser that would not start throws.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { NonRetryableError } from 'cloudflare:workflows'

import { createDb } from '#/db/index.ts'
import type { ArtifactKeys, RunStatus } from '#/db/schema/app.ts'
import {
  attempt,
  environment,
  environmentVariable,
  intent,
  project,
  run,
  scriptVersion,
} from '#/db/schema/app.ts'
import type { RunEvent, RunOutcome, RunResult } from '#/engine/contract.ts'
import { artifactPrefix, writeArtifacts } from '#/engine/runner/artifacts.ts'
import { executeInDynamicWorker } from '#/engine/runner/loader.ts'
import { createScrubber } from '#/engine/runner/scrub.ts'
import { decryptSecret } from '#/server/crypto.ts'

/** Everything `execute` needs, and nothing that could not survive a JSON trip. */
export interface LoadedRun {
  intentId: string
  projectId: string
  environmentId: string
  scriptVersionId: string
  code: string
  baseUrl: string
  prefix: string
}

export interface ExecutedRun {
  result: RunResult
  artifactKeys: ArtifactKeys
}

/** One attempt per run until the healing loop appends more. */
const ATTEMPT_NUMBER = 1

/**
 * The retry policy for the one step that touches the outside world. Shared so a
 * member of a suite is executed on exactly the terms a standalone run is.
 */
export const EXECUTE_STEP_CONFIG = {
  retries: { limit: 1, delay: '5 seconds' },
  timeout: '10 minutes',
} as const

/** The safety net gets more attempts than the thing it is catching for. */
export const PERSIST_ERROR_STEP_CONFIG = {
  retries: { limit: 2, delay: '2 seconds' },
} as const

/**
 * The browser never came up. Distinct from every other failure because it is
 * the only one a retry can plausibly fix — a `429` from Browser Rendering, or a
 * session that vanished — so it is the only one allowed to escape `executeRun`.
 */
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

/**
 * Resolves the run to the exact bytes that will execute, and claims it.
 *
 * Everything is re-read through the organization the caller was in, so a run
 * row that was somehow retargeted between enqueue and execution resolves to
 * nothing rather than to another tenant's project.
 */
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
    // Retrying cannot conjure a run row; fail the instance immediately.
    throw new NonRetryableError(`Run ${runId} does not exist in this organization.`)
  }

  const prefix = artifactPrefix({ organizationId, projectId: row.projectId, runId })

  await db
    .update(run)
    .set({ status: 'running', artifactPrefix: prefix, workflowInstanceId: runId })
    .where(eq(run.id, runId))

  await announceRun(env, runId, { type: 'run.started', runId, at: Date.now() })

  return {
    intentId: row.run.intentId,
    projectId: row.projectId,
    environmentId: row.run.environmentId,
    scriptVersionId: row.run.scriptVersionId,
    code: row.scriptVersion.code,
    baseUrl: row.environment.baseUrl,
    prefix,
  }
}

/**
 * Runs the script in a Dynamic Worker and files what it produced.
 *
 * Throws only for a browser that would not start — the one failure a retry
 * can fix. A broken script, a failed assertion or a timeout all return
 * normally, carrying the outcome the UI will show.
 */
export async function executeRun(
  env: Cloudflare.Env,
  runId: string,
  loaded: LoadedRun,
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
      // A rotated ENCRYPTION_KEY should read as a missing variable, which the
      // script reports by name, rather than as an opaque engine crash.
      undecryptable.push(row.name)
    }
  }

  // Applied on the way out as well as inside the harness: this is the last
  // point at which the plaintext still exists, and everything downstream —
  // including the Workflow's own step storage — is durable.
  const scrubber = createScrubber(Object.values(creds))

  let result: RunResult
  let screenshot: ArrayBuffer | null = null
  let trace: ArrayBuffer | null = null

  const startedAt = Date.now()

  try {
    const response = await executeInDynamicWorker({
      loader: env.LOADER,
      browser: env.BROWSER,
      runId,
      code: loaded.code,
      baseUrl: loaded.baseUrl,
      creds,
      // Obtained here rather than carried in from `load`: a stub is a live
      // connection, and Workflows serialises everything that crosses a step
      // boundary. It has to be fetched inside the step that uses it. Each
      // member of a suite therefore streams to its own run's channel.
      channel: env.RUN_CHANNEL.getByName(runId),
    })

    if (response.errorKind === 'browser') {
      throw new BrowserUnavailableError(
        response.result.errorMessage ?? 'The browser session could not be started.',
      )
    }

    result = response.result
    screenshot = response.screenshot
    trace = response.trace
  } catch (error) {
    if (error instanceof BrowserUnavailableError) throw error

    // Anything the isolate could not even start — a syntax error in the saved
    // script is the common one — arrives here as a module-graph failure.
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

  for (const failure of failures) scrubbed.logs.push(`[engine] artifact upload failed — ${failure}`)

  return { result: scrubbed, artifactKeys: keys }
}

/** The attempt row, the run's verdict and the intent's badge, in one batch. */
export async function persistRun(
  env: Cloudflare.Env,
  runId: string,
  loaded: LoadedRun,
  executed: ExecutedRun,
): Promise<{ runId: string; status: RunStatus }> {
  const db = createDb(env.DB)
  const status = OUTCOME_TO_RUN_STATUS[executed.result.outcome]

  // Every line of an error is indented, not just its first: the UI reads this
  // column back into steps, and a Playwright error runs to a dozen lines whose
  // second onwards would otherwise be indistinguishable from console output.
  const transcript = [
    ...executed.result.steps.map((step) => {
      const head = `${step.ok ? '✓' : '✘'} ${step.label} (${step.durationMs}ms)`
      if (!step.error) return head
      return [head, ...step.error.split('\n').map((line) => `    ${line}`)].join('\n')
    }),
    ...(executed.result.logs.length > 0 ? ['', ...executed.result.logs] : []),
  ].join('\n')

  await db.batch([
    // Deterministic id + do-nothing: `persist` is a retryable step, and the
    // `(runId, attemptNumber)` unique index would otherwise turn a retry into
    // a permanent failure.
    db
      .insert(attempt)
      .values({
        id: `att_${runId.replace(/^run_/, '')}_${ATTEMPT_NUMBER}`,
        runId,
        attemptNumber: ATTEMPT_NUMBER,
        outcome: executed.result.outcome,
        scriptVersionId: loaded.scriptVersionId,
        scriptUsed: loaded.code,
        artifactKeys: executed.artifactKeys,
        logs: transcript,
        errorMessage: executed.result.errorMessage,
        durationMs: executed.result.durationMs,
      })
      .onConflictDoNothing(),
    db.update(run).set({ status, finishedAt: new Date() }).where(eq(run.id, runId)),
    db
      .update(intent)
      .set({ status: status === 'passed' ? 'passing' : 'failing', lastRunId: runId })
      .where(eq(intent.id, loaded.intentId)),
  ])

  await announceRun(
    env,
    runId,
    {
      type: 'run.finished',
      runId,
      outcome: executed.result.outcome,
      errorMessage: executed.result.errorMessage,
      at: Date.now(),
    },
    { final: true },
  )

  return { runId, status }
}

/**
 * The safety net. Reached only when a step exhausted its retries, which means
 * the run has no attempt row and no verdict — without this it would show as
 * `running` for ever.
 */
export async function persistRunError(
  env: Cloudflare.Env,
  runId: string,
  error: unknown,
): Promise<void> {
  const db = createDb(env.DB)

  // Guarded on the non-terminal statuses so a late failure — an artifact
  // upload that threw after `persist` committed, say — cannot rewrite a
  // verdict the run already earned.
  await db
    .update(run)
    .set({ status: 'error', finishedAt: new Date() })
    .where(and(eq(run.id, runId), inArray(run.status, ['queued', 'running'])))

  console.error(`[run-steps] ${runId} failed:`, error)

  // Anyone watching gets the same verdict the database just recorded, rather
  // than a progress panel that spins for ever. The message is the engine's
  // own — it never quotes the script, so there is nothing here to scrub.
  await announceRun(
    env,
    runId,
    {
      type: 'run.finished',
      runId,
      outcome: 'error',
      errorMessage: 'The run could not be completed.',
      at: Date.now(),
    },
    { final: true },
  )
}

/**
 * Tells the run's channel what just happened, and never lets that matter.
 *
 * The stub is resolved per call for the same reason `executeRun` resolves its
 * own: stubs do not survive a step boundary. `final` schedules the channel's
 * own cleanup, so a finished run stops costing storage a quarter of an hour
 * after the last person could plausibly want to watch it.
 */
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
