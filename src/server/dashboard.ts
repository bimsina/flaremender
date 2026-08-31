import { createServerFn } from '@tanstack/react-start'
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm'

import { attempt, environment, intent, project, run, scriptVersion } from '#/db/schema/app.ts'
import { orgMiddleware } from './auth.ts'
import { assertProject } from './scope.ts'
import { has, str } from './validate.ts'

export const getOrgOverview = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .handler(async ({ context }) => {
    const [totals] = await context.db
      .select({
        projects: sql<number>`count(distinct ${project.id})`,
        // Proposals are excluded from every one of these on purpose: they are
        // suggestions nobody has agreed to, and counting them here would make
        // an exploration look like the organization suddenly grew twelve tests.
        intents: sql<number>`sum(case when ${intent.id} is not null and ${intent.status} <> 'proposed' then 1 else 0 end)`,
        passing: sql<number>`sum(case when ${intent.status} = 'passing' then 1 else 0 end)`,
        failing: sql<number>`sum(case when ${intent.status} = 'failing' then 1 else 0 end)`,
        // Everything that has not yet been decided by a run, which is what
        // `'generating'` is too — an intent mid-generation has no verdict.
        pending: sql<number>`sum(case when ${intent.status} in ('draft','generating','ready') then 1 else 0 end)`,
        /** Awaiting review. Reported separately, never folded into the total. */
        proposed: sql<number>`sum(case when ${intent.status} = 'proposed' then 1 else 0 end)`,
      })
      .from(project)
      .leftJoin(intent, eq(intent.projectId, project.id))
      .where(eq(project.organizationId, context.organizationId))

    const recentRuns = await context.db
      .select({
        id: run.id,
        status: run.status,
        attemptCount: sql<number>`count(${attempt.id})`,
        durationMs: sql<number | null>`sum(${attempt.durationMs})`,
        startedAt: run.startedAt,
        trigger: run.trigger,
        purpose: run.purpose,
        version: scriptVersion.version,
        intentId: run.intentId,
        intentTitle: intent.title,
        environmentName: sql<string>`coalesce(${run.environmentName}, ${environment.name})`,
        projectId: project.id,
        projectName: project.name,
      })
      .from(run)
      .innerJoin(intent, eq(intent.id, run.intentId))
      .innerJoin(project, eq(project.id, run.projectId))
      .innerJoin(environment, eq(environment.id, run.environmentId))
      .innerJoin(scriptVersion, eq(scriptVersion.id, run.scriptVersionId))
      .leftJoin(attempt, eq(attempt.runId, run.id))
      .where(eq(project.organizationId, context.organizationId))
      .groupBy(run.id)
      .orderBy(desc(run.startedAt))
      .limit(8)

    // `healed` gets its own column rather than riding along with `passed`: a
    // run that only went green after a repair reads differently, and collapsing
    // the two would hide exactly the signal the healing loop exists to produce.
    const [runTotals] = await context.db
      .select({
        runs: sql<number>`sum(case when ${run.status} in ('passed','healed','failed','error') then 1 else 0 end)`,
        passed: sql<number>`sum(case when ${run.status} = 'passed' then 1 else 0 end)`,
        healed: sql<number>`sum(case when ${run.status} = 'healed' then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${run.status} in ('failed','error') then 1 else 0 end)`,
      })
      .from(run)
      .innerJoin(project, eq(project.id, run.projectId))
      .where(and(eq(project.organizationId, context.organizationId), eq(run.purpose, 'regression')))

    return {
      projects: Number(totals?.projects ?? 0),
      intents: Number(totals?.intents ?? 0),
      passing: Number(totals?.passing ?? 0),
      failing: Number(totals?.failing ?? 0),
      pending: Number(totals?.pending ?? 0),
      proposed: Number(totals?.proposed ?? 0),
      runs: Number(runTotals?.runs ?? 0),
      passedRuns: Number(runTotals?.passed ?? 0),
      healedRuns: Number(runTotals?.healed ?? 0),
      failedRuns: Number(runTotals?.failed ?? 0),
      recentRuns: recentRuns.map((row) => ({
        ...row,
        attemptCount: Number(row.attemptCount ?? 0),
        durationMs: row.durationMs === null ? null : Number(row.durationMs),
      })),
    }
  })

/** Two weeks including today — enough to see a regression start, short enough to read. */
const TREND_DAYS = 14

/** `2026-08-30`, in UTC, for a timestamp in milliseconds. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Runs per UTC day for the last fortnight, one column per verdict.
 *
 * Grouped in SQLite rather than in JavaScript — `date(started_at/1000,
 * 'unixepoch')` turns the stored epoch-milliseconds column into the same day
 * string the client renders, so a fortnight of runs costs one row per day
 * instead of one row per run.
 *
 * Days nothing ran are filled in here rather than left out. A trend with holes
 * in it is not a trend, and the component should not have to do calendar
 * arithmetic to find out which days are missing.
 *
 * `projectId` is optional and narrows the same window to one project, so the
 * dashboard and a project's Runs tab draw the same chart from one query. It is
 * still org-scoped either way: the join to `project` is what does the scoping,
 * and the project id is checked against the organization before it is used.
 */
export const getDailyRunCounts = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: has(data, 'projectId') ? str(data, 'projectId') : null,
  }))
  .handler(async ({ data, context }) => {
    if (data.projectId) {
      await assertProject(context.db, context.organizationId, data.projectId)
    }

    // Midnight UTC, today, minus thirteen days: the first day of the window.
    const startOfToday = Date.parse(`${utcDay(Date.now())}T00:00:00.000Z`)
    const since = startOfToday - (TREND_DAYS - 1) * 86_400_000

    const filters = [
      eq(run.purpose, 'regression'),
      eq(project.organizationId, context.organizationId),
      gte(run.startedAt, new Date(since)),
    ]
    if (data.projectId) filters.push(eq(run.projectId, data.projectId))

    const rows = await context.db
      .select({
        day: sql<string>`date(${run.startedAt} / 1000, 'unixepoch')`,
        // Every verdict gets its own column. `healed` is green — it went green
        // in the end — and `error` is not `failed`; collapsing either pair
        // would hide the two things a trend is read for, which kind of green a
        // day was and whether the reds were assertions or the harness falling
        // over.
        passed: sql<number>`sum(case when ${run.status} = 'passed' then 1 else 0 end)`,
        healed: sql<number>`sum(case when ${run.status} = 'healed' then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${run.status} = 'failed' then 1 else 0 end)`,
        error: sql<number>`sum(case when ${run.status} = 'error' then 1 else 0 end)`,
        // Anything that has not reached a verdict yet: neither green nor red,
        // and a bar that moved twice would be worse than one grey segment.
        running: sql<number>`sum(case when ${run.status} in ('queued','running') then 1 else 0 end)`,
        total: count(run.id),
      })
      .from(run)
      .innerJoin(project, eq(project.id, run.projectId))
      .where(and(...filters))
      .groupBy(sql`date(${run.startedAt} / 1000, 'unixepoch')`)

    const byDay = new Map(rows.map((row) => [row.day, row]))

    return Array.from({ length: TREND_DAYS }, (_unused, index) => {
      const day = utcDay(since + index * 86_400_000)
      const row = byDay.get(day)
      return {
        day,
        passed: Number(row?.passed ?? 0),
        healed: Number(row?.healed ?? 0),
        failed: Number(row?.failed ?? 0),
        error: Number(row?.error ?? 0),
        running: Number(row?.running ?? 0),
        total: Number(row?.total ?? 0),
      }
    })
  })

export const getProjectOverview = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    environmentId: has(data, 'environmentId') ? str(data, 'environmentId') : null,
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)
    const filters = [eq(run.projectId, data.projectId), eq(run.purpose, 'regression')]
    if (data.environmentId) filters.push(eq(run.environmentId, data.environmentId))
    const readRows = (failuresOnly: boolean) =>
      context.db
        .select({
          id: run.id,
          status: run.status,
          startedAt: run.startedAt,
          intentId: intent.id,
          title: intent.title,
          scriptVersionId: run.scriptVersionId,
          version: scriptVersion.version,
          environmentName: sql<string>`coalesce(${run.environmentName}, ${environment.name})`,
          errorMessage: run.errorMessage,
        })
        .from(run)
        .innerJoin(intent, eq(intent.id, run.intentId))
        .innerJoin(scriptVersion, eq(scriptVersion.id, run.scriptVersionId))
        .innerJoin(environment, eq(environment.id, run.environmentId))
        .where(and(...filters, failuresOnly ? inArray(run.status, ['failed', 'error']) : undefined))
        .orderBy(desc(run.startedAt), desc(run.id))
        .limit(failuresOnly ? 5 : 8)
    const [recent, failures] = await Promise.all([readRows(false), readRows(true)])
    return { recent, failures }
  })
