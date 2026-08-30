/**
 * The minute tick: what the clock owes the intents that asked to be run.
 *
 * Cloudflare fires one cron every minute; this decides which intents that
 * minute belongs to and hands each project's due set to a `SuiteWorkflow`. It
 * is the *only* thing the tick does — no browser, no script, no waiting — so a
 * tick costs one query and a workflow create even on a busy instance, and the
 * work itself happens where all other work happens.
 *
 * Three ideas do the load-bearing:
 *
 * - **Grouping by project.** Ten intents due in one project is one suite, not
 *   ten runs: a suite is sequential and shares a browser session, which is the
 *   only shape Browser Rendering's concurrency limits tolerate. Projects are
 *   dispatched together, and their suites do run concurrently — that is a
 *   deliberate choice, bounded by the account's own browser concurrency quota
 *   (2 on the free plan, 120 on paid) rather than by anything here. An instance
 *   with more scheduled projects than browser slots will see suites queue on
 *   the platform's limit, which is the right place for that to be decided.
 * - **Not stacking.** A suite that takes eleven minutes must not be joined by
 *   ten more of itself. Anything already queued or running — the project's own
 *   suites, or an individual run of a due intent — takes that intent (or that
 *   whole project) out of this tick.
 * - **Idempotence.** A cron tick can be delivered twice. The suite's id is
 *   derived from the project and the minute, so the second delivery loses the
 *   insert race and creates nothing.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { createDb } from '#/db/index.ts'
import { environment, intent, project, run, suiteRun } from '#/db/schema/app.ts'
import { matchesCron } from '#/lib/cron.ts'

/** Non-terminal on both tables: work that is still expected to produce a verdict. */
const UNFINISHED = ['queued', 'running'] as const

export interface DispatchSummary {
  /** Intents whose expression matched this minute, before any guard ran. */
  due: number
  suitesCreated: number
  /** Due intents dropped because they, or their project, were already busy. */
  skippedBusy: number
  /** Due intents in a project with no default environment to run against. */
  skippedNoEnvironment: number
}

/**
 * A suite id that two deliveries of the same tick both compute.
 *
 * `srun_sch_<project>_<yyyymmddhhmm>`: the project makes it unique across an
 * instance, the minute makes it unique across time, and neither is random —
 * which is the whole point. The insert then decides, once, whether this tick
 * has already been handled.
 */
export function scheduledSuiteRunId(projectId: string, tick: Date): string {
  const stamp = [
    tick.getUTCFullYear(),
    String(tick.getUTCMonth() + 1).padStart(2, '0'),
    String(tick.getUTCDate()).padStart(2, '0'),
    String(tick.getUTCHours()).padStart(2, '0'),
    String(tick.getUTCMinutes()).padStart(2, '0'),
  ].join('')

  return `srun_sch_${projectId.replace(/^prj_/, '')}_${stamp}`
}

/** The minute a tick belongs to. Cron names minutes; nothing finer is meaningful. */
export function alignToMinute(time: number | Date): Date {
  const ms = time instanceof Date ? time.getTime() : time
  return new Date(Math.floor(ms / 60_000) * 60_000)
}

/**
 * Runs one minute of the schedule.
 *
 * Never throws for one project's sake: a project without an environment, or a
 * workflow that would not start, is logged and stepped over, because the next
 * project's intents are still due.
 */
export async function dispatchSchedules(
  env: Cloudflare.Env,
  tickTime: number | Date,
): Promise<DispatchSummary> {
  const db = createDb(env.DB)
  const tick = alignToMinute(tickTime)

  const summary: DispatchSummary = {
    due: 0,
    suitesCreated: 0,
    skippedBusy: 0,
    skippedNoEnvironment: 0,
  }

  // Everything that *could* be due, which is a short list on any real instance:
  // scheduled intents are a small fraction of intents, and matching is cheap
  // enough to do in code, where the parser already lives.
  const candidates = await db
    .select({
      intentId: intent.id,
      schedule: intent.schedule,
      projectId: intent.projectId,
      organizationId: project.organizationId,
    })
    .from(intent)
    .innerJoin(project, eq(project.id, intent.projectId))
    .where(and(isNotNull(intent.schedule), isNotNull(intent.currentVersionId)))

  const dueByProject = new Map<string, { organizationId: string; intentIds: Array<string> }>()

  for (const row of candidates) {
    if (!row.schedule || !matchesCron(row.schedule, tick)) continue
    summary.due++

    const group = dueByProject.get(row.projectId) ?? {
      organizationId: row.organizationId,
      intentIds: [],
    }
    group.intentIds.push(row.intentId)
    dueByProject.set(row.projectId, group)
  }

  if (dueByProject.size === 0) return summary

  const busyIntentIds = await loadBusyIntentIds(
    db,
    [...dueByProject.values()].flatMap((group) => group.intentIds),
  )
  const busyProjectIds = await loadBusyProjectIds(db, [...dueByProject.keys()])

  for (const [projectId, group] of dueByProject) {
    try {
      // A suite of this project's is still going. Its members overlap this
      // tick's by construction, and starting a second one would double the
      // browser sessions to say the same thing twice.
      if (busyProjectIds.has(projectId)) {
        summary.skippedBusy += group.intentIds.length
        console.log(
          `[schedule] ${projectId}: skipped ${group.intentIds.length} due intent(s) — a suite is still running.`,
        )
        continue
      }

      const runnable = group.intentIds.filter((intentId) => !busyIntentIds.has(intentId))
      summary.skippedBusy += group.intentIds.length - runnable.length
      if (runnable.length === 0) continue

      const [target] = await db
        .select({ id: environment.id })
        .from(environment)
        .where(and(eq(environment.projectId, projectId), eq(environment.isDefault, true)))
        .limit(1)

      if (!target) {
        summary.skippedNoEnvironment += runnable.length
        console.warn(
          `[schedule] ${projectId}: ${runnable.length} due intent(s) have nowhere to run — the project has no default environment.`,
        )
        continue
      }

      const created = await startScheduledSuite(env, {
        suiteRunId: scheduledSuiteRunId(projectId, tick),
        projectId,
        environmentId: target.id,
        organizationId: group.organizationId,
        intentIds: runnable,
      })

      if (created) summary.suitesCreated++
    } catch (error) {
      console.error(`[schedule] ${projectId}: could not dispatch its due intents:`, error)
    }
  }

  console.log(
    `[schedule] ${tick.toISOString()} — due=${summary.due} suites=${summary.suitesCreated} ` +
      `skipped-busy=${summary.skippedBusy} skipped-no-env=${summary.skippedNoEnvironment}`,
  )

  return summary
}

/** Intents with an execution of their own still in flight. */
async function loadBusyIntentIds(db: Db, intentIds: Array<string>): Promise<Set<string>> {
  if (intentIds.length === 0) return new Set()

  const rows = await db
    .selectDistinct({ intentId: run.intentId })
    .from(run)
    .where(and(inArray(run.intentId, intentIds), inArray(run.status, [...UNFINISHED])))

  return new Set(rows.map((row) => row.intentId))
}

/** Projects with a suite still in flight, whoever started it. */
async function loadBusyProjectIds(db: Db, projectIds: Array<string>): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set()

  const rows = await db
    .selectDistinct({ projectId: suiteRun.projectId })
    .from(suiteRun)
    .where(and(inArray(suiteRun.projectId, projectIds), inArray(suiteRun.status, [...UNFINISHED])))

  return new Set(rows.map((row) => row.projectId))
}

/**
 * Claims the minute, then starts the suite.
 *
 * The insert is the lock. `onConflictDoNothing` with `returning` tells us
 * whether *this* delivery of the tick is the one that gets to create the
 * workflow, so a replayed tick returns false and does nothing rather than
 * racing another instance onto the same browser.
 */
async function startScheduledSuite(
  env: Cloudflare.Env,
  input: {
    suiteRunId: string
    projectId: string
    environmentId: string
    organizationId: string
    intentIds: Array<string>
  },
): Promise<boolean> {
  const db = createDb(env.DB)

  const claimed = await db
    .insert(suiteRun)
    .values({
      id: input.suiteRunId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      status: 'queued',
      trigger: 'schedule',
      totalCount: input.intentIds.length,
      // Nobody pressed anything. `createdBy` is nullable precisely for this.
      createdBy: null,
      startedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: suiteRun.id })

  if (claimed.length === 0) {
    console.log(`[schedule] ${input.suiteRunId} already exists — this tick was a replay.`)
    return false
  }

  try {
    await env.SUITE_WORKFLOW.create({
      id: input.suiteRunId,
      params: {
        suiteRunId: input.suiteRunId,
        organizationId: input.organizationId,
        intentIds: input.intentIds,
      },
    })
  } catch (error) {
    // The row is the lock, and a lock nobody will ever release is worse than
    // no lock: a suite stuck at 'queued' would take this project out of every
    // future tick. Give it a verdict, then let the caller log the failure.
    await db
      .update(suiteRun)
      .set({ status: 'error', finishedAt: new Date() })
      .where(eq(suiteRun.id, input.suiteRunId))

    throw error
  }

  console.log(
    `[schedule] ${input.suiteRunId}: queued ${input.intentIds.length} intent(s) in ${input.projectId}.`,
  )

  return true
}
