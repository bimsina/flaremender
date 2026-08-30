import { createServerFn } from '@tanstack/react-start'
import { count, desc, eq, sql } from 'drizzle-orm'

import { attempt, intent, project, run } from '#/db/schema/app.ts'
import { orgMiddleware } from './auth.ts'

export const getOrgOverview = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .handler(async ({ context }) => {
    const [totals] = await context.db
      .select({
        projects: sql<number>`count(distinct ${project.id})`,
        tests: sql<number>`count(${intent.id})`,
        passing: sql<number>`sum(case when ${intent.status} = 'passing' then 1 else 0 end)`,
        failing: sql<number>`sum(case when ${intent.status} = 'failing' then 1 else 0 end)`,
        pending: sql<number>`sum(case when ${intent.status} in ('draft','ready') then 1 else 0 end)`,
      })
      .from(project)
      .leftJoin(intent, eq(intent.projectId, project.id))
      .where(eq(project.organizationId, context.organizationId))

    // M4: `healed` gets its own column here rather than riding with `passed`.
    const recentRuns = await context.db
      .select({
        id: run.id,
        status: run.status,
        attempt: attempt.attemptNumber,
        durationMs: attempt.durationMs,
        startedAt: run.startedAt,
        trigger: run.trigger,
        testCaseId: run.intentId,
        testCaseTitle: intent.title,
        projectId: project.id,
        projectName: project.name,
      })
      .from(run)
      .innerJoin(intent, eq(intent.id, run.intentId))
      .innerJoin(project, eq(project.id, run.projectId))
      .leftJoin(attempt, eq(attempt.runId, run.id))
      .where(eq(project.organizationId, context.organizationId))
      .orderBy(desc(run.startedAt))
      .limit(8)

    const [runTotals] = await context.db
      .select({ runs: count(run.id) })
      .from(run)
      .innerJoin(project, eq(project.id, run.projectId))
      .where(eq(project.organizationId, context.organizationId))

    return {
      projects: Number(totals?.projects ?? 0),
      tests: Number(totals?.tests ?? 0),
      passing: Number(totals?.passing ?? 0),
      failing: Number(totals?.failing ?? 0),
      pending: Number(totals?.pending ?? 0),
      runs: Number(runTotals?.runs ?? 0),
      recentRuns: recentRuns.map((row) => ({ ...row, attempt: row.attempt ?? 1 })),
    }
  })
