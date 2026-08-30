import { createServerFn } from '@tanstack/react-start'
import { count, desc, eq, sql } from 'drizzle-orm'

import { project, testCase, testRun } from '#/db/schema/app.ts'
import { orgMiddleware } from './auth.ts'

export const getOrgOverview = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .handler(async ({ context }) => {
    const [totals] = await context.db
      .select({
        projects: sql<number>`count(distinct ${project.id})`,
        tests: sql<number>`count(${testCase.id})`,
        passing: sql<number>`sum(case when ${testCase.status} = 'passing' then 1 else 0 end)`,
        failing: sql<number>`sum(case when ${testCase.status} = 'failing' then 1 else 0 end)`,
        pending: sql<number>`sum(case when ${testCase.status} in ('draft','ready','generating') then 1 else 0 end)`,
      })
      .from(project)
      .leftJoin(testCase, eq(testCase.projectId, project.id))
      .where(eq(project.organizationId, context.organizationId))

    const recentRuns = await context.db
      .select({
        id: testRun.id,
        status: testRun.status,
        attempt: testRun.attempt,
        durationMs: testRun.durationMs,
        startedAt: testRun.startedAt,
        trigger: testRun.trigger,
        testCaseId: testRun.testCaseId,
        testCaseTitle: testCase.title,
        projectId: project.id,
        projectName: project.name,
      })
      .from(testRun)
      .innerJoin(testCase, eq(testCase.id, testRun.testCaseId))
      .innerJoin(project, eq(project.id, testRun.projectId))
      .where(eq(project.organizationId, context.organizationId))
      .orderBy(desc(testRun.startedAt))
      .limit(8)

    const [runTotals] = await context.db
      .select({ runs: count(testRun.id) })
      .from(testRun)
      .innerJoin(project, eq(project.id, testRun.projectId))
      .where(eq(project.organizationId, context.organizationId))

    return {
      projects: Number(totals?.projects ?? 0),
      tests: Number(totals?.tests ?? 0),
      passing: Number(totals?.passing ?? 0),
      failing: Number(totals?.failing ?? 0),
      pending: Number(totals?.pending ?? 0),
      runs: Number(runTotals?.runs ?? 0),
      recentRuns,
    }
  })
