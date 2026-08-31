/** Delete R2 objects before their D1 rows, which hold the only references needed to clean them up. */
import { and, asc, desc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { createDb } from '#/db/index.ts'
import { instanceSettings, intent, run, suiteRun } from '#/db/schema/app.ts'

export const DEFAULT_RETENTION_RUNS = 50

const R2_DELETE_BUDGET = 500

const MAX_DELETIONS_PER_INTENT = 200

const ORPHAN_SUITE_GRACE_MS = 60 * 60 * 1000

export interface RetentionSummary {
  keep: number
  intentsTouched: number
  runsDeleted: number
  objectsDeleted: number
  carriedOver: number
  orphanSuitesDeleted: number
  failures: number
}

async function loadKeepCount(db: Db): Promise<number> {
  const [row] = await db
    .select({ keep: instanceSettings.retentionRunsPerIntent })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 'default'))
    .limit(1)

  const configured = row?.keep ?? DEFAULT_RETENTION_RUNS
  return Math.max(1, configured)
}

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
      return { deleted, complete: false }
    }

    await bucket.delete(keys)
    deleted += keys.length
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor)

  return { deleted, complete: true }
}

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

  await db.delete(run).where(inArray(run.id, deletable))
  result.runsDeleted = deletable.length

  await repointLastRun(db, intentId, deletable)

  return result
}

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
