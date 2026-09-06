import { and, desc, eq, inArray } from 'drizzle-orm'
import { NonRetryableError } from 'cloudflare:workflows'

import { createDb } from '#/db/index.ts'
import type { HealApplied, HealPolicy } from '#/db/schema/app.ts'
import {
  attempt,
  environment,
  generationJob,
  intent,
  project,
  run,
  scriptVersion,
} from '#/db/schema/app.ts'
import type { PageObservation, RunOutcome } from '#/engine/contract.ts'
import { loadCredentialNames, loadCredentials } from '#/engine/generation/loop.ts'
import { formatObservation } from '#/engine/generation/prompts.ts'
import { wrapFragment } from '#/engine/generation/script.ts'
import type { TokenUsage } from '#/engine/generation/steps.ts'
import { splitStatements } from '#/engine/repair/statements.ts'
import type { ExecutedRun, LoadedRun } from '#/engine/run-steps.ts'
import { announceRun, persistRun } from '#/engine/run-steps.ts'
import { actInDynamicWorker } from '#/engine/runner/loader.ts'
import { resolveHealPolicy } from '#/server/runs/heal-policy.ts'

export interface LoadedRepair {
  jobId: string
  intentId: string
  projectId: string
  environmentId: string
  organizationId: string
  userId: string
  projectName: string
  projectContext: string | null
  projectModelId: string | null
  environmentName: string
  baseUrl: string
  intentTitle: string
  intentDescription: string
  credentialNames: Array<string>
  sourceRunId: string
  sourceVersionId: string
  sourceVersion: number
  code: string
  /** What the failed run recorded, for the prompt. */
  sourceError: string | null
}

export interface ReplayResult {
  prefix: Array<string>
  failing: { statement: string; error: string; index: number } | null
  remaining: Array<string>
  pageAtFailure: string | null
  stepIndexOffset: number
  fatal: string | null
}

export interface PreparedRepairVerification {
  versionId: string
  version: number
  runId: string
}

function derivedId(prefix: string, jobId: string): string {
  return `${prefix}_${jobId.replace(/^rep_/, '')}`
}

export async function loadRepair(
  env: Cloudflare.Env,
  params: { jobId: string; organizationId: string },
): Promise<LoadedRepair> {
  const db = createDb(env.DB)

  const [row] = await db
    .select({ job: generationJob, intent, project, environment })
    .from(generationJob)
    .innerJoin(intent, eq(intent.id, generationJob.intentId))
    .innerJoin(project, eq(project.id, generationJob.projectId))
    .innerJoin(environment, eq(environment.id, generationJob.environmentId))
    .where(
      and(
        eq(generationJob.id, params.jobId),
        eq(generationJob.kind, 'repair'),
        eq(project.organizationId, params.organizationId),
        eq(generationJob.organizationId, params.organizationId),
      ),
    )
    .limit(1)

  if (!row || !row.job.sourceRunId) {
    throw new NonRetryableError(`Repair job ${params.jobId} does not exist in this organization.`)
  }

  const [source] = await db
    .select({ run, version: scriptVersion })
    .from(run)
    .innerJoin(scriptVersion, eq(scriptVersion.id, run.scriptVersionId))
    .where(and(eq(run.id, row.job.sourceRunId), eq(run.intentId, row.intent.id)))
    .limit(1)

  if (!source) {
    throw new NonRetryableError(`Repair job ${params.jobId} points at a run that no longer exists.`)
  }

  const [lastAttempt] = await db
    .select({ errorMessage: attempt.errorMessage })
    .from(attempt)
    .where(eq(attempt.runId, source.run.id))
    .orderBy(desc(attempt.attemptNumber))
    .limit(1)

  await db
    .update(generationJob)
    .set({ status: 'running' })
    .where(eq(generationJob.id, params.jobId))

  await announceRun(env, params.jobId, {
    type: 'run.started',
    runId: params.jobId,
    at: Date.now(),
  })

  return {
    jobId: params.jobId,
    intentId: row.intent.id,
    projectId: row.project.id,
    environmentId: row.environment.id,
    organizationId: params.organizationId,
    userId: row.job.createdBy,
    projectName: row.project.name,
    projectContext: row.project.context,
    projectModelId: row.project.modelId,
    environmentName: row.environment.name,
    baseUrl: row.environment.baseUrl,
    intentTitle: row.intent.title,
    intentDescription: row.intent.description,
    credentialNames: await loadCredentialNames(env, row.environment.id),
    sourceRunId: source.run.id,
    sourceVersionId: source.version.id,
    sourceVersion: source.version.version,
    code: source.version.code,
    sourceError: lastAttempt?.errorMessage ?? source.run.errorMessage,
  }
}

/**
 * Runs the old script one statement at a time in the repair's browser session and
 * stops at the first one that fails. What passed is the prefix the agent builds on.
 */
export async function replayScript(
  env: Cloudflare.Env,
  loaded: LoadedRepair,
  sessionId: string,
): Promise<ReplayResult> {
  const statements = splitStatements(loaded.code)
  const creds = await loadCredentials(env, loaded.environmentId)

  const prefix: Array<string> = []
  let stepIndexOffset = 0
  let lastObservation: PageObservation | null = null

  await announceRun(env, loaded.jobId, {
    type: 'log',
    runId: loaded.jobId,
    line: `Replaying version ${loaded.sourceVersion} statement by statement to find where it breaks.`,
    at: Date.now(),
  })

  for (const [index, statement] of statements.entries()) {
    const response = await actInDynamicWorker({
      loader: env.LOADER,
      browser: env.BROWSER,
      baseUrl: loaded.baseUrl,
      creds,
      sessionId,
      code: wrapFragment(statement),
      channel: env.RUN_CHANNEL.getByName(loaded.jobId),
      jobId: loaded.jobId,
      stepIndexOffset,
    })

    stepIndexOffset += response.steps.length
    lastObservation = response.observation

    if (response.sessionLost) {
      return {
        prefix,
        failing: null,
        remaining: statements.slice(index),
        pageAtFailure: null,
        stepIndexOffset,
        fatal: 'The browser session was lost while replaying the script.',
      }
    }

    if (!response.ok) {
      return {
        prefix,
        failing: {
          statement,
          error: response.errorMessage ?? 'The statement failed.',
          index,
        },
        remaining: statements.slice(index + 1),
        pageAtFailure: response.observation ? formatObservation(response.observation) : null,
        stepIndexOffset,
        fatal: null,
      }
    }

    prefix.push(statement)
  }

  return {
    prefix,
    failing: null,
    remaining: [],
    pageAtFailure: lastObservation ? formatObservation(lastObservation) : null,
    stepIndexOffset,
    fatal: null,
  }
}

export async function prepareRepairVerification(
  env: Cloudflare.Env,
  loaded: LoadedRepair,
  input: { code: string; note: string; modelId: string | null },
): Promise<PreparedRepairVerification> {
  const db = createDb(env.DB)

  const versionId = derivedId('sv', loaded.jobId)
  const runId = derivedId('run', loaded.jobId)

  const [existing] = await db
    .select({ version: scriptVersion.version })
    .from(scriptVersion)
    .where(eq(scriptVersion.id, versionId))
    .limit(1)

  let version = existing?.version ?? 0

  if (!existing) {
    const [last] = await db
      .select({ version: scriptVersion.version })
      .from(scriptVersion)
      .where(eq(scriptVersion.intentId, loaded.intentId))
      .orderBy(desc(scriptVersion.version))
      .limit(1)

    version = (last?.version ?? 0) + 1

    await db
      .insert(scriptVersion)
      .values({
        id: versionId,
        intentId: loaded.intentId,
        version,
        code: input.code,
        author: 'agent',
        createdBy: loaded.userId,
        note: input.note,
      })
      .onConflictDoNothing()
  }

  await db
    .insert(run)
    .values({
      id: runId,
      intentId: loaded.intentId,
      environmentId: loaded.environmentId,
      projectId: loaded.projectId,
      scriptVersionId: versionId,
      status: 'queued',
      trigger: 'repair',
      purpose: 'repair-verification',
      environmentName: loaded.environmentName,
      baseUrl: loaded.baseUrl,
      modelId: input.modelId,
      startedAt: new Date(),
    })
    .onConflictDoNothing()

  await announceRun(env, loaded.jobId, {
    type: 'log',
    runId: loaded.jobId,
    line: `Verifying the repaired script in a fresh browser session (${runId}).`,
    at: Date.now(),
  })

  return { versionId, version, runId }
}

export interface RepairVerdict {
  outcome: RunOutcome
  versionId: string
  version: number
  runId: string
  adopted: boolean
  policy: HealPolicy
}

/**
 * Applies the effective heal policy to a verified repair. `auto` adopts the new
 * version and marks the failed run healed; anything else parks it as a pending
 * repair for a person to accept. A repair that did not verify is kept as a version
 * for inspection but never pointed at.
 */
export async function persistRepair(
  env: Cloudflare.Env,
  loaded: LoadedRepair,
  context: {
    prepared: PreparedRepairVerification
    loadedRun: LoadedRun
    executed: ExecutedRun
    modelId: string | null
    turns: number
    usage: TokenUsage
    whatFailed: string
    stuckReason: string | null
  },
): Promise<RepairVerdict> {
  const db = createDb(env.DB)
  const outcome = context.executed.result.outcome

  await persistRun(env, context.prepared.runId, context.loadedRun, context.executed)

  const verified = outcome === 'passed' && context.stuckReason === null
  const policy = (await resolveHealPolicy(db, loaded.intentId)).effective
  const adopt = verified && policy === 'auto'

  if (verified) {
    if (adopt) {
      // Only swap the current version if nobody changed it while the repair ran.
      await db
        .update(intent)
        .set({
          currentVersionId: context.prepared.versionId,
          readiness: 'ready',
          status: 'ready',
          lastRunId: null,
          pendingRepairVersionId: null,
        })
        .where(
          and(eq(intent.id, loaded.intentId), eq(intent.currentVersionId, loaded.sourceVersionId)),
        )

      await db
        .update(run)
        .set({ status: 'healed' })
        .where(and(eq(run.id, loaded.sourceRunId), eq(run.status, 'failed')))
    } else {
      await db
        .update(intent)
        .set({ pendingRepairVersionId: context.prepared.versionId })
        .where(eq(intent.id, loaded.intentId))
    }

    const healApplied: HealApplied = {
      jobId: loaded.jobId,
      versionId: context.prepared.versionId,
      version: context.prepared.version,
      whatFailed: context.whatFailed,
      adopted: adopt,
      policy,
    }

    const [lastAttempt] = await db
      .select({ id: attempt.id })
      .from(attempt)
      .where(eq(attempt.runId, loaded.sourceRunId))
      .orderBy(desc(attempt.attemptNumber))
      .limit(1)

    if (lastAttempt) {
      await db.update(attempt).set({ healApplied }).where(eq(attempt.id, lastAttempt.id))
    }
  }

  const reason = verified
    ? null
    : (context.stuckReason ??
      context.executed.result.errorMessage?.split('\n')[0] ??
      'The repaired script did not pass verification.')

  await db
    .update(generationJob)
    .set({
      status: verified ? 'succeeded' : 'failed',
      modelId: context.modelId,
      scriptVersionId: context.prepared.versionId,
      runId: context.prepared.runId,
      turns: context.turns,
      inputTokens: context.usage.inputTokens,
      outputTokens: context.usage.outputTokens,
      stuckReason: reason,
      finishedAt: new Date(),
    })
    .where(eq(generationJob.id, loaded.jobId))

  await announceRun(
    env,
    loaded.jobId,
    {
      type: 'run.finished',
      runId: loaded.jobId,
      outcome: verified ? 'passed' : outcome === 'passed' ? 'failed' : outcome,
      errorMessage: reason,
      at: Date.now(),
    },
    { final: true },
  )

  return {
    outcome: verified ? 'passed' : outcome === 'passed' ? 'failed' : outcome,
    versionId: context.prepared.versionId,
    version: context.prepared.version,
    runId: context.prepared.runId,
    adopted: adopt,
    policy,
  }
}

export async function abandonRepair(
  env: Cloudflare.Env,
  loaded: LoadedRepair,
  context: { reason: string; turns: number; modelId: string | null; usage?: TokenUsage },
): Promise<void> {
  const db = createDb(env.DB)

  await db
    .update(generationJob)
    .set({
      status: 'failed',
      modelId: context.modelId,
      turns: context.turns,
      inputTokens: context.usage?.inputTokens ?? 0,
      outputTokens: context.usage?.outputTokens ?? 0,
      stuckReason: context.reason,
      finishedAt: new Date(),
    })
    .where(eq(generationJob.id, loaded.jobId))

  await announceRun(
    env,
    loaded.jobId,
    {
      type: 'run.finished',
      runId: loaded.jobId,
      outcome: 'failed',
      errorMessage: context.reason,
      at: Date.now(),
    },
    { final: true },
  )
}

export async function failRepair(
  env: Cloudflare.Env,
  jobId: string,
  error: unknown,
): Promise<void> {
  const db = createDb(env.DB)

  await db
    .update(generationJob)
    .set({
      status: 'failed',
      stuckReason: 'The repair could not be completed.',
      finishedAt: new Date(),
    })
    .where(and(eq(generationJob.id, jobId), inArray(generationJob.status, ['queued', 'running'])))

  console.error(`[repair] ${jobId} failed:`, error)

  await announceRun(
    env,
    jobId,
    {
      type: 'run.finished',
      runId: jobId,
      outcome: 'error',
      errorMessage: 'The repair could not be completed.',
      at: Date.now(),
    },
    { final: true },
  )
}
