import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, sql } from 'drizzle-orm'

import {
  RUN_STATUSES,
  RUN_TRIGGERS,
  attempt,
  environment,
  intent,
  run,
  scriptVersion,
} from '#/db/schema/app.ts'
import { runIdFromKey } from '#/engine/runner/artifacts.ts'
import { readRunReport } from './reports.server.ts'
import { orgMiddleware } from './auth.ts'
import { assertProject, loadIntent, loadRun } from './scope.ts'
import { SIGNATURE_TTL_SECONDS, signArtifactKey } from './sign.ts'
import { ValidationError, has, oneOf, str } from './validate.ts'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

function limit(data: unknown): number {
  if (!has(data, 'limit')) return DEFAULT_LIMIT

  const value = (data as Record<string, unknown>).limit
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new ValidationError(`"limit" must be a whole number between 1 and ${MAX_LIMIT}.`)
  }
  return parsed
}

export const listRuns = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ intentId: str(data, 'intentId'), limit: limit(data) }))
  .handler(async ({ data, context }) => {
    await loadIntent(context.db, context.organizationId, data.intentId)

    const rows = await context.db
      .select({
        id: run.id,
        status: run.status,
        trigger: run.trigger,
        purpose: run.purpose,
        suiteRunId: run.suiteRunId,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        environmentId: run.environmentId,
        environmentName: sql<string>`coalesce(${run.environmentName}, ${environment.name})`,
        scriptVersionId: run.scriptVersionId,
        version: scriptVersion.version,
        attemptCount: sql<number>`count(${attempt.id})`,
        durationMs: sql<number | null>`sum(${attempt.durationMs})`,
        lastAttemptNumber: sql<number | null>`max(${attempt.attemptNumber})`,
        lastOutcome: attempt.outcome,
        lastErrorMessage: attempt.errorMessage,
      })
      .from(run)
      .innerJoin(environment, eq(environment.id, run.environmentId))
      .innerJoin(scriptVersion, eq(scriptVersion.id, run.scriptVersionId))
      .leftJoin(attempt, eq(attempt.runId, run.id))
      .where(eq(run.intentId, data.intentId))
      .groupBy(run.id)
      .orderBy(desc(run.startedAt))
      .limit(data.limit)

    return rows.map((row) => ({
      ...row,
      attemptCount: Number(row.attemptCount ?? 0),
      durationMs: row.durationMs === null ? null : Number(row.durationMs),
    }))
  })

export const listProjectRuns = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    status: has(data, 'status') ? oneOf(data, 'status', RUN_STATUSES) : null,
    environmentId: has(data, 'environmentId') ? str(data, 'environmentId') : null,
    trigger: has(data, 'trigger') ? oneOf(data, 'trigger', RUN_TRIGGERS) : null,
    limit: limit(data),
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    const filters = [eq(run.projectId, data.projectId)]
    if (data.status) filters.push(eq(run.status, data.status))
    if (data.environmentId) filters.push(eq(run.environmentId, data.environmentId))
    if (data.trigger) filters.push(eq(run.trigger, data.trigger))

    const rows = await context.db
      .select({
        id: run.id,
        status: run.status,
        trigger: run.trigger,
        purpose: run.purpose,
        suiteRunId: run.suiteRunId,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        intentId: run.intentId,
        intentTitle: intent.title,
        environmentId: run.environmentId,
        environmentName: sql<string>`coalesce(${run.environmentName}, ${environment.name})`,
        scriptVersionId: run.scriptVersionId,
        version: scriptVersion.version,
        attemptCount: sql<number>`count(${attempt.id})`,
        durationMs: sql<number | null>`sum(${attempt.durationMs})`,
        lastAttemptNumber: sql<number | null>`max(${attempt.attemptNumber})`,
        lastOutcome: attempt.outcome,
        lastErrorMessage: attempt.errorMessage,
      })
      .from(run)
      .innerJoin(intent, eq(intent.id, run.intentId))
      .innerJoin(environment, eq(environment.id, run.environmentId))
      .innerJoin(scriptVersion, eq(scriptVersion.id, run.scriptVersionId))
      .leftJoin(attempt, eq(attempt.runId, run.id))
      .where(and(...filters))
      .groupBy(run.id)
      .orderBy(desc(run.startedAt))
      .limit(data.limit)

    return rows.map((row) => ({
      ...row,
      attemptCount: Number(row.attemptCount ?? 0),
      durationMs: row.durationMs === null ? null : Number(row.durationMs),
    }))
  })

export const getRun = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ runId: str(data, 'runId') }))
  .handler(async ({ data, context }) => {
    return readRunReport(context.db, context.organizationId, data.runId)
  })

function assertArtifactBelongsToRun(
  scopedRun: { id: string; artifactPrefix: string | null },
  key: string,
): void {
  if (
    !scopedRun.artifactPrefix ||
    !key.startsWith(scopedRun.artifactPrefix) ||
    runIdFromKey(key) !== scopedRun.id
  ) {
    throw new ValidationError('That artifact does not belong to this run.')
  }
}

function artifactPath(key: string): string {
  return `/api/artifacts/${key.split('/').map(encodeURIComponent).join('/')}`
}

export const getArtifactUrl = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    runId: str(data, 'runId'),
    key: str(data, 'key', { max: 512 }),
  }))
  .handler(async ({ data, context }) => {
    const scoped = await loadRun(context.db, context.organizationId, data.runId)
    assertArtifactBelongsToRun(scoped.run, data.key)

    return { url: artifactPath(data.key) }
  })

export const getSignedArtifactUrl = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    runId: str(data, 'runId'),
    key: str(data, 'key', { max: 512 }),
  }))
  .handler(async ({ data, context }) => {
    const scoped = await loadRun(context.db, context.organizationId, data.runId)
    assertArtifactBelongsToRun(scoped.run, data.key)

    const exp = Math.floor(Date.now() / 1000) + SIGNATURE_TTL_SECONDS
    const sig = await signArtifactKey(data.key, exp)

    return {
      url: `${artifactPath(data.key)}?exp=${exp}&sig=${encodeURIComponent(sig)}`,
      expiresAt: exp * 1000,
    }
  })
