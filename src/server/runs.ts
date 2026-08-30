/**
 * Reading run history.
 *
 * A run is one execution request; the attempts inside it are what actually
 * touched a browser. Today every run has exactly one attempt, but the listing
 * already aggregates so the healing loop can append attempts without a rewrite.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, sql } from 'drizzle-orm'

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
        // Null for a run started on its own; the UI labels the rest as part of
        // a "Run all" rather than leaving them looking spontaneous.
        suiteRunId: run.suiteRunId,
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

/**
 * Every run in a project, whichever intent produced it.
 *
 * The filters are optional and additive; each one absent means "no opinion"
 * rather than "null", which is why they go through `has` before they are read.
 * Suite membership is not a filter here — the project Runs tab draws suites
 * from `listSuiteRuns` and interleaves them with the standalone runs this
 * returns, so a member run is exposed under the suite it belongs to rather than
 * twice.
 */
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
        suiteRunId: run.suiteRunId,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        intentId: run.intentId,
        intentTitle: intent.title,
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
        // The exact text that ran, not the version's current code: restoring or
        // re-saving must not rewrite what an old attempt is shown to have done.
        scriptUsed: attempt.scriptUsed,
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
 * The key has to belong to *this* run, not merely to a run in this
 * organization — otherwise a run id the caller can see would unlock every
 * artifact the organization has ever produced.
 */
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
    assertArtifactBelongsToRun(scoped.run, data.key)

    return { url: artifactPath(data.key) }
  })

/**
 * The same artifact, but readable without a session for the next ten minutes.
 *
 * This is what the Playwright trace viewer needs: it runs on trace.playwright.dev
 * and fetches the zip cross-origin, where our cookie does not travel. The
 * authorisation therefore has to be *in* the URL, which is what makes the
 * expiry and the narrowness matter — the signature covers one exact key and
 * nothing about the caller, so a leaked link is one trace for ten minutes and
 * never a way into the organization.
 *
 * The org check is unchanged: it happens here, once, before anything is signed.
 */
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
