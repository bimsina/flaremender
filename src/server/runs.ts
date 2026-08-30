/**
 * Reading run history.
 *
 * A run is one execution request; the attempts inside it are what actually
 * touched a browser. Today every run has exactly one attempt, but the listing
 * already aggregates so the healing loop can append attempts without a rewrite.
 */
import { createServerFn } from '@tanstack/react-start'
import { asc, desc, eq, sql } from 'drizzle-orm'

import { attempt, environment, intent, run, scriptVersion } from '#/db/schema/app.ts'
import { runIdFromKey } from '#/engine/runner/artifacts.ts'
import { orgMiddleware } from './auth.ts'
import { loadIntent, loadRun } from './scope.ts'
import { ValidationError, has, str } from './validate.ts'

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
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        environmentId: run.environmentId,
        environmentName: environment.name,
        scriptVersionId: run.scriptVersionId,
        version: scriptVersion.version,
        attemptCount: sql<number>`count(${attempt.id})`,
        durationMs: sql<number | null>`sum(${attempt.durationMs})`,
        // SQLite pairs bare columns with the row that produced `max()`, so
        // these describe the *latest* attempt of the run, not an arbitrary one.
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

export const getRun = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ runId: str(data, 'runId') }))
  .handler(async ({ data, context }) => {
    const scoped = await loadRun(context.db, context.organizationId, data.runId)

    const [row] = await context.db
      .select({
        run,
        environmentName: environment.name,
        baseUrl: environment.baseUrl,
        version: scriptVersion.version,
        intentId: intent.id,
        intentTitle: intent.title,
      })
      .from(run)
      .innerJoin(environment, eq(environment.id, run.environmentId))
      .innerJoin(scriptVersion, eq(scriptVersion.id, run.scriptVersionId))
      .innerJoin(intent, eq(intent.id, run.intentId))
      .where(eq(run.id, scoped.run.id))
      .limit(1)

    const attempts = await context.db
      .select({
        id: attempt.id,
        attemptNumber: attempt.attemptNumber,
        outcome: attempt.outcome,
        diagnosis: attempt.diagnosis,
        scriptVersionId: attempt.scriptVersionId,
        healApplied: attempt.healApplied,
        artifactKeys: attempt.artifactKeys,
        logs: attempt.logs,
        errorMessage: attempt.errorMessage,
        durationMs: attempt.durationMs,
        createdAt: attempt.createdAt,
      })
      .from(attempt)
      .where(eq(attempt.runId, scoped.run.id))
      .orderBy(asc(attempt.attemptNumber))

    return {
      run: row!.run,
      environment: {
        id: row!.run.environmentId,
        name: row!.environmentName,
        baseUrl: row!.baseUrl,
      },
      scriptVersion: { id: row!.run.scriptVersionId, version: row!.version },
      intent: { id: row!.intentId, title: row!.intentTitle },
      project: { id: scoped.project.id, name: scoped.project.name },
      attempts,
    }
  })

/**
 * Where to fetch one of a run's artifacts.
 *
 * Returns a URL rather than bytes: an image belongs in an `<img>` tag and a
 * trace belongs in a download, neither of which a JSON server function can
 * provide. `/api/artifacts/*` re-runs this exact check before it streams
 * anything, so the URL is a convenience and not the authorisation.
 */
export const getArtifactUrl = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    runId: str(data, 'runId'),
    key: str(data, 'key', { max: 512 }),
  }))
  .handler(async ({ data, context }) => {
    const scoped = await loadRun(context.db, context.organizationId, data.runId)

    // The key has to belong to *this* run, not merely to a run in this
    // organization — otherwise a run id the caller can see would unlock every
    // artifact the organization has ever produced.
    if (
      !scoped.run.artifactPrefix ||
      !data.key.startsWith(scoped.run.artifactPrefix) ||
      runIdFromKey(data.key) !== scoped.run.id
    ) {
      throw new ValidationError('That artifact does not belong to this run.')
    }

    return { url: `/api/artifacts/${data.key.split('/').map(encodeURIComponent).join('/')}` }
  })
