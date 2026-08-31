import { readJob } from './reports.server.ts'
import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, sql } from 'drizzle-orm'

import { generationJob, intent, run, scriptVersion } from '#/db/schema/app.ts'
import { user } from '#/db/schema/auth.ts'
import {
  appendScriptVersion,
  assertNoGenerationInFlight,
  createIntentRecord,
  deleteIntentRecord,
  loadCurrentVersion,
  queueGeneration,
  queueIntentRun,
  resolveTargetEnvironment,
  updateIntentRecord,
} from './actions.ts'
import { orgMiddleware } from './auth.ts'
import { assertProject, loadEnvironment, loadIntent, loadScriptVersion } from './scope.ts'
import { ValidationError, cron, has, optionalStr, str } from './validate.ts'

async function targetEnvironment(
  context: { db: Parameters<typeof loadEnvironment>[0]; organizationId: string },
  projectId: string,
  environmentId: string | null,
  purpose: string,
) {
  const named = environmentId
    ? (await loadEnvironment(context.db, context.organizationId, environmentId)).environment
    : null

  return resolveTargetEnvironment(context.db, projectId, named, purpose)
}

export const listIntents = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId') }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    const rows = await context.db
      .select({
        id: intent.id,
        projectId: intent.projectId,
        title: intent.title,
        description: intent.description,
        status: intent.status,
        readiness: intent.readiness,
        schedule: intent.schedule,
        lastRunId: intent.lastRunId,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
        currentVersion: scriptVersion.version,
        lastRunAt: run.startedAt,
        lastRunStatus: run.status,
        lastRunEnvironmentName: run.environmentName,
      })
      .from(intent)
      .leftJoin(scriptVersion, eq(scriptVersion.id, intent.currentVersionId))
      .leftJoin(run, eq(run.id, intent.lastRunId))
      .where(eq(intent.projectId, data.projectId))
      .orderBy(desc(intent.updatedAt))

    return rows.map((row) => ({ ...row, currentVersion: row.currentVersion ?? 0 }))
  })

export const getIntent = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ intentId: str(data, 'intentId') }))
  .handler(async ({ data, context }) => {
    const row = await loadIntent(context.db, context.organizationId, data.intentId)
    const version = await loadCurrentVersion(context.db, row.intent.currentVersionId)

    return {
      intent: {
        id: row.intent.id,
        projectId: row.intent.projectId,
        title: row.intent.title,
        description: row.intent.description,
        status: row.intent.status,
        readiness: row.intent.readiness,
        schedule: row.intent.schedule,
        lastRunId: row.intent.lastRunId,
        createdAt: row.intent.createdAt,
        updatedAt: row.intent.updatedAt,
      },
      currentVersion: version
        ? { id: version.id, version: version.version, code: version.code, author: version.author }
        : null,
      project: { id: row.project.id, name: row.project.name, slug: row.project.slug },
    }
  })

export const createIntent = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    title: str(data, 'title', { max: 120 }),
    description: str(data, 'description', { min: 10, max: 4000 }),
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    const created = await createIntentRecord(context.db, {
      projectId: data.projectId,
      title: data.title,
      description: data.description,
      createdBy: context.user.id,
    })

    return { id: created.id }
  })

export const updateIntent = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    intentId: str(data, 'intentId'),
    title: has(data, 'title') ? str(data, 'title', { max: 120 }) : undefined,
    description: has(data, 'description')
      ? str(data, 'description', { min: 10, max: 4000 })
      : undefined,
    schedule: has(data, 'schedule') ? cron(data, 'schedule') : undefined,
  }))
  .handler(async ({ data, context }) => {
    await loadIntent(context.db, context.organizationId, data.intentId)

    await updateIntentRecord(context.db, {
      intentId: data.intentId,
      title: data.title,
      description: data.description,
      schedule: data.schedule,
    })

    return { ok: true as const }
  })

export const deleteIntent = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ intentId: str(data, 'intentId') }))
  .handler(async ({ data, context }) => {
    await loadIntent(context.db, context.organizationId, data.intentId)
    return deleteIntentRecord(context.db, data.intentId)
  })

export const saveScript = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    intentId: str(data, 'intentId'),
    code: str(data, 'code', { min: 0, max: 100_000 }),
    note: optionalStr(data, 'note', 200),
  }))
  .handler(async ({ data, context }) => {
    const row = await loadIntent(context.db, context.organizationId, data.intentId)

    await assertNoGenerationInFlight(context.db, row.intent.id, row.intent.status)

    return appendScriptVersion(context.db, {
      intentId: row.intent.id,
      status: row.intent.status,
      code: data.code,
      author: 'user',
      note: data.note,
      createdBy: context.user.id,
    })
  })

export const listScriptVersions = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ intentId: str(data, 'intentId') }))
  .handler(async ({ data, context }) => {
    await loadIntent(context.db, context.organizationId, data.intentId)

    return context.db
      .select({
        id: scriptVersion.id,
        version: scriptVersion.version,
        author: scriptVersion.author,
        note: scriptVersion.note,
        createdByName: user.name,
        createdAt: scriptVersion.createdAt,
        codeLength: sql<number>`length(${scriptVersion.code})`,
      })
      .from(scriptVersion)
      .innerJoin(user, eq(user.id, scriptVersion.createdBy))
      .where(eq(scriptVersion.intentId, data.intentId))
      .orderBy(desc(scriptVersion.version))
  })

export const getScriptVersion = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ versionId: str(data, 'versionId') }))
  .handler(async ({ data, context }) => {
    const row = await loadScriptVersion(context.db, context.organizationId, data.versionId)

    return {
      id: row.version.id,
      intentId: row.version.intentId,
      version: row.version.version,
      code: row.version.code,
      author: row.version.author,
      note: row.version.note,
      createdAt: row.version.createdAt,
      isCurrent: row.intent.currentVersionId === row.version.id,
    }
  })

export const restoreScriptVersion = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ versionId: str(data, 'versionId') }))
  .handler(async ({ data, context }) => {
    const row = await loadScriptVersion(context.db, context.organizationId, data.versionId)

    await assertNoGenerationInFlight(context.db, row.intent.id, row.intent.status)

    return appendScriptVersion(context.db, {
      intentId: row.intent.id,
      status: row.intent.status,
      code: row.version.code,
      author: 'user',
      note: `Restored from v${row.version.version}`,
      createdBy: context.user.id,
    })
  })

export const runIntent = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    intentId: str(data, 'intentId'),
    scriptVersionId: has(data, 'scriptVersionId') ? str(data, 'scriptVersionId') : null,
    environmentId: has(data, 'environmentId') ? str(data, 'environmentId') : null,
  }))
  .handler(async ({ data, context }) => {
    const row = await loadIntent(context.db, context.organizationId, data.intentId)

    const target = await targetEnvironment(context, row.project.id, data.environmentId, 'run')

    const version = await loadCurrentVersion(
      context.db,
      data.scriptVersionId ?? row.intent.currentVersionId,
    )
    if (!version || version.intentId !== row.intent.id)
      throw new ValidationError('Save a script for this test first.')

    return queueIntentRun(context.db, {
      intentId: row.intent.id,
      projectId: row.project.id,
      organizationId: context.organizationId,
      environment: target,
      scriptVersionId: version.id,
    })
  })

export const generateIntentScript = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    intentId: str(data, 'intentId'),
    environmentId: has(data, 'environmentId') ? str(data, 'environmentId') : null,
  }))
  .handler(async ({ data, context }) => {
    const row = await loadIntent(context.db, context.organizationId, data.intentId)

    await assertNoGenerationInFlight(context.db, row.intent.id, row.intent.status)

    if (row.intent.description.trim().length < 10) {
      throw new ValidationError(
        'Describe what should happen, in a sentence or two, before generating a script.',
      )
    }

    const target = await targetEnvironment(context, row.project.id, data.environmentId, 'generate')

    return queueGeneration(context.db, {
      intentId: row.intent.id,
      projectId: row.project.id,
      organizationId: context.organizationId,
      environment: target,
      createdBy: context.user.id,
    })
  })

export const getIntentGeneration = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ intentId: str(data, 'intentId') }))
  .handler(async ({ data, context }) => {
    await loadIntent(context.db, context.organizationId, data.intentId)

    const [row] = await context.db
      .select({
        id: generationJob.id,
        status: generationJob.status,
        modelId: generationJob.modelId,
        scriptVersionId: generationJob.scriptVersionId,
        runId: generationJob.runId,
        turns: generationJob.turns,
        stuckReason: generationJob.stuckReason,
        startedAt: generationJob.startedAt,
        finishedAt: generationJob.finishedAt,
      })
      .from(generationJob)
      .where(eq(generationJob.intentId, data.intentId))
      .orderBy(desc(generationJob.startedAt))
      .limit(1)

    return row ?? null
  })

export const setTestReadiness = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    intentId: str(data, 'intentId'),
    versionId: str(data, 'versionId'),
    readiness: str(data, 'readiness'),
  }))
  .handler(async ({ data, context }) => {
    await loadIntent(context.db, context.organizationId, data.intentId)
    if (data.readiness !== 'ready' && data.readiness !== 'draft')
      throw new ValidationError('Invalid readiness.')
    const rows = await context.db
      .update(intent)
      .set({ readiness: data.readiness, status: data.readiness, lastRunId: null })
      .where(and(eq(intent.id, data.intentId), eq(intent.currentVersionId, data.versionId)))
      .returning({ id: intent.id })
    if (!rows.length)
      throw new ValidationError(
        'This script has changed. Review the latest version before marking it ready.',
      )
    return { ok: true }
  })

export const getJob = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ jobId: str(data, 'jobId') }))
  .handler(async ({ data, context }) => {
    return readJob(context.db, context.organizationId, data.jobId)
  })
