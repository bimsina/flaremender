import { createServerFn } from '@tanstack/react-start'
import { count, desc, eq, sql } from 'drizzle-orm'

import { attempt, environment, intent, project, run } from '#/db/schema/app.ts'
import { orgMiddleware } from './auth.ts'

export const getOrgOverview = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .handler(async ({ context }) => {
    const [totals] = await context.db
      .select({
        projects: sql<number>`count(distinct ${project.id})`,
        intents: sql<number>`count(${intent.id})`,
        passing: sql<number>`sum(case when ${intent.status} = 'passing' then 1 else 0 end)`,
        failing: sql<number>`sum(case when ${intent.status} = 'failing' then 1 else 0 end)`,
        pending: sql<number>`sum(case when ${intent.status} in ('draft','ready') then 1 else 0 end)`,
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
        intentId: run.intentId,
        intentTitle: intent.title,
        environmentName: environment.name,
        projectId: project.id,
        projectName: project.name,
      })
      .from(run)
      .innerJoin(intent, eq(intent.id, run.intentId))
      .innerJoin(project, eq(project.id, run.projectId))
      .innerJoin(environment, eq(environment.id, run.environmentId))
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
        runs: count(run.id),
        passed: sql<number>`sum(case when ${run.status} = 'passed' then 1 else 0 end)`,
        healed: sql<number>`sum(case when ${run.status} = 'healed' then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${run.status} in ('failed','error') then 1 else 0 end)`,
      })
      .from(run)
      .innerJoin(project, eq(project.id, run.projectId))
      .where(eq(project.organizationId, context.organizationId))

    return {
      projects: Number(totals?.projects ?? 0),
      intents: Number(totals?.intents ?? 0),
      passing: Number(totals?.passing ?? 0),
      failing: Number(totals?.failing ?? 0),
      pending: Number(totals?.pending ?? 0),
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
