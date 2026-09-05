import { enqueueWork } from './enqueue.ts'
import { isRunnableIntent } from './test-policy.ts'
/** Callers must validate input and authorize the organization before invoking these shared actions. */
import { env } from 'cloudflare:workers'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import type { GenerationJobKind, IntentStatus, RunTrigger, SuiteTrigger } from '#/db/schema/app.ts'
import {
  environment,
  environmentVariable,
  generationJob,
  intent,
  project,
  run,
  scriptVersion,
  suiteRun,
} from '#/db/schema/app.ts'
import { createId } from '#/lib/ids.ts'
import { encryptSecret, maskSecret } from './crypto.ts'
import { loadDefaultEnvironment } from './scope.ts'
import { ValidationError } from './validate.ts'

export { isAdoptedIntent, isRunnableIntent } from './test-policy.ts'
export type TargetEnvironment = typeof environment.$inferSelect

export function assertVariableName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new ValidationError(
      'A variable name must start with a letter or underscore and contain only letters, numbers and underscores.',
    )
  }
  return value
}

export async function resolveTargetEnvironment(
  db: Db,
  projectId: string,
  candidate: TargetEnvironment | null,
  purpose: string,
): Promise<TargetEnvironment> {
  const target = candidate ?? (await loadDefaultEnvironment(db, projectId))

  if (!target) {
    throw new ValidationError(`This project has no environment to ${purpose} against.`)
  }
  if (target.projectId !== projectId) {
    throw new ValidationError('That environment belongs to a different project.')
  }

  return target
}

export async function loadCurrentVersion(db: Db, currentVersionId: string | null) {
  if (!currentVersionId) return null

  const [row] = await db
    .select()
    .from(scriptVersion)
    .where(eq(scriptVersion.id, currentVersionId))
    .limit(1)

  return row ?? null
}

export { appendScriptVersion } from './script-records.ts'

export async function createIntentRecord(
  db: Db,
  input: {
    projectId: string
    title: string
    description: string
    createdBy: string
    status?: IntentStatus
  },
) {
  const status = input.status ?? 'draft'

  const row = {
    id: createId('int'),
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    status,
    createdBy: input.createdBy,
  }

  await db.insert(intent).values(row)
  return { id: row.id, title: row.title, status }
}

export async function adoptProposedIntents(
  db: Db,
  projectId: string,
  intentIds: Array<string>,
): Promise<number> {
  if (intentIds.length === 0) return 0

  const adopted = await db
    .update(intent)
    .set({ status: 'draft' })
    .where(
      and(
        eq(intent.projectId, projectId),
        inArray(intent.id, intentIds),
        eq(intent.status, 'proposed'),
      ),
    )
    .returning({ id: intent.id })

  return adopted.length
}

export async function updateIntentRecord(
  db: Db,
  input: {
    intentId: string
    title?: string | undefined
    description?: string | undefined
    schedule?: string | null | undefined
  },
) {
  const patch = {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined
      ? {}
      : {
          description: input.description,
          readiness: 'draft' as const,
          status: sql`case when ${intent.status} = 'proposed' then 'proposed' else 'draft' end`,
          lastRunId: null,
        }),
    ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
  }

  if (Object.keys(patch).length === 0) return { changed: false as const }

  await db.update(intent).set(patch).where(eq(intent.id, input.intentId))
  return { changed: true as const }
}

export async function deleteIntentRecord(db: Db, intentId: string) {
  await db.delete(intent).where(eq(intent.id, intentId))
  return { ok: true as const }
}

export async function queueIntentRun(
  db: Db,
  input: {
    intentId: string
    projectId: string
    organizationId: string
    environment: TargetEnvironment
    scriptVersionId: string
    runId?: string
    trigger?: RunTrigger
    webhookApiKeyId?: string
    webhookApiKeyName?: string
  },
) {
  const [test] = await db.select().from(intent).where(eq(intent.id, input.intentId)).limit(1)
  const purpose =
    test?.readiness === 'ready' && test.currentVersionId === input.scriptVersionId
      ? ('regression' as const)
      : ('draft-check' as const)
  const row = {
    id: input.runId ?? createId('run'),
    intentId: input.intentId,
    environmentId: input.environment.id,
    projectId: input.projectId,
    scriptVersionId: input.scriptVersionId,
    purpose,
    environmentName: input.environment.name,
    baseUrl: input.environment.baseUrl,
    status: 'queued' as const,
    trigger: input.trigger ?? ('manual' as const),
    webhookApiKeyId: input.webhookApiKeyId,
    webhookApiKeyName: input.webhookApiKeyName,
    startedAt: new Date(),
  }

  await db.insert(run).values(row).onConflictDoNothing()

  await enqueueWork(
    () =>
      env.RUN_WORKFLOW.create({
        id: row.id,
        params: { runId: row.id, organizationId: input.organizationId },
      }),
    async () => (await env.RUN_WORKFLOW.get(row.id)).status(),
    () =>
      db
        .update(run)
        .set({
          status: 'error',
          errorMessage: 'The run could not be started. Please try again.',
          finishedAt: new Date(),
        })
        .where(and(eq(run.id, row.id), eq(run.status, 'queued'))),
  )

  return { runId: row.id, environmentId: input.environment.id, status: row.status }
}

export async function assertNoGenerationInFlight(db: Db, intentId: string, status: IntentStatus) {
  if (status === 'generating') {
    throw new ValidationError('A script is already being generated for this test.')
  }

  const [inFlight] = await db
    .select({ id: generationJob.id })
    .from(generationJob)
    .where(
      and(
        eq(generationJob.intentId, intentId),
        inArray(generationJob.status, ['queued', 'running']),
      ),
    )
    .limit(1)

  if (inFlight) {
    throw new ValidationError('A script is already being generated for this test.')
  }
}

export async function queueGeneration(
  db: Db,
  input: {
    intentId: string
    projectId: string
    organizationId: string
    environment: TargetEnvironment
    createdBy: string
  },
) {
  const row = {
    id: createId('gen'),
    kind: 'generate' as GenerationJobKind,
    intentId: input.intentId,
    projectId: input.projectId,
    environmentId: input.environment.id,
    organizationId: input.organizationId,
    status: 'queued' as const,
    createdBy: input.createdBy,
  }

  await db.insert(generationJob).values(row)

  await enqueueWork(
    () =>
      env.GENERATE_WORKFLOW.create({
        id: row.id,
        params: {
          jobId: row.id,
          intentId: input.intentId,
          environmentId: input.environment.id,
          organizationId: input.organizationId,
          userId: input.createdBy,
        },
      }),
    async () => (await env.GENERATE_WORKFLOW.get(row.id)).status(),
    () =>
      db
        .update(generationJob)
        .set({
          status: 'failed',
          stuckReason: 'The job could not be started. Please try again.',
          finishedAt: new Date(),
        })
        .where(and(eq(generationJob.id, row.id), eq(generationJob.status, 'queued'))),
  )

  return { jobId: row.id, environmentId: input.environment.id }
}

export async function assertNoRepairInFlight(db: Db, intentId: string): Promise<void> {
  const [inFlight] = await db
    .select({ id: generationJob.id, kind: generationJob.kind })
    .from(generationJob)
    .where(
      and(
        eq(generationJob.intentId, intentId),
        inArray(generationJob.status, ['queued', 'running']),
      ),
    )
    .limit(1)

  if (inFlight) {
    throw new ValidationError(
      inFlight.kind === 'repair'
        ? 'A repair is already running for this test.'
        : 'A script is already being generated for this test. Wait for it to finish.',
    )
  }
}

/** Starts the agent that tries to fix a failed run's script. The heal policy decides what happens to the result. */
export async function queueRepair(
  db: Db,
  input: {
    runId: string
    intentId: string
    projectId: string
    environmentId: string
    organizationId: string
    createdBy: string
  },
) {
  await assertNoRepairInFlight(db, input.intentId)

  const row = {
    id: createId('rep'),
    kind: 'repair' as GenerationJobKind,
    intentId: input.intentId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    organizationId: input.organizationId,
    sourceRunId: input.runId,
    status: 'queued' as const,
    createdBy: input.createdBy,
  }

  await db.insert(generationJob).values(row)

  await enqueueWork(
    () =>
      env.REPAIR_WORKFLOW.create({
        id: row.id,
        params: {
          jobId: row.id,
          intentId: input.intentId,
          organizationId: input.organizationId,
        },
      }),
    async () => (await env.REPAIR_WORKFLOW.get(row.id)).status(),
    () =>
      db
        .update(generationJob)
        .set({
          status: 'failed',
          stuckReason: 'The repair could not be started. Please try again.',
          finishedAt: new Date(),
        })
        .where(and(eq(generationJob.id, row.id), eq(generationJob.status, 'queued'))),
  )

  return { jobId: row.id }
}

export const MAX_PROJECT_CONTEXT_CHARS = 4000

/** Callers must redact project context before persisting it. */
export async function setProjectContextRecord(
  db: Db,
  projectId: string,
  text: string | null,
): Promise<{ length: number }> {
  const value = text === null ? null : text.slice(0, MAX_PROJECT_CONTEXT_CHARS)

  await db.update(project).set({ context: value }).where(eq(project.id, projectId))
  return { length: value?.length ?? 0 }
}

export async function appendProjectContext(
  db: Db,
  projectId: string,
  section: string,
): Promise<{ length: number }> {
  const [row] = await db
    .select({ context: project.context })
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1)

  const existing = row?.context?.trim() ?? ''
  const merged = existing.length > 0 ? `${existing}\n\n${section.trim()}` : section.trim()

  const trimmed =
    merged.length <= MAX_PROJECT_CONTEXT_CHARS
      ? merged
      : merged.slice(merged.length - MAX_PROJECT_CONTEXT_CHARS).replace(/^[^\n]*\n/, '')

  return setProjectContextRecord(db, projectId, trimmed)
}

export async function assertNoExplorationInFlight(db: Db, projectId: string): Promise<void> {
  const [inFlight] = await db
    .select({ id: generationJob.id })
    .from(generationJob)
    .where(
      and(
        eq(generationJob.projectId, projectId),
        eq(generationJob.kind, 'explore'),
        inArray(generationJob.status, ['queued', 'running']),
      ),
    )
    .limit(1)

  if (inFlight) {
    throw new ValidationError('This project is already being explored. Wait for that to finish.')
  }
}

export async function queueExploration(
  db: Db,
  input: {
    projectId: string
    organizationId: string
    environment: TargetEnvironment
    createdBy: string
    focus: string | null
    autoGenerate?: boolean
  },
) {
  await assertNoExplorationInFlight(db, input.projectId)

  const row = {
    id: createId('exp'),
    kind: 'explore' as const,
    projectId: input.projectId,
    environmentId: input.environment.id,
    organizationId: input.organizationId,
    status: 'queued' as const,
    createdBy: input.createdBy,
  }

  await db.insert(generationJob).values(row)

  await enqueueWork(
    () =>
      env.EXPLORE_WORKFLOW.create({
        id: row.id,
        params: {
          jobId: row.id,
          projectId: input.projectId,
          environmentId: input.environment.id,
          organizationId: input.organizationId,
          userId: input.createdBy,
          focus: input.focus,
          autoGenerate: input.autoGenerate === true,
        },
      }),
    async () => (await env.EXPLORE_WORKFLOW.get(row.id)).status(),
    () =>
      db
        .update(generationJob)
        .set({
          status: 'failed',
          stuckReason: 'The job could not be started. Please try again.',
          finishedAt: new Date(),
        })
        .where(and(eq(generationJob.id, row.id), eq(generationJob.status, 'queued'))),
  )

  return { jobId: row.id, environmentId: input.environment.id }
}

/** Keep batch size within the Workflow step limit; each generation consumes multiple steps. */
export const MAX_BATCH_INTENTS = 15

export async function queueBatchGeneration(
  db: Db,
  input: {
    projectId: string
    organizationId: string
    environment: TargetEnvironment
    createdBy: string
    intentIds: Array<string>
  },
) {
  if (input.intentIds.length === 0) {
    throw new ValidationError('Choose at least one test to generate.')
  }
  if (input.intentIds.length > MAX_BATCH_INTENTS) {
    throw new ValidationError(
      `That is ${input.intentIds.length} tests; generate at most ${MAX_BATCH_INTENTS} at a time.`,
    )
  }

  const members = await db
    .select({ id: intent.id, title: intent.title, status: intent.status })
    .from(intent)
    .where(and(eq(intent.projectId, input.projectId), inArray(intent.id, input.intentIds)))

  if (members.length === 0) {
    throw new ValidationError('None of those tests exist in this project.')
  }

  const busy = members.find((member) => member.status === 'generating')
  if (busy) {
    throw new ValidationError(`A script is already being generated for “${busy.title}”.`)
  }

  await adoptProposedIntents(
    db,
    input.projectId,
    members.map((member) => member.id),
  )

  const row = {
    id: createId('bat'),
    kind: 'batch' as const,
    projectId: input.projectId,
    environmentId: input.environment.id,
    organizationId: input.organizationId,
    status: 'queued' as const,
    createdBy: input.createdBy,
  }

  await db.insert(generationJob).values(row)

  await enqueueWork(
    () =>
      env.BATCH_WORKFLOW.create({
        id: row.id,
        params: {
          jobId: row.id,
          environmentId: input.environment.id,
          organizationId: input.organizationId,
          userId: input.createdBy,
          intentIds: members.map((member) => member.id),
        },
      }),
    async () => (await env.BATCH_WORKFLOW.get(row.id)).status(),
    () =>
      db
        .update(generationJob)
        .set({
          status: 'failed',
          stuckReason: 'The job could not be started. Please try again.',
          finishedAt: new Date(),
        })
        .where(and(eq(generationJob.id, row.id), eq(generationJob.status, 'queued'))),
  )

  return {
    jobId: row.id,
    environmentId: input.environment.id,
    intentIds: members.map((member) => member.id),
    total: members.length,
  }
}

export async function countRunnableIntents(db: Db, projectId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(intent)
    .where(and(eq(intent.projectId, projectId), isRunnableIntent))

  return Number(row?.count ?? 0)
}

export async function queueSuiteRun(
  db: Db,
  input: {
    projectId: string
    organizationId: string
    environment: TargetEnvironment
    createdBy: string | null
    suiteRunId?: string
    trigger?: SuiteTrigger
    intentIds?: Array<string>
    webhookApiKeyId?: string
    webhookApiKeyName?: string
  },
) {
  const runnable = input.intentIds?.length ?? (await countRunnableIntents(db, input.projectId))
  if (runnable === 0) {
    throw new ValidationError(
      'Mark at least one saved test ready before running a suite. Draft checks are excluded.',
    )
  }

  const row = {
    id: input.suiteRunId ?? createId('srun'),
    projectId: input.projectId,
    environmentId: input.environment.id,
    environmentName: input.environment.name,
    baseUrl: input.environment.baseUrl,
    status: 'queued' as const,
    trigger: input.trigger ?? ('manual' as const),
    createdBy: input.createdBy,
    webhookApiKeyId: input.webhookApiKeyId,
    webhookApiKeyName: input.webhookApiKeyName,
    startedAt: new Date(),
  }

  await db.insert(suiteRun).values(row).onConflictDoNothing()

  await enqueueWork(
    () =>
      env.SUITE_WORKFLOW.create({
        id: row.id,
        params: {
          suiteRunId: row.id,
          organizationId: input.organizationId,
          intentIds: input.intentIds,
        },
      }),
    async () => (await env.SUITE_WORKFLOW.get(row.id)).status(),
    () =>
      db
        .update(suiteRun)
        .set({
          status: 'error',
          errorMessage: 'The suite could not be started. Please try again.',
          finishedAt: new Date(),
        })
        .where(and(eq(suiteRun.id, row.id), eq(suiteRun.status, 'queued'))),
  )

  return { suiteRunId: row.id, environmentId: input.environment.id, total: runnable }
}

function clearDefaults(db: Db, projectId: string, keepId: string) {
  return db
    .update(environment)
    .set({ isDefault: false })
    .where(and(eq(environment.projectId, projectId), ne(environment.id, keepId)))
}

export async function createEnvironmentRecord(
  db: Db,
  input: {
    projectId: string
    name: string
    baseUrl: string
    isDefault: boolean
    createdBy: string
  },
) {
  const siblings = await db
    .select({ id: environment.id })
    .from(environment)
    .where(eq(environment.projectId, input.projectId))

  const isDefault = siblings.length === 0 || input.isDefault

  const row = {
    id: createId('env'),
    projectId: input.projectId,
    name: input.name,
    baseUrl: input.baseUrl,
    isDefault,
    createdBy: input.createdBy,
  }

  if (isDefault && siblings.length > 0) {
    await db.batch([db.insert(environment).values(row), clearDefaults(db, input.projectId, row.id)])
  } else {
    await db.insert(environment).values(row)
  }

  return { id: row.id, name: row.name, baseUrl: row.baseUrl, isDefault }
}

export async function updateEnvironmentRecord(
  db: Db,
  input: { environmentId: string; name?: string | undefined; baseUrl?: string | undefined },
) {
  const patch = {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
  }

  if (Object.keys(patch).length === 0) return { changed: false as const }

  await db.update(environment).set(patch).where(eq(environment.id, input.environmentId))
  return { changed: true as const }
}

export async function setEnvironmentVariableRecord(
  db: Db,
  input: { environmentId: string; name: string; value: string },
) {
  const encryptedValue = await encryptSecret(input.value)

  const [row] = await db
    .insert(environmentVariable)
    .values({
      id: createId('evar'),
      environmentId: input.environmentId,
      name: input.name,
      encryptedValue,
    })
    .onConflictDoUpdate({
      target: [environmentVariable.environmentId, environmentVariable.name],
      set: { encryptedValue, updatedAt: new Date() },
    })
    .returning({ id: environmentVariable.id })

  return { id: row!.id, name: input.name, hint: maskSecret(input.value) }
}
