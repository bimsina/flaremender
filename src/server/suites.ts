/**
 * Suite runs — every runnable intent in a project, executed one after another.
 *
 * The shape mirrors `runIntent` deliberately: the row is inserted first, the
 * Workflow instance is named after it, and nothing executes in the request
 * handler. The suite id is then the only handle the client needs — it polls
 * that one row for progress, and the member runs it exposes are ordinary runs
 * that the intent pages already know how to render.
 */
import { createServerFn } from '@tanstack/react-start'
import { asc, desc, eq, sql } from 'drizzle-orm'

import { attempt, environment, intent, run, suiteRun } from '#/db/schema/app.ts'
import { queueSuiteRun, resolveTargetEnvironment } from './actions.ts'
import { orgMiddleware } from './auth.ts'
import { assertProject, loadEnvironment, loadSuiteRun } from './scope.ts'
import { ValidationError, has, str } from './validate.ts'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

function limit(data: unknown): number {
  if (!has(data, 'limit')) return DEFAULT_LIMIT

  const value = (data as Record<string, unknown>).limit
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new ValidationError(`"limit" must be a whole number between 1 and ${MAX_LIMIT}.`)
  }
  return parsed
}

/**
 * Queues a suite. Nothing executes in the request handler.
 *
 * The membership is deliberately *not* fixed here — the workflow's `load` step
 * decides it, from the same query, at the moment it starts. Counting runnable
 * intents in this handler is only a guard against queueing a suite that would
 * have nothing to do.
 */
export const runSuite = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    environmentId: has(data, 'environmentId') ? str(data, 'environmentId') : null,
  }))
  .handler(async ({ data, context }) => {
    const project = await assertProject(context.db, context.organizationId, data.projectId)

    const named = data.environmentId
      ? (await loadEnvironment(context.db, context.organizationId, data.environmentId)).environment
      : null

    const target = await resolveTargetEnvironment(context.db, project.id, named, 'run')

    const queued = await queueSuiteRun(context.db, {
      projectId: project.id,
      organizationId: context.organizationId,
      environment: target,
      createdBy: context.user.id,
    })

    return {
      suiteRunId: queued.suiteRunId,
      environmentId: queued.environmentId,
      status: 'queued' as const,
    }
  })

export const listSuiteRuns = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId'), limit: limit(data) }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    return context.db
      .select({
        id: suiteRun.id,
        status: suiteRun.status,
        trigger: suiteRun.trigger,
        totalCount: suiteRun.totalCount,
        passedCount: suiteRun.passedCount,
        failedCount: suiteRun.failedCount,
        errorCount: suiteRun.errorCount,
        startedAt: suiteRun.startedAt,
        finishedAt: suiteRun.finishedAt,
        environmentId: suiteRun.environmentId,
        environmentName: sql<string>`coalesce(${suiteRun.environmentName}, ${environment.name})`,
      })
      .from(suiteRun)
      .innerJoin(environment, eq(environment.id, suiteRun.environmentId))
      .where(eq(suiteRun.projectId, data.projectId))
      .orderBy(desc(suiteRun.startedAt))
      .limit(data.limit)
  })

/**
 * One suite and the runs inside it.
 *
 * Polled every couple of seconds while a suite is live, so the member listing
 * aggregates attempts in the same single query `listRuns` does rather than
 * fanning out per run.
 */
export const getSuiteRun = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ suiteRunId: str(data, 'suiteRunId') }))
  .handler(async ({ data, context }) => {
    const scoped = await loadSuiteRun(context.db, context.organizationId, data.suiteRunId)

    const [target] = await context.db
      .select({ name: environment.name, baseUrl: environment.baseUrl })
      .from(environment)
      .where(eq(environment.id, scoped.suiteRun.environmentId))
      .limit(1)

    const members = await context.db
      .select({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        intentId: run.intentId,
        intentTitle: intent.title,
        attemptCount: sql<number>`count(${attempt.id})`,
        durationMs: sql<number | null>`sum(${attempt.durationMs})`,
        // SQLite pairs bare columns with the row that produced `max()`, so
        // these describe the *latest* attempt of the run, not an arbitrary one.
        lastAttemptNumber: sql<number | null>`max(${attempt.attemptNumber})`,
        lastOutcome: attempt.outcome,
        lastErrorMessage: attempt.errorMessage,
      })
      .from(run)
      .innerJoin(intent, eq(intent.id, run.intentId))
      .leftJoin(attempt, eq(attempt.runId, run.id))
      .where(eq(run.suiteRunId, scoped.suiteRun.id))
      .groupBy(run.id)
      .orderBy(asc(run.startedAt), asc(run.id))

    return {
      suiteRun: scoped.suiteRun,
      environment: {
        id: scoped.suiteRun.environmentId,
        name: scoped.suiteRun.environmentName ?? target?.name ?? 'Unknown',
        baseUrl: scoped.suiteRun.baseUrl,
      },
      project: { id: scoped.project.id, name: scoped.project.name },
      members: members.map((member) => ({
        ...member,
        attemptCount: Number(member.attemptCount ?? 0),
        durationMs: member.durationMs === null ? null : Number(member.durationMs),
      })),
    }
  })
