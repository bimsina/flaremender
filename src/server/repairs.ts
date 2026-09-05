/**
 * Repairs and the heal policy: what the agent may do when a ready test fails, and
 * what a person does with a repair that verified.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, eq } from 'drizzle-orm'

import {
  HEAL_POLICIES,
  HEAL_POLICY_CHOICES,
  generationJob,
  intent,
  organizationSettings,
  project,
  scriptVersion,
} from '#/db/schema/app.ts'
import { queueRepair } from './actions.ts'
import { AuthError } from './auth-error.ts'
import { orgMiddleware } from './auth.ts'
import { resolveHealPolicy, resolveProjectHealPolicy } from './heal-policy.ts'
import { assertOrganizationManager } from './membership.ts'
import { assertProject, loadIntent, loadRun } from './scope.ts'
import { ValidationError, oneOf, str } from './validate.ts'

export const repairRun = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ runId: str(data, 'runId') }))
  .handler(async ({ data, context }) => {
    const scoped = await loadRun(context.db, context.organizationId, data.runId)

    if (scoped.run.status !== 'failed') {
      throw new ValidationError(
        scoped.run.status === 'error'
          ? 'This run stopped before the test could be judged, so there is no failing step to repair. Fix the environment and run it again.'
          : 'Only a failed run can be repaired.',
      )
    }

    const [test] = await context.db
      .select({ id: intent.id, currentVersionId: intent.currentVersionId })
      .from(intent)
      .where(eq(intent.id, scoped.run.intentId))
      .limit(1)
    if (!test) throw new AuthError('Test not found.', 404)

    if (test.currentVersionId !== scoped.run.scriptVersionId) {
      throw new ValidationError(
        'This run used an older version of the script. Run the current version first, then repair that.',
      )
    }

    const queued = await queueRepair(context.db, {
      runId: scoped.run.id,
      intentId: test.id,
      projectId: scoped.project.id,
      environmentId: scoped.run.environmentId,
      organizationId: context.organizationId,
      createdBy: context.user.id,
    })

    return { jobId: queued.jobId, intentId: test.id }
  })

export const getPendingRepair = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ intentId: str(data, 'intentId') }))
  .handler(async ({ data, context }) => {
    const row = await loadIntent(context.db, context.organizationId, data.intentId)
    if (!row.intent.pendingRepairVersionId) return null

    const [version] = await context.db
      .select({ id: scriptVersion.id, version: scriptVersion.version, note: scriptVersion.note })
      .from(scriptVersion)
      .where(eq(scriptVersion.id, row.intent.pendingRepairVersionId))
      .limit(1)
    if (!version) return null

    const [job] = await context.db
      .select({
        id: generationJob.id,
        runId: generationJob.runId,
        sourceRunId: generationJob.sourceRunId,
      })
      .from(generationJob)
      .where(eq(generationJob.scriptVersionId, version.id))
      .limit(1)

    return {
      versionId: version.id,
      version: version.version,
      note: version.note,
      jobId: job?.id ?? null,
      verificationRunId: job?.runId ?? null,
      sourceRunId: job?.sourceRunId ?? null,
    }
  })

export const acceptRepair = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    intentId: str(data, 'intentId'),
    versionId: str(data, 'versionId'),
  }))
  .handler(async ({ data, context }) => {
    const row = await loadIntent(context.db, context.organizationId, data.intentId)
    if (row.intent.pendingRepairVersionId !== data.versionId) {
      throw new ValidationError('That repair is no longer pending.')
    }

    await context.db
      .update(intent)
      .set({
        currentVersionId: data.versionId,
        readiness: 'ready',
        status: 'ready',
        lastRunId: null,
        pendingRepairVersionId: null,
      })
      .where(and(eq(intent.id, row.intent.id), eq(intent.pendingRepairVersionId, data.versionId)))

    return { ok: true as const }
  })

export const dismissRepair = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    intentId: str(data, 'intentId'),
    versionId: str(data, 'versionId'),
  }))
  .handler(async ({ data, context }) => {
    const row = await loadIntent(context.db, context.organizationId, data.intentId)

    await context.db
      .update(intent)
      .set({ pendingRepairVersionId: null })
      .where(and(eq(intent.id, row.intent.id), eq(intent.pendingRepairVersionId, data.versionId)))

    return { ok: true as const }
  })

export const setIntentHealPolicy = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    intentId: str(data, 'intentId'),
    healPolicy: oneOf(data, 'healPolicy', HEAL_POLICY_CHOICES),
  }))
  .handler(async ({ data, context }) => {
    const row = await loadIntent(context.db, context.organizationId, data.intentId)

    await context.db
      .update(intent)
      .set({ healPolicy: data.healPolicy })
      .where(eq(intent.id, row.intent.id))

    return resolveHealPolicy(context.db, row.intent.id)
  })

export const setProjectHealPolicy = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    healPolicy: oneOf(data, 'healPolicy', HEAL_POLICY_CHOICES),
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    await context.db
      .update(project)
      .set({ healPolicy: data.healPolicy })
      .where(eq(project.id, data.projectId))

    return resolveProjectHealPolicy(context.db, data.projectId)
  })

export const getOrganizationSettings = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .handler(async ({ context }) => {
    const [row] = await context.db
      .select({ healPolicy: organizationSettings.healPolicy })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, context.organizationId))
      .limit(1)

    return { healPolicy: row?.healPolicy ?? ('off' as const) }
  })

export const setOrganizationHealPolicy = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ healPolicy: oneOf(data, 'healPolicy', HEAL_POLICIES) }))
  .handler(async ({ data, context }) => {
    await assertOrganizationManager(context.db, context.organizationId, context.user.id)

    await context.db
      .insert(organizationSettings)
      .values({
        organizationId: context.organizationId,
        healPolicy: data.healPolicy,
        updatedBy: context.user.id,
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: { healPolicy: data.healPolicy, updatedBy: context.user.id, updatedAt: new Date() },
      })

    return { healPolicy: data.healPolicy }
  })
