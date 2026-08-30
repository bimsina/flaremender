/**
 * Intents and their script history.
 *
 * The plain-English description is the source of truth; the Playwright script
 * is a derived artefact kept in `scriptVersion`. Every save — by a human today,
 * by the generator in phase 2 — inserts a new immutable version, so "restore"
 * is just another save that copies old code forward.
 */
import { createServerFn } from '@tanstack/react-start'
import { desc, eq, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import type { IntentStatus, ScriptAuthor } from '#/db/schema/app.ts'
import { attempt, intent, run, scriptVersion } from '#/db/schema/app.ts'
import { user } from '#/db/schema/auth.ts'
import { createId } from '#/lib/ids.ts'
import { orgMiddleware } from './auth.ts'
import { executeSpec } from './engine.ts'
import {
  assertProject,
  loadDefaultEnvironment,
  loadEnvironment,
  loadIntent,
  loadScriptVersion,
} from './scope.ts'
import { ValidationError, cron, has, optionalStr, str } from './validate.ts'

async function loadCurrentVersion(db: Db, currentVersionId: string | null) {
  if (!currentVersionId) return null

  const [row] = await db
    .select()
    .from(scriptVersion)
    .where(eq(scriptVersion.id, currentVersionId))
    .limit(1)

  return row ?? null
}

/**
 * Appends a version and points the intent at it, atomically.
 *
 * `status` only moves `'draft' → 'ready'`: an intent that has already passed or
 * failed keeps that history until the next run re-decides it.
 */
async function appendVersion(
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

export const listIntents = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId') }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    const rows = await context.db
      .select({
        id: intent.id,
        projectId: intent.projectId,
        title: intent.title,
        description: intent.description,
        status: intent.status,
        schedule: intent.schedule,
        lastRunId: intent.lastRunId,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
        currentVersion: scriptVersion.version,
      })
      .from(intent)
      .leftJoin(scriptVersion, eq(scriptVersion.id, intent.currentVersionId))
      .where(eq(intent.projectId, data.projectId))
      .orderBy(desc(intent.updatedAt))

    return rows.map((row) => ({ ...row, currentVersion: row.currentVersion ?? 0 }))
  })

export const getIntent = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ intentId: str(data, 'intentId') }))
  .handler(async ({ data, context }) => {
    const row = await loadIntent(context.db, context.organizationId, data.intentId)
    const version = await loadCurrentVersion(context.db, row.intent.currentVersionId)

    return {
      intent: {
        id: row.intent.id,
        projectId: row.intent.projectId,
        title: row.intent.title,
        description: row.intent.description,
        status: row.intent.status,
        schedule: row.intent.schedule,
        lastRunId: row.intent.lastRunId,
        createdAt: row.intent.createdAt,
        updatedAt: row.intent.updatedAt,
      },
      currentVersion: version
        ? { id: version.id, version: version.version, code: version.code, author: version.author }
        : null,
      project: { id: row.project.id, name: row.project.name, slug: row.project.slug },
    }
  })

export const createIntent = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    title: str(data, 'title', { max: 120 }),
    description: str(data, 'description', { min: 10, max: 4000 }),
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    // Deliberately no script: an intent starts as a description, and the first
    // save — by hand today, by the generator later — is what makes it runnable.
    const row = {
      id: createId('int'),
      projectId: data.projectId,
      title: data.title,
      description: data.description,
      createdBy: context.user.id,
    }

    await context.db.insert(intent).values(row)
    return { id: row.id }
  })

export const updateIntent = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    intentId: str(data, 'intentId'),
    // Absent keys are left alone; `schedule: null` clears the cron expression.
    title: has(data, 'title') ? str(data, 'title', { max: 120 }) : undefined,
    description: has(data, 'description')
      ? str(data, 'description', { min: 10, max: 4000 })
      : undefined,
    schedule: has(data, 'schedule') ? cron(data, 'schedule') : undefined,
  }))
  .handler(async ({ data, context }) => {
    await loadIntent(context.db, context.organizationId, data.intentId)

    const patch = {
      ...(data.title === undefined ? {} : { title: data.title }),
      ...(data.description === undefined ? {} : { description: data.description }),
      ...(data.schedule === undefined ? {} : { schedule: data.schedule }),
    }

    if (Object.keys(patch).length === 0) return { ok: true as const }

    await context.db.update(intent).set(patch).where(eq(intent.id, data.intentId))
    return { ok: true as const }
  })

export const deleteIntent = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ intentId: str(data, 'intentId') }))
  .handler(async ({ data, context }) => {
    await loadIntent(context.db, context.organizationId, data.intentId)
    await context.db.delete(intent).where(eq(intent.id, data.intentId))
    return { ok: true as const }
  })

export const saveScript = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    intentId: str(data, 'intentId'),
    code: str(data, 'code', { max: 100_000 }),
    note: optionalStr(data, 'note', 200),
  }))
  .handler(async ({ data, context }) => {
    const row = await loadIntent(context.db, context.organizationId, data.intentId)

    return appendVersion(context.db, {
      intentId: row.intent.id,
      status: row.intent.status,
      code: data.code,
      author: 'user',
      note: data.note,
      createdBy: context.user.id,
    })
  })

export const listScriptVersions = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ intentId: str(data, 'intentId') }))
  .handler(async ({ data, context }) => {
    await loadIntent(context.db, context.organizationId, data.intentId)

    // The code itself is deliberately absent: a history panel only needs the
    // shape of each version, and scripts are large.
    return context.db
      .select({
        id: scriptVersion.id,
        version: scriptVersion.version,
        author: scriptVersion.author,
        note: scriptVersion.note,
        createdByName: user.name,
        createdAt: scriptVersion.createdAt,
        codeLength: sql<number>`length(${scriptVersion.code})`,
      })
      .from(scriptVersion)
      .innerJoin(user, eq(user.id, scriptVersion.createdBy))
      .where(eq(scriptVersion.intentId, data.intentId))
      .orderBy(desc(scriptVersion.version))
  })

export const getScriptVersion = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ versionId: str(data, 'versionId') }))
  .handler(async ({ data, context }) => {
    const row = await loadScriptVersion(context.db, context.organizationId, data.versionId)

    return {
      id: row.version.id,
      intentId: row.version.intentId,
      version: row.version.version,
      code: row.version.code,
      author: row.version.author,
      note: row.version.note,
      createdAt: row.version.createdAt,
      isCurrent: row.intent.currentVersionId === row.version.id,
    }
  })

export const restoreScriptVersion = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ versionId: str(data, 'versionId') }))
  .handler(async ({ data, context }) => {
    const row = await loadScriptVersion(context.db, context.organizationId, data.versionId)

    // History is immutable, so restoring copies the code forward as a new
    // version rather than moving the pointer backwards.
    return appendVersion(context.db, {
      intentId: row.intent.id,
      status: row.intent.status,
      code: row.version.code,
      author: 'user',
      note: `Restored from v${row.version.version}`,
      createdBy: context.user.id,
    })
  })

/**
 * Runs the script and records the outcome, synchronously, against the stub
 * engine.
 *
 * M5: replace with `env.RUN_WORKFLOW.create()`. The run row is already `queued`
 * by the time this is called, so the swap is exactly this call site — the
 * workflow takes the run from `queued` onwards and this function goes away.
 */
async function executeRunInline(
  db: Db,
  input: {
    runId: string
    intentId: string
    scriptVersionId: string
    code: string
    baseUrl: string
    title: string
  },
) {
  // One attempt per run until the healing loop appends more; `attemptNumber` is
  // 1-based *within a run*, not a per-intent counter.
  const attemptNumber = 1
  const result = executeSpec({
    code: input.code,
    baseUrl: input.baseUrl,
    title: input.title,
    seed: input.runId,
    attempt: attemptNumber,
  })

  await db.batch([
    db.insert(attempt).values({
      id: createId('att'),
      runId: input.runId,
      attemptNumber,
      outcome: result.status,
      scriptVersionId: input.scriptVersionId,
      scriptUsed: input.code,
      logs: result.logs,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
    }),
    db
      .update(run)
      .set({ status: result.status, finishedAt: new Date() })
      .where(eq(run.id, input.runId)),
    db
      .update(intent)
      .set({
        status: result.status === 'passed' ? 'passing' : 'failing',
        lastRunId: input.runId,
      })
      .where(eq(intent.id, input.intentId)),
  ])

  return { status: result.status, attemptNumber, durationMs: result.durationMs }
}

export const runIntent = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    intentId: str(data, 'intentId'),
    environmentId: has(data, 'environmentId') ? str(data, 'environmentId') : null,
  }))
  .handler(async ({ data, context }) => {
    const row = await loadIntent(context.db, context.organizationId, data.intentId)

    const environment = data.environmentId
      ? (await loadEnvironment(context.db, context.organizationId, data.environmentId)).environment
      : await loadDefaultEnvironment(context.db, row.project.id)

    if (!environment) {
      throw new ValidationError('This project has no environment to run against.')
    }
    // A named environment from another project would silently retarget the run.
    if (environment.projectId !== row.project.id) {
      throw new ValidationError('That environment belongs to a different project.')
    }

    const version = await loadCurrentVersion(context.db, row.intent.currentVersionId)
    if (!version) throw new ValidationError('Save a script first.')

    const runRow = {
      id: createId('run'),
      intentId: row.intent.id,
      environmentId: environment.id,
      projectId: row.project.id,
      scriptVersionId: version.id,
      status: 'queued' as const,
      trigger: 'manual' as const,
      startedAt: new Date(),
    }

    await context.db.insert(run).values(runRow)

    const executed = await executeRunInline(context.db, {
      runId: runRow.id,
      intentId: row.intent.id,
      scriptVersionId: version.id,
      code: version.code,
      baseUrl: environment.baseUrl,
      title: row.intent.title,
    })

    return {
      runId: runRow.id,
      environmentId: environment.id,
      status: executed.status,
      attemptNumber: executed.attemptNumber,
      durationMs: executed.durationMs,
    }
  })
