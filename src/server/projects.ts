import { createServerFn } from '@tanstack/react-start'
import { and, count, desc, eq, sql } from 'drizzle-orm'

import { environment, intent, project } from '#/db/schema/app.ts'
import { createId, slugify } from '#/lib/ids.ts'
import { AuthError, orgMiddleware } from './auth.ts'
import { ValidationError, optionalStr, str, url } from './validate.ts'

/**
 * M4: base URLs moved to `environment`, but the UI still speaks in terms of a
 * single project URL. Until the environments UI lands, every project has
 * exactly one environment ("Production") and these functions read and write it
 * as if it were still a project column.
 */
const defaultEnvironment = and(
  eq(environment.projectId, project.id),
  eq(environment.isDefault, true),
)

export const listProjects = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .handler(async ({ context }) => {
    const rows = await context.db
      .select({
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        baseUrl: environment.baseUrl,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        testCount: count(intent.id),
        failingCount: sql<number>`sum(case when ${intent.status} = 'failing' then 1 else 0 end)`,
        passingCount: sql<number>`sum(case when ${intent.status} = 'passing' then 1 else 0 end)`,
      })
      .from(project)
      .leftJoin(environment, defaultEnvironment)
      .leftJoin(intent, eq(intent.projectId, project.id))
      .where(eq(project.organizationId, context.organizationId))
      .groupBy(project.id)
      .orderBy(desc(project.updatedAt))

    return rows.map((row) => ({
      ...row,
      baseUrl: row.baseUrl ?? '—',
      failingCount: Number(row.failingCount ?? 0),
      passingCount: Number(row.passingCount ?? 0),
    }))
  })

export const getProject = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId') }))
  .handler(async ({ data, context }) => {
    const [row] = await context.db
      .select({ project, baseUrl: environment.baseUrl })
      .from(project)
      .leftJoin(environment, defaultEnvironment)
      .where(
        and(eq(project.id, data.projectId), eq(project.organizationId, context.organizationId)),
      )
      .limit(1)

    if (!row) throw new AuthError('Project not found.', 404)
    return { ...row.project, baseUrl: row.baseUrl ?? '—' }
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
      createdBy: context.user.id,
    }

    // D1 has no interactive transactions; a batch is the atomic unit.
    await context.db.batch([
      context.db.insert(project).values(row),
      context.db.insert(environment).values({
        id: createId('env'),
        projectId: row.id,
        name: 'Production',
        baseUrl: data.baseUrl,
        isDefault: true,
        createdBy: context.user.id,
      }),
    ])

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
      .set({ name: data.name, description: data.description })
      .where(
        and(eq(project.id, data.projectId), eq(project.organizationId, context.organizationId)),
      )
      .returning({ id: project.id })

    if (result.length === 0) throw new AuthError('Project not found.', 404)

    // M4: the environments UI edits this directly; the project form is a proxy.
    await context.db
      .update(environment)
      .set({ baseUrl: data.baseUrl })
      .where(and(eq(environment.projectId, data.projectId), eq(environment.isDefault, true)))

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
