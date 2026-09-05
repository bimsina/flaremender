import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { NonRetryableError } from 'cloudflare:workflows'

import { createDb } from '#/db/index.ts'
import type { IntentStatus } from '#/db/schema/app.ts'
import { environment, generationJob, intent, project, run, scriptVersion } from '#/db/schema/app.ts'
import type { RunOutcome } from '#/engine/contract.ts'
import { loadCredentialNames } from '#/engine/generation/loop.ts'
import type { ExecutedRun, LoadedRun } from '#/engine/run-steps.ts'
import { announceRun, persistRun } from '#/engine/run-steps.ts'

export interface LoadedGeneration {
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
  currentScript: string | null
  previousVersionId: string | null
  previousStatus: IntentStatus
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface PreparedVerification {
  versionId: string
  version: number
  runId: string
}

function derivedId(prefix: string, jobId: string): string {
  return `${prefix}_${jobId.replace(/^gen_/, '')}`
}

export async function loadGeneration(
  env: Cloudflare.Env,
  params: { jobId: string; organizationId: string },
): Promise<LoadedGeneration> {
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
        eq(project.organizationId, params.organizationId),
        eq(generationJob.organizationId, params.organizationId),
      ),
    )
    .limit(1)

  if (!row) {
    throw new NonRetryableError(
      `Generation job ${params.jobId} does not exist in this organization.`,
    )
  }

  const currentScript = row.intent.currentVersionId
    ? ((
        await db
          .select({ code: scriptVersion.code })
          .from(scriptVersion)
          .where(eq(scriptVersion.id, row.intent.currentVersionId))
          .limit(1)
      )[0]?.code ?? null)
    : null

  const previousStatus: IntentStatus =
    row.intent.status === 'generating' ? 'draft' : row.intent.status

  await db.batch([
    db.update(intent).set({ status: 'generating' }).where(eq(intent.id, row.intent.id)),
    db.update(generationJob).set({ status: 'running' }).where(eq(generationJob.id, params.jobId)),
  ])

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
    currentScript,
    previousVersionId: row.intent.currentVersionId,
    previousStatus,
  }
}

export async function prepareVerification(
  env: Cloudflare.Env,
  loaded: LoadedGeneration,
  input: { code: string; note: string; modelId: string | null },
): Promise<PreparedVerification> {
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
      trigger: 'regenerate',
      purpose: 'generation-verification',
      environmentName: loaded.environmentName,
      baseUrl: loaded.baseUrl,
      modelId: input.modelId,
      startedAt: new Date(),
    })
    .onConflictDoNothing()

  await announceRun(env, loaded.jobId, {
    type: 'log',
    runId: loaded.jobId,
    line: `Verifying the assembled script in a fresh browser session (${runId}).`,
    at: Date.now(),
  })

  return { versionId, version, runId }
}

export async function persistGeneration(
  env: Cloudflare.Env,
  loaded: LoadedGeneration,
  context: {
    prepared: PreparedVerification
    loadedRun: LoadedRun
    executed: ExecutedRun
    modelId: string | null
    turns: number
    usage: TokenUsage
    stuckReason: string | null
  },
): Promise<{ outcome: RunOutcome; versionId: string; runId: string }> {
  const db = createDb(env.DB)
  const outcome = context.executed.result.outcome

  const green = outcome === 'passed' && context.stuckReason === null

  await persistRun(env, context.prepared.runId, context.loadedRun, context.executed)

  const keepNewVersion = context.stuckReason === null || loaded.previousVersionId === null

  // Only a script that replayed green in a fresh session is ready. Every fragment ran
  // live while it was written, so a failed replay means the assembled script is not a
  // faithful reproduction, not that the app is broken.
  await db
    .update(intent)
    .set({
      currentVersionId: keepNewVersion ? context.prepared.versionId : loaded.previousVersionId,
      readiness: keepNewVersion ? (green ? 'ready' : 'draft') : undefined,
      lastRunId: keepNewVersion ? null : undefined,
      status: keepNewVersion ? (green ? 'ready' : 'draft') : loaded.previousStatus,
    })
    .where(
      and(
        eq(intent.id, loaded.intentId),
        or(
          loaded.previousVersionId
            ? eq(intent.currentVersionId, loaded.previousVersionId)
            : isNull(intent.currentVersionId),
          eq(intent.currentVersionId, context.prepared.versionId),
        ),
      ),
    )

  const reason = green
    ? null
    : (context.stuckReason ??
      context.executed.result.errorMessage?.split('\n')[0] ??
      'The generated script did not pass verification.')

  await db
    .update(generationJob)
    .set({
      status: green ? 'succeeded' : 'failed',
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
      outcome: green ? 'passed' : outcome === 'passed' ? 'failed' : outcome,
      errorMessage: reason,
      at: Date.now(),
    },
    { final: true },
  )

  return {
    outcome: green ? 'passed' : outcome === 'passed' ? 'failed' : outcome,
    versionId: context.prepared.versionId,
    runId: context.prepared.runId,
  }
}

export async function abandonGeneration(
  env: Cloudflare.Env,
  loaded: LoadedGeneration,
  context: { reason: string; turns: number; modelId: string | null; usage?: TokenUsage },
): Promise<void> {
  const db = createDb(env.DB)

  await db.batch([
    db.update(intent).set({ status: loaded.previousStatus }).where(eq(intent.id, loaded.intentId)),
    db
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
      .where(eq(generationJob.id, loaded.jobId)),
  ])

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

export async function failGeneration(
  env: Cloudflare.Env,
  params: { jobId: string; intentId: string },
  error: unknown,
): Promise<void> {
  const db = createDb(env.DB)

  await db
    .update(generationJob)
    .set({
      status: 'failed',
      stuckReason: 'The generation could not be completed.',
      finishedAt: new Date(),
    })
    .where(
      and(eq(generationJob.id, params.jobId), inArray(generationJob.status, ['queued', 'running'])),
    )

  const [row] = await db
    .select({ readiness: intent.readiness })
    .from(intent)
    .where(eq(intent.id, params.intentId))
    .limit(1)

  await db
    .update(intent)
    .set({ status: row?.readiness === 'ready' ? 'ready' : 'draft' })
    .where(and(eq(intent.id, params.intentId), eq(intent.status, 'generating')))

  console.error(`[generation] ${params.jobId} failed:`, error)

  await announceRun(
    env,
    params.jobId,
    {
      type: 'run.finished',
      runId: params.jobId,
      outcome: 'error',
      errorMessage: 'The generation could not be completed.',
      at: Date.now(),
    },
    { final: true },
  )
}
