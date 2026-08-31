import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { allowedModel, environment, instanceSettings, intent, project } from '#/db/schema/app.ts'
import { createId, slugify } from '#/lib/ids.ts'
import { DEFAULT_MODEL_ID, parseModelId } from '#/lib/models.ts'
import { AuthError, orgMiddleware } from './auth.ts'
import { ValidationError, optionalStr, str, url } from './validate.ts'

const defaultEnvironment = and(
  eq(environment.projectId, project.id),
  eq(environment.isDefault, true),
)

function toDefaultEnvironment(row: {
  environmentId: string | null
  environmentName: string | null
  baseUrl: string | null
}) {
  return row.environmentId === null || row.environmentName === null || row.baseUrl === null
    ? null
    : { id: row.environmentId, name: row.environmentName, baseUrl: row.baseUrl }
}

async function resolveEffectiveModel(db: Db, projectModelId: string | null) {
  const [settings] = await db
    .select({ defaultModelId: instanceSettings.defaultModelId })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 'default'))
    .limit(1)

  const origin = projectModelId ? 'project' : settings?.defaultModelId ? 'instance' : 'fallback'
  const modelId = projectModelId ?? settings?.defaultModelId ?? DEFAULT_MODEL_ID

  const [named] = await db
    .select({ displayName: allowedModel.displayName })
    .from(allowedModel)
    .where(eq(allowedModel.modelId, modelId))
    .limit(1)

  return {
    modelId,
    origin,
    displayName: named?.displayName ?? parseModelId(modelId)?.slug ?? modelId,
  }
}

export const listProjects = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .handler(async ({ context }) => {
    const rows = await context.db
      .select({
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        environmentId: environment.id,
        environmentName: environment.name,
        baseUrl: environment.baseUrl,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        intentCount: sql<number>`sum(case when ${intent.id} is not null and ${intent.status} <> 'proposed' then 1 else 0 end)`,
        proposedCount: sql<number>`sum(case when ${intent.status} = 'proposed' then 1 else 0 end)`,
        failingCount: sql<number>`sum(case when ${intent.status} = 'failing' then 1 else 0 end)`,
        passingCount: sql<number>`sum(case when ${intent.status} = 'passing' then 1 else 0 end)`,
      })
      .from(project)
      .leftJoin(environment, defaultEnvironment)
      .leftJoin(intent, eq(intent.projectId, project.id))
      .where(eq(project.organizationId, context.organizationId))
      .groupBy(project.id, environment.id)
      .orderBy(desc(project.updatedAt))

    return rows.map(({ environmentId, environmentName, baseUrl, ...row }) => ({
      ...row,
      defaultEnvironment: toDefaultEnvironment({ environmentId, environmentName, baseUrl }),
      intentCount: Number(row.intentCount ?? 0),
      proposedCount: Number(row.proposedCount ?? 0),
      failingCount: Number(row.failingCount ?? 0),
      passingCount: Number(row.passingCount ?? 0),
    }))
  })

export const getProject = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId') }))
  .handler(async ({ data, context }) => {
    const [row] = await context.db
      .select({
        project,
        environmentId: environment.id,
        environmentName: environment.name,
        baseUrl: environment.baseUrl,
      })
      .from(project)
      .leftJoin(environment, defaultEnvironment)
      .where(
        and(eq(project.id, data.projectId), eq(project.organizationId, context.organizationId)),
      )
      .limit(1)

    if (!row) throw new AuthError('Project not found.', 404)

    return {
      ...row.project,
      defaultEnvironment: toDefaultEnvironment(row),
      effectiveModel: await resolveEffectiveModel(context.db, row.project.modelId),
    }
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
    return { ok: true as const }
  })

export const setProjectModel = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    modelId: optionalStr(data, 'modelId', 200),
  }))
  .handler(async ({ data, context }) => {
    if (data.modelId !== null) {
      const [model] = await context.db
        .select({ id: allowedModel.id })
        .from(allowedModel)
        .where(eq(allowedModel.modelId, data.modelId))
        .limit(1)

      if (!model) {
        throw new ValidationError('That model is not on this instance’s allowlist.')
      }
    }

    const result = await context.db
      .update(project)
      .set({ modelId: data.modelId })
      .where(
        and(eq(project.id, data.projectId), eq(project.organizationId, context.organizationId)),
      )
      .returning({ id: project.id })

    if (result.length === 0) throw new AuthError('Project not found.', 404)
    return { modelId: data.modelId }
  })

export const deleteProject = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
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
