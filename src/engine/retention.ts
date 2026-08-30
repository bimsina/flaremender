/**
 * The nightly sweep: how history stops growing.
 *
 * Runs accumulate for ever otherwise, and a run is not one row — it is an
 * attempt, a transcript, a screenshot, a trace zip. The policy is deliberately
 * the simplest one that is easy to reason about: **keep the newest N runs of
 * every intent, delete the rest.** Not "delete anything older than a month",
 * which quietly erases the entire history of an intent nobody has run since
 * spring, and not a global cap, which lets one noisy intent evict everyone
 * else's.
 *
 * Three properties are load-bearing:
 *
 * - **R2 first, D1 second.** The run row is the only thing that knows where a
 *   run's objects live. Deleting it before its bytes would strand them in the
 *   bucket with nothing left pointing at them, so every intent's objects go
 *   first and its rows only once they are gone.
 * - **Bounded.** A sweep deletes at most `R2_DELETE_BUDGET` objects. An
 *   instance that has never been swept has a lot to get through, and a cron
 *   invocation that tries to do all of it at once is one that does none of it.
 *   What is left is simply still there tomorrow night, when the budget resets.
 * - **Per-intent isolation.** One intent whose objects will not delete must not
 *   stop the sweep for every intent after it, so each is its own `try`.
 *
 * `intent.lastRunId` is a plain column rather than a foreign key, so nothing
 * would stop it from pointing at a deleted run. When the sweep deletes what an
 * intent's badge was reading, it repoints it at the newest run that survived —
 * never null, because the newest run is by definition one of the kept ones.
 */
import { and, asc, desc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { createDb } from '#/db/index.ts'
import { instanceSettings, intent, run, suiteRun } from '#/db/schema/app.ts'

/** Used when `instanceSettings.retentionRunsPerIntent` has never been set. */
export const DEFAULT_RETENTION_RUNS = 50

/**
 * The most R2 objects one sweep will delete. Each surviving run carries at most
 * three or four objects, so this is a few hundred runs a night — enough to keep
 * up with any instance that is not actively backfilling, and small enough that
 * the invocation always finishes.
 */
const R2_DELETE_BUDGET = 500

/** Runs examined per intent per sweep. A guard, not a policy. */
const MAX_DELETIONS_PER_INTENT = 200

/** Suite rows are only ever tidied once they are this far past their runs. */
const ORPHAN_SUITE_GRACE_MS = 60 * 60 * 1000

export interface RetentionSummary {
  /** How many runs each intent was allowed to keep. */
  keep: number
  intentsTouched: number
  runsDeleted: number
  objectsDeleted: number
  /** Runs left for tomorrow because the object budget ran out. */
  carriedOver: number
  orphanSuitesDeleted: number
  failures: number
}

/** The configured cap, floored at one: an intent with no runs at all has no history. */
async function loadKeepCount(db: Db): Promise<number> {
  const [row] = await db
    .select({ keep: instanceSettings.retentionRunsPerIntent })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 'default'))
    .limit(1)

  const configured = row?.keep ?? DEFAULT_RETENTION_RUNS
  return Math.max(1, configured)
}

/**
 * Deletes every object under a run's prefix.
 *
 * Listed rather than assumed: `ARTIFACT_NAMES` says what a run *usually*
 * writes, but a prefix is the durable statement of what it *did* write, and a
 * future artifact added to the run path should not need this file to be
 * edited to be cleaned up.
 */
async function deletePrefix(
  bucket: R2Bucket,
  prefix: string,
  budget: number,
): Promise<{ deleted: number; complete: boolean }> {
  let deleted = 0
  let cursor: string | undefined

  do {
    const listing = await bucket.list({ prefix, cursor, limit: 100 })
    const keys = listing.objects.map((object) => object.key)
    if (keys.length === 0) return { deleted, complete: true }

    if (deleted + keys.length > budget) {
      // Stopping mid-prefix would leave the run row deletable while some of its
      // objects survived, so the whole run waits for tomorrow instead.
      return { deleted, complete: false }
    }

    await bucket.delete(keys)
    deleted += keys.length
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor)

  return { deleted, complete: true }
}

/**
 * One nightly pass.
 *
 * Awaited straight through rather than handed to `waitUntil`: a scheduled
 * handler is allowed to take its time, and a sweep that is still running when
 * the invocation ends is a sweep whose R2 deletes and D1 deletes may not agree.
 */
export async function sweepRetention(env: Cloudflare.Env): Promise<RetentionSummary> {
  const db = createDb(env.DB)
  const keep = await loadKeepCount(db)

  const summary: RetentionSummary = {
    keep,
    intentsTouched: 0,
    runsDeleted: 0,
    objectsDeleted: 0,
    carriedOver: 0,
    orphanSuitesDeleted: 0,
    failures: 0,
  }

  // Only intents that are actually over the cap, so a quiet instance does the
  // grouping query and nothing else.
  const over = await db
    .select({ intentId: run.intentId, total: sql<number>`count(*)` })
    .from(run)
    .groupBy(run.intentId)
    .having(sql`count(*) > ${keep}`)

  for (const row of over) {
    if (summary.objectsDeleted >= R2_DELETE_BUDGET) {
      summary.carriedOver += Number(row.total) - keep
      continue
    }

    try {
      const result = await sweepIntent(db, env.ARTIFACTS, row.intentId, {
        keep,
        budget: R2_DELETE_BUDGET - summary.objectsDeleted,
      })

      summary.objectsDeleted += result.objectsDeleted
      summary.runsDeleted += result.runsDeleted
      summary.carriedOver += result.carriedOver
      if (result.runsDeleted > 0) summary.intentsTouched++
    } catch (error) {
      summary.failures++
      console.error(`[retention] ${row.intentId}: sweep failed, leaving it for tomorrow:`, error)
    }
  }

  try {
    summary.orphanSuitesDeleted = await deleteOrphanSuites(db)
  } catch (error) {
    summary.failures++
    console.error('[retention] orphan suite cleanup failed:', error)
  }

  console.log(
    `[retention] keep=${summary.keep} intents=${summary.intentsTouched} ` +
      `runs-deleted=${summary.runsDeleted} r2-objects=${summary.objectsDeleted} ` +
      `carried-over=${summary.carriedOver} orphan-suites=${summary.orphanSuitesDeleted} ` +
      `failures=${summary.failures}`,
  )

  return summary
}

interface IntentSweepResult {
  runsDeleted: number
  objectsDeleted: number
  carriedOver: number
}

/** One intent, trimmed back to the newest `keep` runs. */
async function sweepIntent(
  db: Db,
  bucket: R2Bucket,
  intentId: string,
  limits: { keep: number; budget: number },
): Promise<IntentSweepResult> {
  const result: IntentSweepResult = {
    runsDeleted: 0,
    objectsDeleted: 0,
    carriedOver: 0,
  }

  // Everything past the newest `keep`. `id` breaks ties so two runs started in
  // the same millisecond order the same way on every sweep.
  const expired = await db
    .select({
      id: run.id,
      artifactPrefix: run.artifactPrefix,
    })
    .from(run)
    .where(eq(run.intentId, intentId))
    .orderBy(desc(run.startedAt), desc(run.id))
    .limit(MAX_DELETIONS_PER_INTENT)
    .offset(limits.keep)

  if (expired.length === 0) return result

  const deletable: Array<string> = []
  let budget = limits.budget

  for (const row of expired) {
    if (!row.artifactPrefix) {
      // A run that never got as far as claiming a prefix has nothing in R2.
      deletable.push(row.id)
      continue
    }

    if (budget <= 0) {
      result.carriedOver++
      continue
    }

    const { deleted, complete } = await deletePrefix(bucket, row.artifactPrefix, budget)
    result.objectsDeleted += deleted
    budget -= deleted

    if (!complete) {
      result.carriedOver++
      continue
    }

    deletable.push(row.id)
  }

  if (deletable.length === 0) return result

  // The attempt rows go with them: `attempt.runId` cascades.
  await db.delete(run).where(inArray(run.id, deletable))
  result.runsDeleted = deletable.length

  await repointLastRun(db, intentId, deletable)

  return result
}

/**
 * Keeps the intent's "last run" pointing at a run that still exists.
 *
 * Repointed to the newest survivor rather than nulled: the badge on the intent
 * listing is a statement about the most recent thing that happened, and the
 * most recent thing that happened is still on file — only the one before it is
 * gone.
 */
async function repointLastRun(db: Db, intentId: string, deleted: Array<string>): Promise<void> {
  const [row] = await db
    .select({ lastRunId: intent.lastRunId })
    .from(intent)
    .where(eq(intent.id, intentId))
    .limit(1)

  if (!row?.lastRunId || !deleted.includes(row.lastRunId)) return

  const [newest] = await db
    .select({ id: run.id })
    .from(run)
    .where(eq(run.intentId, intentId))
    .orderBy(desc(run.startedAt), desc(run.id))
    .limit(1)

  await db
    .update(intent)
    .set({ lastRunId: newest?.id ?? null })
    .where(eq(intent.id, intentId))
}

/**
 * Suite rows whose members have all been swept away.
 *
 * Best-effort tidying, not part of the policy: a suite is a thin row and the
 * cost of leaving one behind is cosmetic. Guarded three ways so it can never
 * take a suite that is still meaningful — it must be finished, it must have no
 * member runs left, and it must predate the oldest run its project still has
 * (with an hour's grace, for a suite whose members have not been created yet).
 *
 * Every project with suites is considered, not only the ones this sweep took
 * runs from: an orphan is made by the sweep that deleted its last member, and
 * a project that has stopped shedding runs would otherwise keep its orphans
 * for ever.
 */
async function deleteOrphanSuites(db: Db): Promise<number> {
  const projects = await db.selectDistinct({ projectId: suiteRun.projectId }).from(suiteRun)

  let deleted = 0

  for (const { projectId } of projects) {
    const [oldest] = await db
      .select({ startedAt: run.startedAt })
      .from(run)
      .where(eq(run.projectId, projectId))
      .orderBy(asc(run.startedAt))
      .limit(1)

    const horizon = Math.min(
      oldest?.startedAt.getTime() ?? Date.now(),
      Date.now() - ORPHAN_SUITE_GRACE_MS,
    )

    // `is not null` is not decoration: `NOT IN (…)` over a set containing NULL
    // is never true in SQL, and this delete would silently do nothing.
    const survivors = db
      .select({ id: run.suiteRunId })
      .from(run)
      .where(and(eq(run.projectId, projectId), isNotNull(run.suiteRunId)))

    const removed = await db
      .delete(suiteRun)
      .where(
        and(
          eq(suiteRun.projectId, projectId),
          notInArray(suiteRun.status, ['queued', 'running']),
          sql`${suiteRun.startedAt} < ${horizon}`,
          notInArray(suiteRun.id, survivors),
        ),
      )
      .returning({ id: suiteRun.id })

    deleted += removed.length
  }

  return deleted
}
