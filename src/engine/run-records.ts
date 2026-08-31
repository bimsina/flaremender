import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '#/db/index.ts'
import { attempt, intent, run } from '#/db/schema/app.ts'
import type { RunStatus } from '#/db/schema/app.ts'
import type { ExecutedRun, LoadedRun } from './run-steps.ts'

function updateCurrentResult(
  db: Db,
  runId: string,
  loaded: Pick<LoadedRun, 'intentId' | 'scriptVersionId' | 'purpose' | 'startedAt'>,
) {
  return db
    .update(intent)
    .set({
      status: sql`case when (select status from run where id = ${runId}) in ('passed', 'healed') then 'passing' else 'failing' end`,
      lastRunId: runId,
    })
    .where(
      and(
        eq(intent.id, loaded.intentId),
        eq(intent.currentVersionId, loaded.scriptVersionId),
        eq(intent.readiness, 'ready'),
        sql`${loaded.purpose} = 'regression'`,
        sql`not exists (select 1 from run newer where newer.id = ${intent.lastRunId} and (newer.started_at > ${loaded.startedAt} or (newer.started_at = ${loaded.startedAt} and newer.id > ${runId})))`,
      ),
    )
}

/** Infrastructure failures have no attempt, but still belong to an exact version. */
export async function recordRunError(db: Db, runId: string, errorMessage: string) {
  const [row] = await db.select().from(run).where(eq(run.id, runId)).limit(1)
  if (!row) throw new Error('Run not found.')
  if (!['queued', 'running'].includes(row.status)) return row
  await db.batch([
    db
      .update(run)
      .set({ status: 'error', errorMessage, finishedAt: new Date() })
      .where(and(eq(run.id, runId), inArray(run.status, ['queued', 'running']))),
    updateCurrentResult(db, runId, { ...row, startedAt: row.startedAt.getTime() }),
  ])
  const [stored] = await db.select().from(run).where(eq(run.id, runId)).limit(1)
  return stored
}

export async function recordRunResult(
  db: Db,
  runId: string,
  loaded: LoadedRun,
  executed: ExecutedRun,
  status: RunStatus,
) {
  const [existing] = await db
    .select({ status: run.status })
    .from(run)
    .where(eq(run.id, runId))
    .limit(1)
  if (!existing) throw new Error('Run not found.')
  if (!['queued', 'running'].includes(existing.status)) return existing.status
  // Every line of an error is indented, not just its first: the UI reads this
  // column back into steps, and a Playwright error runs to a dozen lines whose
  // second onwards would otherwise be indistinguishable from console output.
  const transcript = [
    ...executed.result.steps.map((step) => {
      const head = `${step.ok ? '✓' : '✘'} ${step.label} (${step.durationMs}ms)`
      if (!step.error) return head
      return [head, ...step.error.split('\n').map((line) => `    ${line}`)].join('\n')
    }),
    ...(executed.result.logs.length > 0 ? ['', ...executed.result.logs] : []),
  ].join('\n')

  await db.batch([
    // Deterministic id + do-nothing: `persist` is a retryable step, and the
    // `(runId, attemptNumber)` unique index would otherwise turn a retry into
    // a permanent failure.
    db
      .insert(attempt)
      .select(
        db
          .select({
            id: sql`${`att_${runId.replace(/^run_/, '')}_1`}`.as('id'),
            runId: sql`${runId}`.as('run_id'),
            attemptNumber: sql`1`.as('attempt_number'),
            outcome: sql`${executed.result.outcome}`.as('outcome'),
            diagnosis: sql`null`.as('diagnosis'),
            scriptVersionId: sql`${loaded.scriptVersionId}`.as('script_version_id'),
            scriptUsed: sql`${loaded.code}`.as('script_used'),
            healApplied: sql`null`.as('heal_applied'),
            artifactKeys: sql`${JSON.stringify(executed.artifactKeys)}`.as('artifact_keys'),
            result: sql`${JSON.stringify(executed.result)}`.as('result'),
            artifactWarnings: sql`${JSON.stringify(executed.artifactWarnings ?? [])}`.as(
              'artifact_warnings',
            ),
            logs: sql`${transcript}`.as('logs'),
            errorMessage: sql`${executed.result.errorMessage}`.as('error_message'),
            durationMs: sql`${executed.result.durationMs}`.as('duration_ms'),
            createdAt: sql`${Date.now()}`.as('created_at'),
          })
          .from(run)
          // The initial read can race with the workflow error handler. Check
          // again inside the atomic batch, before attaching any evidence.
          .where(and(eq(run.id, runId), inArray(run.status, ['queued', 'running']))),
      )
      .onConflictDoNothing(),
    db
      .update(run)
      .set({ status, errorMessage: executed.result.errorMessage, finishedAt: new Date() })
      .where(and(eq(run.id, runId), inArray(run.status, ['queued', 'running']))),
    updateCurrentResult(db, runId, loaded),
  ])
  const [stored] = await db
    .select({ status: run.status })
    .from(run)
    .where(eq(run.id, runId))
    .limit(1)
  return stored.status
}
