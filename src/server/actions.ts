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
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import type { IntentStatus, ScriptAuthor } from '#/db/schema/app.ts'
import {
  environment,
  environmentVariable,
  generationJob,
  intent,
  run,
  scriptVersion,
  suiteRun,
} from '#/db/schema/app.ts'
import { createId } from '#/lib/ids.ts'
import { encryptSecret, maskSecret } from './crypto.ts'
import { loadDefaultEnvironment } from './scope.ts'
import { ValidationError } from './validate.ts'

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
 * `status` only moves `'draft' → 'ready'`: an intent that has already passed or
 * failed keeps that history until the next run re-decides it.
 */
export async function appendScriptVersion(
  db: Db,
  input: {
    intentId: string
    status: IntentStatus
    code: string
    author: ScriptAuthor
    note: string | null
    createdBy: string
  },
) {
  const [last] = await db
    .select({ version: scriptVersion.version })
    .from(scriptVersion)
    .where(eq(scriptVersion.intentId, input.intentId))
    .orderBy(desc(scriptVersion.version))
    .limit(1)

  const row = {
    id: createId('sv'),
    intentId: input.intentId,
    version: (last?.version ?? 0) + 1,
    code: input.code,
    author: input.author,
    createdBy: input.createdBy,
    note: input.note,
  }

  await db.batch([
    db.insert(scriptVersion).values(row),
    db
      .update(intent)
      .set({
        currentVersionId: row.id,
        ...(input.status === 'draft' ? { status: 'ready' as const } : {}),
      })
      .where(eq(intent.id, input.intentId)),
  ])

  return { id: row.id, version: row.version }
}

/* ------------------------------------------------------------------ Intents */

export async function createIntentRecord(
  db: Db,
  input: { projectId: string; title: string; description: string; createdBy: string },
) {
  // Deliberately no script: an intent starts as a description, and the first
  // save — by hand, or by the generator — is what makes it runnable.
  const row = {
    id: createId('int'),
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    createdBy: input.createdBy,
  }

  await db.insert(intent).values(row)
  return { id: row.id, title: row.title, status: 'draft' as const }
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
    ...(input.description === undefined ? {} : { description: input.description }),
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
  const row = {
    id: createId('run'),
    intentId: input.intentId,
    environmentId: input.environment.id,
    projectId: input.projectId,
    scriptVersionId: input.scriptVersionId,
    status: 'queued' as const,
    trigger: 'manual' as const,
    startedAt: new Date(),
  }

  await db.insert(run).values(row)

  // The organization comes from the session, not from the run row: the Workflow
  // re-checks it, and a value the client could influence would make that check
  // meaningless.
  await env.RUN_WORKFLOW.create({
    id: row.id,
    params: { runId: row.id, organizationId: input.organizationId },
  })

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
    throw new ValidationError('A script is already being generated for this intent.')
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
    throw new ValidationError('A script is already being generated for this intent.')
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
    intentId: input.intentId,
    projectId: input.projectId,
    environmentId: input.environment.id,
    organizationId: input.organizationId,
    status: 'queued' as const,
    createdBy: input.createdBy,
  }

  await db.insert(generationJob).values(row)

  await env.GENERATE_WORKFLOW.create({
    id: row.id,
    params: {
      jobId: row.id,
      intentId: input.intentId,
      environmentId: input.environment.id,
      organizationId: input.organizationId,
      userId: input.createdBy,
    },
  })

  return { jobId: row.id, environmentId: input.environment.id }
}

/* ------------------------------------------------------------------- Suites */

/** How many intents in a project a "run all" would actually execute. */
export async function countRunnableIntents(db: Db, projectId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(intent)
    .where(and(eq(intent.projectId, projectId), isNotNull(intent.currentVersionId)))

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
    throw new ValidationError('No intent in this project has a saved script yet.')
  }

  const row = {
    id: createId('srun'),
    projectId: input.projectId,
    environmentId: input.environment.id,
    status: 'queued' as const,
    trigger: 'manual' as const,
    createdBy: input.createdBy,
    startedAt: new Date(),
  }

  await db.insert(suiteRun).values(row)

  await env.SUITE_WORKFLOW.create({
    id: row.id,
    params: { suiteRunId: row.id, organizationId: input.organizationId },
  })

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
