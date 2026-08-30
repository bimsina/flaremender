import { createServerFn } from '@tanstack/react-start'
import { and, count, desc, eq, sql } from 'drizzle-orm'

import { project, testCase } from '#/db/schema/app.ts'
import { createId, slugify } from '#/lib/ids.ts'
import { AuthError, orgMiddleware } from './auth.ts'
import { ValidationError, optionalStr, str, url } from './validate.ts'

export const listProjects = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .handler(async ({ context }) => {
    const rows = await context.db
      .select({
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        baseUrl: project.baseUrl,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        testCount: count(testCase.id),
        failingCount: sql<number>`sum(case when ${testCase.status} = 'failing' then 1 else 0 end)`,
        passingCount: sql<number>`sum(case when ${testCase.status} = 'passing' then 1 else 0 end)`,
      })
      .from(project)
      .leftJoin(testCase, eq(testCase.projectId, project.id))
      .where(eq(project.organizationId, context.organizationId))
      .groupBy(project.id)
      .orderBy(desc(project.updatedAt))

    return rows.map((row) => ({
      ...row,
      failingCount: Number(row.failingCount ?? 0),
      passingCount: Number(row.passingCount ?? 0),
    }))
  })

export const getProject = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId') }))
  .handler(async ({ data, context }) => {
    const [row] = await context.db
      .select()
      .from(project)
      .where(
        and(eq(project.id, data.projectId), eq(project.organizationId, context.organizationId)),
      )
      .limit(1)

    if (!row) throw new AuthError('Project not found.', 404)
    return row
  })

export const createProject = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    name: str(data, 'name', { max: 80 }),
    description: optionalStr(data, 'description', 500),
    baseUrl: url(data, 'baseUrl'),
  }))
  .handler(async ({ data, context }) => {
    const base = slugify(data.name) || 'project'

    // Slugs are unique per organization, so walk until we find a free one.
    const taken = await context.db
      .select({ slug: project.slug })
      .from(project)
      .where(eq(project.organizationId, context.organizationId))
    const used = new Set(taken.map((row) => row.slug))

    let slug = base
    let suffix = 2
    while (used.has(slug)) slug = `${base}-${suffix++}`

    const row = {
      id: createId('prj'),
      organizationId: context.organizationId,
      name: data.name,
      slug,
      description: data.description,
      baseUrl: data.baseUrl,
      createdBy: context.user.id,
    }

    await context.db.insert(project).values(row)
    return { id: row.id, slug: row.slug }
  })

export const updateProject = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    name: str(data, 'name', { max: 80 }),
    description: optionalStr(data, 'description', 500),
    baseUrl: url(data, 'baseUrl'),
  }))
  .handler(async ({ data, context }) => {
    const result = await context.db
      .update(project)
      .set({ name: data.name, description: data.description, baseUrl: data.baseUrl })
      .where(
        and(eq(project.id, data.projectId), eq(project.organizationId, context.organizationId)),
      )
      .returning({ id: project.id })

    if (result.length === 0) throw new AuthError('Project not found.', 404)
    return { ok: true as const }
  })

export const deleteProject = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    /** Typed-name confirmation, matched server-side so the UI can't skip it. */
    confirmName: str(data, 'confirmName', { max: 80 }),
  }))
  .handler(async ({ data, context }) => {
    const [row] = await context.db
      .select({ name: project.name })
      .from(project)
      .where(
        and(eq(project.id, data.projectId), eq(project.organizationId, context.organizationId)),
      )
      .limit(1)

    if (!row) throw new AuthError('Project not found.', 404)
    if (row.name !== data.confirmName) {
      throw new ValidationError('The name you typed does not match this project.')
    }

    await context.db.delete(project).where(eq(project.id, data.projectId))
    return { ok: true as const }
  })
