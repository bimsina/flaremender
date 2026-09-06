import { and, eq, inArray, isNotNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { createDb } from '#/db/index.ts'
import { environment, intent, project, run, suiteRun } from '#/db/schema/app.ts'
import { matchesCron } from '#/lib/cron.ts'
import { isRunnableIntent } from '#/server/core/test-policy.ts'
import { enqueueWork } from '#/server/core/enqueue.ts'

const UNFINISHED = ['queued', 'running'] as const

export interface DispatchSummary {
  due: number
  suitesCreated: number
  skippedBusy: number
  skippedNoEnvironment: number
}

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

export function alignToMinute(time: number | Date): Date {
  const ms = time instanceof Date ? time.getTime() : time
  return new Date(Math.floor(ms / 60_000) * 60_000)
}

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

  const candidates = await db
    .select({
      intentId: intent.id,
      schedule: intent.schedule,
      projectId: intent.projectId,
      organizationId: project.organizationId,
    })
    .from(intent)
    .innerJoin(project, eq(project.id, intent.projectId))
    .where(and(isNotNull(intent.schedule), isNotNull(intent.currentVersionId), isRunnableIntent))

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
        .select({ id: environment.id, name: environment.name, baseUrl: environment.baseUrl })
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
        environmentName: target.name,
        baseUrl: target.baseUrl,
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

async function loadBusyIntentIds(db: Db, intentIds: Array<string>): Promise<Set<string>> {
  if (intentIds.length === 0) return new Set()

  const rows = await db
    .selectDistinct({ intentId: run.intentId })
    .from(run)
    .where(and(inArray(run.intentId, intentIds), inArray(run.status, [...UNFINISHED])))

  return new Set(rows.map((row) => row.intentId))
}

async function loadBusyProjectIds(db: Db, projectIds: Array<string>): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set()

  const rows = await db
    .selectDistinct({ projectId: suiteRun.projectId })
    .from(suiteRun)
    .where(and(inArray(suiteRun.projectId, projectIds), inArray(suiteRun.status, [...UNFINISHED])))

  return new Set(rows.map((row) => row.projectId))
}

async function startScheduledSuite(
  env: Cloudflare.Env,
  input: {
    suiteRunId: string
    projectId: string
    environmentId: string
    environmentName: string
    baseUrl: string
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
      environmentName: input.environmentName,
      baseUrl: input.baseUrl,
      status: 'queued',
      trigger: 'schedule',
      totalCount: input.intentIds.length,
      createdBy: null,
      startedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: suiteRun.id })

  if (claimed.length === 0) {
    console.log(`[schedule] ${input.suiteRunId} already exists — this tick was a replay.`)
    return false
  }

  await enqueueWork(
    () =>
      env.SUITE_WORKFLOW.create({
        id: input.suiteRunId,
        params: {
          suiteRunId: input.suiteRunId,
          organizationId: input.organizationId,
          intentIds: input.intentIds,
        },
      }),
    async () => (await env.SUITE_WORKFLOW.get(input.suiteRunId)).status(),
    async () => {
      await db
        .update(suiteRun)
        .set({
          status: 'error',
          errorMessage: 'The scheduled suite could not be started.',
          finishedAt: new Date(),
        })
        .where(and(eq(suiteRun.id, input.suiteRunId), eq(suiteRun.status, 'queued')))
    },
  )

  console.log(
    `[schedule] ${input.suiteRunId}: queued ${input.intentIds.length} intent(s) in ${input.projectId}.`,
  )

  return true
}
