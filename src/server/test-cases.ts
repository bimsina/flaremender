/**
 * M4: this file becomes `src/server/intents.ts` — intents CRUD, `saveScript`,
 * version history, and a `runIntent` that only creates a Workflow instance.
 *
 * For now it is the pre-existing test-case surface, rewired onto the new
 * schema so the app keeps working: an intent's "generated code" is its current
 * `scriptVersion`, and a run is a `run` row plus the single `attempt` the stub
 * engine produces. Nothing here is meant to survive M4/M5.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { attempt, environment, intent, project, run, scriptVersion } from '#/db/schema/app.ts'
import { createId } from '#/lib/ids.ts'
import { AuthError, orgMiddleware } from './auth.ts'
import { executeSpec, generateSpec } from './engine.ts'
import { ValidationError, str } from './validate.ts'

/** Scoped to the caller's organization, so a foreign id reads as missing. */
async function loadCase(db: Db, organizationId: string, intentId: string) {
  const [row] = await db
    .select({ intent, project })
    .from(intent)
    .innerJoin(project, eq(project.id, intent.projectId))
    .where(and(eq(intent.id, intentId), eq(project.organizationId, organizationId)))
    .limit(1)

  if (!row) throw new AuthError('Test case not found.', 404)
  return row
}

async function assertProject(db: Db, organizationId: string, projectId: string) {
  const [row] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.id, projectId), eq(project.organizationId, organizationId)))
    .limit(1)

  if (!row) throw new AuthError('Project not found.', 404)
  return row
}

async function loadDefaultEnvironment(db: Db, projectId: string) {
  const [row] = await db
    .select()
    .from(environment)
    .where(and(eq(environment.projectId, projectId), eq(environment.isDefault, true)))
    .limit(1)

  return row ?? null
}

async function loadCurrentVersion(db: Db, currentVersionId: string | null) {
  if (!currentVersionId) return null

  const [row] = await db
    .select()
    .from(scriptVersion)
    .where(eq(scriptVersion.id, currentVersionId))
    .limit(1)

  return row ?? null
}

/** The last run of an intent, flattened with its (single, for now) attempt. */
async function loadLastRun(db: Db, intentId: string) {
  const [row] = await db
    .select({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      attemptNumber: attempt.attemptNumber,
      errorMessage: attempt.errorMessage,
    })
    .from(run)
    .leftJoin(attempt, eq(attempt.runId, run.id))
    .where(eq(run.intentId, intentId))
    .orderBy(desc(run.startedAt))
    .limit(1)

  return row ?? null
}

export const listTestCases = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId') }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    const rows = await context.db
      .select({
        id: intent.id,
        projectId: intent.projectId,
        title: intent.title,
        prompt: intent.description,
        status: intent.status,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
        generatedCode: scriptVersion.code,
        generationCount: scriptVersion.version,
      })
      .from(intent)
      .leftJoin(scriptVersion, eq(scriptVersion.id, intent.currentVersionId))
      .where(eq(intent.projectId, data.projectId))
      .orderBy(desc(intent.updatedAt))

    return rows.map((row) => ({ ...row, generationCount: row.generationCount ?? 0 }))
  })

export const getTestCase = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ testCaseId: str(data, 'testCaseId') }))
  .handler(async ({ data, context }) => {
    const row = await loadCase(context.db, context.organizationId, data.testCaseId)
    const [version, defaultEnv] = await Promise.all([
      loadCurrentVersion(context.db, row.intent.currentVersionId),
      loadDefaultEnvironment(context.db, row.project.id),
    ])

    const runs = await context.db
      .select({
        id: run.id,
        status: run.status,
        trigger: run.trigger,
        startedAt: run.startedAt,
        attempt: attempt.attemptNumber,
        durationMs: attempt.durationMs,
        logs: attempt.logs,
        errorMessage: attempt.errorMessage,
      })
      .from(run)
      .leftJoin(attempt, eq(attempt.runId, run.id))
      .where(eq(run.intentId, data.testCaseId))
      .orderBy(desc(run.startedAt))
      .limit(25)

    return {
      testCase: {
        ...row.intent,
        prompt: row.intent.description,
        generatedCode: version?.code ?? null,
        generationCount: version?.version ?? 0,
      },
      project: { ...row.project, baseUrl: defaultEnv?.baseUrl ?? '—' },
      runs: runs.map((entry) => ({ ...entry, attempt: entry.attempt ?? 1 })),
    }
  })

export const createTestCase = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    title: str(data, 'title', { max: 120 }),
    prompt: str(data, 'prompt', { min: 10, max: 4000 }),
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    const row = {
      id: createId('int'),
      projectId: data.projectId,
      title: data.title,
      description: data.prompt,
      createdBy: context.user.id,
    }

    await context.db.insert(intent).values(row)
    return { id: row.id }
  })

export const updateTestCase = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    testCaseId: str(data, 'testCaseId'),
    title: str(data, 'title', { max: 120 }),
    prompt: str(data, 'prompt', { min: 10, max: 4000 }),
  }))
  .handler(async ({ data, context }) => {
    await loadCase(context.db, context.organizationId, data.testCaseId)

    await context.db
      .update(intent)
      .set({ title: data.title, description: data.prompt })
      .where(eq(intent.id, data.testCaseId))

    return { ok: true as const }
  })

export const deleteTestCase = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ testCaseId: str(data, 'testCaseId') }))
  .handler(async ({ data, context }) => {
    await loadCase(context.db, context.organizationId, data.testCaseId)
    await context.db.delete(intent).where(eq(intent.id, data.testCaseId))
    return { ok: true as const }
  })

/**
 * Writes a new script version from the intent's description. M4 splits this
 * into `saveScript` (human edits) and the phase-2 generator.
 */
async function writeVersion(
  db: Db,
  input: {
    intentId: string
    projectName: string
    baseUrl: string
    title: string
    description: string
    previousCode: string | null
    previousError: string | null
    previousVersion: number
    createdBy: string
  },
) {
  const version = input.previousVersion + 1
  const { code, summary } = generateSpec({
    projectName: input.projectName,
    baseUrl: input.baseUrl,
    title: input.title,
    prompt: input.description,
    previousCode: input.previousCode,
    previousError: input.previousError,
    attempt: version,
  })

  const row = {
    id: createId('sv'),
    intentId: input.intentId,
    version,
    code,
    // M4: human saves are author 'user'; only the generator writes 'agent'.
    author: 'agent' as const,
    createdBy: input.createdBy,
    note: 'generated from intent',
  }

  await db.batch([
    db.insert(scriptVersion).values(row),
    db
      .update(intent)
      .set({ currentVersionId: row.id, status: 'ready' })
      .where(eq(intent.id, input.intentId)),
  ])

  return { id: row.id, code, summary, version }
}

export const generateTestCase = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ testCaseId: str(data, 'testCaseId') }))
  .handler(async ({ data, context }) => {
    const row = await loadCase(context.db, context.organizationId, data.testCaseId)
    const [defaultEnv, current, lastRun] = await Promise.all([
      loadDefaultEnvironment(context.db, row.project.id),
      loadCurrentVersion(context.db, row.intent.currentVersionId),
      loadLastRun(context.db, data.testCaseId),
    ])

    if (!defaultEnv) throw new ValidationError('This project has no environment to run against.')

    const written = await writeVersion(context.db, {
      intentId: row.intent.id,
      projectName: row.project.name,
      baseUrl: defaultEnv.baseUrl,
      title: row.intent.title,
      description: row.intent.description,
      previousCode: current?.code ?? null,
      previousError: lastRun?.status === 'failed' ? lastRun.errorMessage : null,
      previousVersion: current?.version ?? 0,
      createdBy: context.user.id,
    })

    return { code: written.code, summary: written.summary, attempt: written.version }
  })

/** One run row plus the single attempt the stub engine produces. */
async function recordRun(
  db: Db,
  input: {
    intentId: string
    projectId: string
    environmentId: string
    scriptVersionId: string
    code: string
    baseUrl: string
    title: string
    trigger: 'manual' | 'regenerate'
  },
) {
  // M4: `attemptNumber` is 1-based *within a run* once healing appends
  // attempts. Until then it doubles as the run counter the UI already shows.
  const previous = await db
    .select({ attemptNumber: attempt.attemptNumber })
    .from(attempt)
    .innerJoin(run, eq(run.id, attempt.runId))
    .where(eq(run.intentId, input.intentId))
    .orderBy(desc(attempt.attemptNumber))
    .limit(1)

  const attemptNumber = (previous[0]?.attemptNumber ?? 0) + 1
  const result = executeSpec({
    code: input.code,
    baseUrl: input.baseUrl,
    title: input.title,
    seed: input.intentId,
    attempt: attemptNumber,
  })

  const runRow = {
    id: createId('run'),
    intentId: input.intentId,
    environmentId: input.environmentId,
    projectId: input.projectId,
    scriptVersionId: input.scriptVersionId,
    status: result.status,
    trigger: input.trigger,
    startedAt: new Date(),
    finishedAt: new Date(),
  }

  await db.batch([
    db.insert(run).values(runRow),
    db.insert(attempt).values({
      id: createId('att'),
      runId: runRow.id,
      attemptNumber,
      outcome: result.status,
      scriptVersionId: input.scriptVersionId,
      scriptUsed: input.code,
      logs: result.logs,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
    }),
    db
      .update(intent)
      .set({ status: result.status === 'passed' ? 'passing' : 'failing', lastRunId: runRow.id })
      .where(eq(intent.id, input.intentId)),
  ])

  return { runId: runRow.id, status: result.status, attemptNumber, durationMs: result.durationMs }
}

export const runTestCase = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ testCaseId: str(data, 'testCaseId') }))
  .handler(async ({ data, context }) => {
    const row = await loadCase(context.db, context.organizationId, data.testCaseId)
    const [version, defaultEnv] = await Promise.all([
      loadCurrentVersion(context.db, row.intent.currentVersionId),
      loadDefaultEnvironment(context.db, row.project.id),
    ])

    if (!version) throw new ValidationError('Generate the Playwright code before running it.')
    if (!defaultEnv) throw new ValidationError('This project has no environment to run against.')

    const recorded = await recordRun(context.db, {
      intentId: row.intent.id,
      projectId: row.project.id,
      environmentId: defaultEnv.id,
      scriptVersionId: version.id,
      code: version.code,
      baseUrl: defaultEnv.baseUrl,
      title: row.intent.title,
      trigger: 'manual',
    })

    return {
      runId: recorded.runId,
      status: recorded.status,
      attempt: recorded.attemptNumber,
      durationMs: recorded.durationMs,
    }
  })

/** Re-generate against the last failure, run the new version, report both. */
export const regenerateAndRun = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ testCaseId: str(data, 'testCaseId') }))
  .handler(async ({ data, context }) => {
    const row = await loadCase(context.db, context.organizationId, data.testCaseId)
    const [defaultEnv, current, lastRun] = await Promise.all([
      loadDefaultEnvironment(context.db, row.project.id),
      loadCurrentVersion(context.db, row.intent.currentVersionId),
      loadLastRun(context.db, data.testCaseId),
    ])

    if (!defaultEnv) throw new ValidationError('This project has no environment to run against.')

    const written = await writeVersion(context.db, {
      intentId: row.intent.id,
      projectName: row.project.name,
      baseUrl: defaultEnv.baseUrl,
      title: row.intent.title,
      description: row.intent.description,
      previousCode: current?.code ?? null,
      previousError: lastRun?.errorMessage ?? null,
      previousVersion: current?.version ?? 0,
      createdBy: context.user.id,
    })

    const recorded = await recordRun(context.db, {
      intentId: row.intent.id,
      projectId: row.project.id,
      environmentId: defaultEnv.id,
      scriptVersionId: written.id,
      code: written.code,
      baseUrl: defaultEnv.baseUrl,
      title: row.intent.title,
      trigger: 'regenerate',
    })

    return {
      runId: recorded.runId,
      status: recorded.status,
      attempt: recorded.attemptNumber,
      summary: written.summary,
    }
  })
