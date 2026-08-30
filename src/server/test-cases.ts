import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { project, testCase, testRun } from '#/db/schema/app.ts'
import { createId } from '#/lib/ids.ts'
import { AuthError, orgMiddleware } from './auth.ts'
import { executeSpec, generateSpec } from './engine.ts'
import { ValidationError, str } from './validate.ts'

/** Scoped to the caller's organization, so a foreign id reads as missing. */
async function loadCase(db: Db, organizationId: string, testCaseId: string) {
  const [row] = await db
    .select({ testCase, project })
    .from(testCase)
    .innerJoin(project, eq(project.id, testCase.projectId))
    .where(and(eq(testCase.id, testCaseId), eq(project.organizationId, organizationId)))
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

export const listTestCases = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId') }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    return context.db
      .select()
      .from(testCase)
      .where(eq(testCase.projectId, data.projectId))
      .orderBy(desc(testCase.updatedAt))
  })

export const getTestCase = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ testCaseId: str(data, 'testCaseId') }))
  .handler(async ({ data, context }) => {
    const row = await loadCase(context.db, context.organizationId, data.testCaseId)

    const runs = await context.db
      .select()
      .from(testRun)
      .where(eq(testRun.testCaseId, data.testCaseId))
      .orderBy(desc(testRun.startedAt))
      .limit(25)

    return { testCase: row.testCase, project: row.project, runs }
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
      id: createId('tc'),
      projectId: data.projectId,
      title: data.title,
      prompt: data.prompt,
      createdBy: context.user.id,
    }

    await context.db.insert(testCase).values(row)
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
      .update(testCase)
      .set({ title: data.title, prompt: data.prompt })
      .where(eq(testCase.id, data.testCaseId))

    return { ok: true as const }
  })

export const deleteTestCase = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ testCaseId: str(data, 'testCaseId') }))
  .handler(async ({ data, context }) => {
    await loadCase(context.db, context.organizationId, data.testCaseId)
    await context.db.delete(testCase).where(eq(testCase.id, data.testCaseId))
    return { ok: true as const }
  })

/**
 * Generates (or re-generates) the Playwright spec for a case. When the last
 * run failed, its error is fed back in so the new spec is a repair attempt.
 */
export const generateTestCase = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ testCaseId: str(data, 'testCaseId') }))
  .handler(async ({ data, context }) => {
    const row = await loadCase(context.db, context.organizationId, data.testCaseId)

    const [lastRun] = await context.db
      .select()
      .from(testRun)
      .where(eq(testRun.testCaseId, data.testCaseId))
      .orderBy(desc(testRun.startedAt))
      .limit(1)

    const attempt = row.testCase.generationCount + 1
    const { code, summary } = generateSpec({
      projectName: row.project.name,
      baseUrl: row.project.baseUrl,
      title: row.testCase.title,
      prompt: row.testCase.prompt,
      previousCode: row.testCase.generatedCode,
      previousError: lastRun?.status === 'failed' ? lastRun.errorMessage : null,
      attempt,
    })

    await context.db
      .update(testCase)
      .set({ generatedCode: code, generationCount: attempt, status: 'ready' })
      .where(eq(testCase.id, data.testCaseId))

    return { code, summary, attempt }
  })

export const runTestCase = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ testCaseId: str(data, 'testCaseId') }))
  .handler(async ({ data, context }) => {
    const row = await loadCase(context.db, context.organizationId, data.testCaseId)
    if (!row.testCase.generatedCode) {
      throw new ValidationError('Generate the Playwright code before running it.')
    }

    const [previous] = await context.db
      .select({ attempt: testRun.attempt })
      .from(testRun)
      .where(eq(testRun.testCaseId, data.testCaseId))
      .orderBy(desc(testRun.attempt))
      .limit(1)

    const attempt = (previous?.attempt ?? 0) + 1
    const result = executeSpec({
      code: row.testCase.generatedCode,
      baseUrl: row.project.baseUrl,
      title: row.testCase.title,
      seed: row.testCase.id,
      attempt,
    })

    const run = {
      id: createId('run'),
      testCaseId: row.testCase.id,
      projectId: row.project.id,
      status: result.status,
      trigger: 'manual' as const,
      attempt,
      code: row.testCase.generatedCode,
      logs: result.logs,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
      finishedAt: new Date(),
    }

    await context.db.insert(testRun).values(run)
    await context.db
      .update(testCase)
      .set({ status: result.status === 'passed' ? 'passing' : 'failing', lastRunId: run.id })
      .where(eq(testCase.id, row.testCase.id))

    return { runId: run.id, status: result.status, attempt, durationMs: result.durationMs }
  })

/**
 * The repair loop in one call: re-generate against the last failure, run the
 * new spec, and report both halves.
 */
export const regenerateAndRun = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ testCaseId: str(data, 'testCaseId') }))
  .handler(async ({ data, context }) => {
    const row = await loadCase(context.db, context.organizationId, data.testCaseId)

    const [lastRun] = await context.db
      .select()
      .from(testRun)
      .where(eq(testRun.testCaseId, data.testCaseId))
      .orderBy(desc(testRun.startedAt))
      .limit(1)

    const generationAttempt = row.testCase.generationCount + 1
    const { code, summary } = generateSpec({
      projectName: row.project.name,
      baseUrl: row.project.baseUrl,
      title: row.testCase.title,
      prompt: row.testCase.prompt,
      previousCode: row.testCase.generatedCode,
      previousError: lastRun?.errorMessage ?? null,
      attempt: generationAttempt,
    })

    const attempt = (lastRun?.attempt ?? 0) + 1
    const result = executeSpec({
      code,
      baseUrl: row.project.baseUrl,
      title: row.testCase.title,
      seed: row.testCase.id,
      attempt,
    })

    const run = {
      id: createId('run'),
      testCaseId: row.testCase.id,
      projectId: row.project.id,
      status: result.status,
      trigger: 'regenerate' as const,
      attempt,
      code,
      logs: result.logs,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
      finishedAt: new Date(),
    }

    await context.db.insert(testRun).values(run)
    await context.db
      .update(testCase)
      .set({
        generatedCode: code,
        generationCount: generationAttempt,
        status: result.status === 'passed' ? 'passing' : 'failing',
        lastRunId: run.id,
      })
      .where(eq(testCase.id, row.testCase.id))

    return { runId: run.id, status: result.status, attempt, summary }
  })
