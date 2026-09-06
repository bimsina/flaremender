import { createServerFn } from '@tanstack/react-start'
import { desc, eq } from 'drizzle-orm'

import { intent, project, run } from '#/db/schema/app.ts'
import { orgMiddleware } from '#/server/auth/auth.ts'

/** A compact organization-scoped index for the command palette. */
export const getQuickSearchResources = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .handler(async ({ context }) => {
    const [projects, tests, runs] = await Promise.all([
      context.db
        .select({ id: project.id, name: project.name })
        .from(project)
        .where(eq(project.organizationId, context.organizationId))
        .orderBy(project.name),
      context.db
        .select({
          id: intent.id,
          title: intent.title,
          projectId: project.id,
          projectName: project.name,
        })
        .from(intent)
        .innerJoin(project, eq(project.id, intent.projectId))
        .where(eq(project.organizationId, context.organizationId))
        .orderBy(desc(intent.updatedAt))
        .limit(100),
      context.db
        .select({
          id: run.id,
          status: run.status,
          startedAt: run.startedAt,
          intentTitle: intent.title,
          projectId: project.id,
          projectName: project.name,
        })
        .from(run)
        .innerJoin(intent, eq(intent.id, run.intentId))
        .innerJoin(project, eq(project.id, run.projectId))
        .where(eq(project.organizationId, context.organizationId))
        .orderBy(desc(run.startedAt))
        .limit(30),
    ])

    return {
      projects,
      tests: tests.filter((test) => test.title.trim().length > 0),
      runs: runs.map((row) => ({
        ...row,
        status: row.status === 'healed' ? ('passed' as const) : row.status,
      })),
    }
  })
