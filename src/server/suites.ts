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
import { env } from 'cloudflare:workers'
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm'

import { attempt, environment, intent, run, suiteRun } from '#/db/schema/app.ts'
import { createId } from '#/lib/ids.ts'
import { orgMiddleware } from './auth.ts'
import { assertProject, loadDefaultEnvironment, loadEnvironment, loadSuiteRun } from './scope.ts'
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

    const target = data.environmentId
      ? (await loadEnvironment(context.db, context.organizationId, data.environmentId)).environment
      : await loadDefaultEnvironment(context.db, project.id)

    if (!target) {
      throw new ValidationError('This project has no environment to run against.')
    }
    // A named environment from another project would silently retarget the suite.
    if (target.projectId !== project.id) {
      throw new ValidationError('That environment belongs to a different project.')
    }

    const [runnable] = await context.db
      .select({ count: sql<number>`count(*)` })
      .from(intent)
      .where(and(eq(intent.projectId, project.id), isNotNull(intent.currentVersionId)))

    if (Number(runnable?.count ?? 0) === 0) {
      throw new ValidationError('No intent in this project has a saved script yet.')
    }

    const row = {
      id: createId('srun'),
      projectId: project.id,
      environmentId: target.id,
      status: 'queued' as const,
      trigger: 'manual' as const,
      createdBy: context.user.id,
      startedAt: new Date(),
    }

    await context.db.insert(suiteRun).values(row)

    // The organization comes from the session, not from the row: the Workflow
    // re-checks it, and a value the client could influence would make that
    // check meaningless.
    await env.SUITE_WORKFLOW.create({
      id: row.id,
      params: { suiteRunId: row.id, organizationId: context.organizationId },
    })

    return { suiteRunId: row.id, environmentId: target.id, status: row.status }
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
        environmentName: environment.name,
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
        name: target?.name ?? 'Unknown',
        baseUrl: target?.baseUrl ?? null,
      },
      project: { id: scoped.project.id, name: scoped.project.name },
      members: members.map((member) => ({
        ...member,
        attemptCount: Number(member.attemptCount ?? 0),
        durationMs: member.durationMs === null ? null : Number(member.durationMs),
      })),
    }
  })
