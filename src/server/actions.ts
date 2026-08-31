import { enqueueWork } from './enqueue.ts'
import { isRunnableIntent } from './test-policy.ts'
/**
 * What the product *does*, with nobody in particular asking.
 *
 * Every one of these was, until the chat arrived, the body of a server
 * function. Now there are two callers — a request handler with a session, and a
 * tool call inside the `ProjectChat` Durable Object — and the rule the plan sets
 * is that they must be the same code: a test created by typing into the chat and
 * one created by filling in the dialog have to be the same row, made the same
 * way, with the same guards. So the guards live here and the callers keep only
 * what is genuinely theirs — validating input, and knowing who is asking.
 *
 * Three things every function here assumes, because its callers guarantee them:
 *
 * - **The organization has already been checked.** Callers resolve rows through
 *   `server/scope.ts` (a request) or through the project the Durable Object was
 *   authorized on (a chat turn). Nothing here re-derives a tenant.
 * - **Input has already been validated.** Titles are trimmed, crons are parsed,
 *   URLs are normalised. `ValidationError` still escapes from here, but only for
 *   rules that need the database to check — "this project has no environment",
 *   "that environment belongs to somewhere else".
 * - **Nothing executes.** Runs, suites and generations are enqueued: a row, then
 *   a Workflow instance named after it, then a return.
 */
import { env } from 'cloudflare:workers'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import type { GenerationJobKind, IntentStatus } from '#/db/schema/app.ts'
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

/**
 * The filter every "this project as a suite" query wears.
 *
 * A proposed intent is a suggestion nobody has agreed to yet, so it must not be
 * run, scheduled, or counted among the project's tests. Written once, here,
 * because the failure mode of forgetting it in one query is a "run all" that
 * quietly executes a test the user never approved.
 */
export { isAdoptedIntent, isRunnableIntent } from './test-policy.ts'
/** The row every "run this somewhere" path needs, resolved the same way twice. */
export type TargetEnvironment = typeof environment.$inferSelect

/** Shell-style, because that is how the harness exposes variables to a script. */
export function assertVariableName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new ValidationError(
      'A variable name must start with a letter or underscore and contain only letters, numbers and underscores.',
    )
  }
  return value
}

/**
 * Which environment a run, suite or generation points at.
 *
 * `environmentId` null means "the project's default". A named environment is
 * accepted only if it belongs to *this* project: the caller has already proved
 * it belongs to the organization, and without this check a sibling project's id
 * would silently retarget the work.
 */
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

/** The version an intent would run today, or null while it has no script. */
export async function loadCurrentVersion(db: Db, currentVersionId: string | null) {
  if (!currentVersionId) return null

  const [row] = await db
    .select()
    .from(scriptVersion)
    .where(eq(scriptVersion.id, currentVersionId))
    .limit(1)

  return row ?? null
}

/**
 * Appends a script version and points the intent at it, atomically.
 *
 * Every save starts a draft and clears the current result. Historical runs
 * remain attached to the immutable versions they executed.
 */
export { appendScriptVersion } from './script-records.ts'

/* ------------------------------------------------------------------ Intents */

export async function createIntentRecord(
  db: Db,
  input: {
    projectId: string
    title: string
    description: string
    createdBy: string
    /**
     * `'draft'` unless the explorer is writing it, in which case `'proposed'`:
     * a real row, in the project, excluded from everything that runs until
     * somebody approves it.
     */
    status?: IntentStatus
  },
) {
  // Deliberately no script: an intent starts as a description, and the first
  // save — by hand, or by the generator — is what makes it runnable.
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

/**
 * Approval: proposed intents become ordinary ones.
 *
 * Guarded on the status rather than blindly setting it, so approving a list
 * that has already been approved — a double-clicked button, a retried step —
 * cannot drag an intent that has since passed back to `'draft'`.
 */
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

/** Absent keys are left alone; `schedule: null` clears the cron expression. */
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

/**
 * Queues a run. Nothing executes in the caller.
 *
 * The row is inserted first and the Workflow instance is named after it, so the
 * run id is the only handle anyone needs: the client polls it, the engine writes
 * to it, and creating the same run twice is a no-op rather than a second
 * browser session.
 */
export async function queueIntentRun(
  db: Db,
  input: {
    intentId: string
    projectId: string
    organizationId: string
    environment: TargetEnvironment
    scriptVersionId: string
  },
) {
  const [test] = await db.select().from(intent).where(eq(intent.id, input.intentId)).limit(1)
  const purpose =
    test?.readiness === 'ready' && test.currentVersionId === input.scriptVersionId
      ? ('regression' as const)
      : ('draft-check' as const)
  const row = {
    id: createId('run'),
    intentId: input.intentId,
    environmentId: input.environment.id,
    projectId: input.projectId,
    scriptVersionId: input.scriptVersionId,
    purpose,
    environmentName: input.environment.name,
    baseUrl: input.environment.baseUrl,
    status: 'queued' as const,
    trigger: 'manual' as const,
    startedAt: new Date(),
  }

  await db.insert(run).values(row)

  // The organization comes from the session, not from the run row: the Workflow
  // re-checks it, and a value the client could influence would make that check
  // meaningless.
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

/**
 * Refuses to start a second generation while one is running.
 *
 * Two agents driving two browsers towards the same intent would race to save
 * conflicting versions of it, and the one that lost would still have spent the
 * tokens.
 */
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

/**
 * Queues a generation job. Enqueue-only, exactly like `queueIntentRun`.
 *
 * The job id is the handle for everything after — it names the Workflow
 * instance, it addresses the live channel the UI watches, and it is the row
 * `src/server.ts` checks before letting a socket near that channel.
 */
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

/* ------------------------------------------------------------ Project context */

/**
 * How much standing knowledge about an app is worth carrying.
 *
 * Four kilobytes is roughly a page of prose, and it is prepended to every chat
 * turn and every generation's opening message — so the cost of a larger cap is
 * paid on every model call this project ever makes, for text that is by
 * definition background rather than the task.
 */
export const MAX_PROJECT_CONTEXT_CHARS = 4000

/**
 * Replaces what the project knows about itself.
 *
 * The caller redacts. That is not a detail: the first paragraph of a project's
 * context is very often the sentence a user typed a password into, and the value
 * has to be `***` by the time it reaches this function — which is why the chat
 * tool runs it through the turn's scrubber and the explorer through the run
 * engine's, rather than either being trusted to have been careful.
 */
export async function setProjectContextRecord(
  db: Db,
  projectId: string,
  text: string | null,
): Promise<{ length: number }> {
  const value = text === null ? null : text.slice(0, MAX_PROJECT_CONTEXT_CHARS)

  await db.update(project).set({ context: value }).where(eq(project.id, projectId))
  return { length: value?.length ?? 0 }
}

/**
 * Adds a section to it, oldest first, and drops the front when it will not fit.
 *
 * Appending rather than replacing is what makes a second exploration worth
 * running: the first one's notes about how to sign in are still true. Trimming
 * from the front rather than refusing to write is the same judgement in the
 * other direction — the newest thing anyone learned about the app is the part
 * worth keeping.
 */
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

/* --------------------------------------------------------------- Exploration */

/** One exploration at a time per project — they would fight over the browser. */
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

/**
 * Queues an exploration. Enqueue-only, exactly like every other job here.
 *
 * The row is a `generation_job` with no `intentId`, because an exploration is
 * about the project rather than about one test — and it is what authorizes the
 * live socket, so it has to exist before the workflow does.
 */
export async function queueExploration(
  db: Db,
  input: {
    projectId: string
    organizationId: string
    environment: TargetEnvironment
    createdBy: string
    /** What the user asked it to concentrate on, when they said. */
    focus: string | null
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

/* ---------------------------------------------------------- Batch generation */

/**
 * How many tests one approval may generate.
 *
 * Bounded by Workflows' 1,024 steps per instance rather than by taste: a
 * generation costs about thirty steps, so fifteen members and the batch's own
 * bookkeeping sit comfortably inside it. It also matches the ceiling the
 * explorer proposes under, so approving a whole plan always fits.
 */
export const MAX_BATCH_INTENTS = 15

/**
 * Approves a plan and starts writing its scripts.
 *
 * Two things in one call because they are one decision: the intents stop being
 * proposals and the machine that turns them into tests starts. Sequential from
 * there — see `BatchGenerateWorkflow` — because Browser Rendering allows very
 * few concurrent sessions and a fan-out would spend its time collecting 429s.
 */
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

/* ------------------------------------------------------------------- Suites */

/**
 * How many intents in a project a "run all" would actually execute.
 *
 * `isAdoptedIntent` is belt and braces here — a proposed intent has no script,
 * so the version check already excludes it — but the two conditions mean
 * different things and the suite's own membership query needs both, so they are
 * stated together in both places rather than one being left implied.
 */
export async function countRunnableIntents(db: Db, projectId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(intent)
    .where(and(eq(intent.projectId, projectId), isRunnableIntent))

  return Number(row?.count ?? 0)
}

/**
 * Queues a suite. The membership is deliberately *not* fixed here — the
 * workflow's `load` step decides it, from the same query, at the moment it
 * starts. Counting runnable intents first is only a guard against queueing a
 * suite that would have nothing to do.
 */
export async function queueSuiteRun(
  db: Db,
  input: {
    projectId: string
    organizationId: string
    environment: TargetEnvironment
    createdBy: string
  },
) {
  const runnable = await countRunnableIntents(db, input.projectId)
  if (runnable === 0) {
    throw new ValidationError(
      'Mark at least one saved test ready before running a suite. Draft checks are excluded.',
    )
  }

  const row = {
    id: createId('srun'),
    projectId: input.projectId,
    environmentId: input.environment.id,
    environmentName: input.environment.name,
    baseUrl: input.environment.baseUrl,
    status: 'queued' as const,
    trigger: 'manual' as const,
    createdBy: input.createdBy,
    startedAt: new Date(),
  }

  await db.insert(suiteRun).values(row)

  await enqueueWork(
    () =>
      env.SUITE_WORKFLOW.create({
        id: row.id,
        params: { suiteRunId: row.id, organizationId: input.organizationId },
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

/* ------------------------------------------------------------- Environments */

/** Clears `isDefault` on every sibling; pair it with the row that wins. */
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

  // A project always has a default; the first environment has no competition.
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

/**
 * Stores one credential, encrypted.
 *
 * Upserts on the `(environmentId, name)` unique index: setting a variable twice
 * replaces the value rather than failing or duplicating the row. The plaintext
 * exists only in this call — what comes back is a mask.
 */
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
