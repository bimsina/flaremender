import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'

import { createDb } from '#/db/index.ts'
import type { SuiteRunStatus } from '#/db/schema/app.ts'
import { environment, intent, project, run, suiteRun } from '#/db/schema/app.ts'
import { notifyQuietly, notifySuite } from '#/engine/notifications/dispatch.ts'
import { maybeQueueAutomaticRepair } from '#/engine/repair/trigger.ts'
import {
  EXECUTE_STEP_CONFIG,
  PERSIST_ERROR_STEP_CONFIG,
  executeRun,
  loadRun,
  persistRun,
  persistRunError,
  releaseRunSession,
} from '#/engine/run-steps.ts'
import { isRunnableIntent } from '#/server/test-policy.ts'

export interface SuiteWorkflowParams {
  suiteRunId: string
  organizationId: string
  intentIds?: Array<string>
}

interface SuiteMember {
  intentId: string
  scriptVersionId: string
}

interface LoadedSuite {
  projectId: string
  environmentId: string
  environmentName: string
  baseUrl: string
  trigger: 'manual' | 'schedule' | 'webhook'
  webhookApiKeyId: string | null
  webhookApiKeyName: string | null
  members: Array<SuiteMember>
}

interface SuiteCounts {
  total: number
  passed: number
  failed: number
  error: number
}

const UNFINISHED_RUN_STATUSES = ['queued', 'running'] as const

function memberRunId(suiteRunId: string, index: number): string {
  return `run_${suiteRunId.replace(/^srun_/, '')}_${String(index).padStart(3, '0')}`
}

/** Recount persisted members so workflow retries cannot double-count results. */
async function tallySuite(env: Cloudflare.Env, suiteRunId: string): Promise<SuiteCounts> {
  const db = createDb(env.DB)

  const rows = await db
    .select({ status: run.status, count: sql<number>`count(*)` })
    .from(run)
    .where(eq(run.suiteRunId, suiteRunId))
    .groupBy(run.status)

  const counts: SuiteCounts = { total: 0, passed: 0, failed: 0, error: 0 }

  for (const row of rows) {
    const n = Number(row.count)
    counts.total += n
    if (row.status === 'passed' || row.status === 'healed') counts.passed += n
    else if (row.status === 'failed') counts.failed += n
    else if (row.status === 'error') counts.error += n
  }

  return counts
}

export class SuiteWorkflow extends WorkflowEntrypoint<Cloudflare.Env, SuiteWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<SuiteWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ suiteRunId: string; status: SuiteRunStatus }> {
    const { suiteRunId, organizationId, intentIds } = event.payload

    let sessionId: string | null = null

    try {
      const suite = await step.do('load', () => this.load(suiteRunId, organizationId, intentIds))

      for (const [index, member] of suite.members.entries()) {
        sessionId = await this.runMember(step, {
          suiteRunId,
          organizationId,
          index,
          member,
          suite,
          sessionId,
        })
      }

      const finished = await step.do('finish', () => this.finish(suiteRunId, sessionId))

      await step.do('notify', () =>
        notifyQuietly(suiteRunId, () => notifySuite(this.env, suiteRunId)),
      )

      return finished
    } catch (error) {
      await step.do('finish-error', PERSIST_ERROR_STEP_CONFIG, () =>
        this.finishError(suiteRunId, sessionId, error),
      )

      throw error
    }
  }

  private async load(
    suiteRunId: string,
    organizationId: string,
    intentIds?: Array<string>,
  ): Promise<LoadedSuite> {
    const db = createDb(this.env.DB)

    const [row] = await db
      .select({ suiteRun, environment })
      .from(suiteRun)
      .innerJoin(project, eq(project.id, suiteRun.projectId))
      .innerJoin(environment, eq(environment.id, suiteRun.environmentId))
      .where(and(eq(suiteRun.id, suiteRunId), eq(project.organizationId, organizationId)))
      .limit(1)

    if (!row) {
      throw new NonRetryableError(`Suite run ${suiteRunId} does not exist in this organization.`)
    }

    const members = await db
      .select({ intentId: intent.id, scriptVersionId: intent.currentVersionId })
      .from(intent)
      .where(
        and(
          eq(intent.projectId, row.suiteRun.projectId),
          isNotNull(intent.currentVersionId),
          isRunnableIntent,
          intentIds && intentIds.length > 0 ? inArray(intent.id, intentIds) : undefined,
        ),
      )
      .orderBy(asc(intent.createdAt))

    if (members.length === 0) {
      throw new NonRetryableError(`Suite run ${suiteRunId} has no runnable intents.`)
    }

    await db
      .update(suiteRun)
      .set({ status: 'running', totalCount: members.length })
      .where(eq(suiteRun.id, suiteRunId))

    return {
      projectId: row.suiteRun.projectId,
      environmentId: row.suiteRun.environmentId,
      environmentName: row.suiteRun.environmentName ?? row.environment.name,
      baseUrl: row.suiteRun.baseUrl ?? row.environment.baseUrl,
      trigger: row.suiteRun.trigger,
      webhookApiKeyId: row.suiteRun.webhookApiKeyId,
      webhookApiKeyName: row.suiteRun.webhookApiKeyName,
      members: members.map((member) => ({
        intentId: member.intentId,
        scriptVersionId: member.scriptVersionId!,
      })),
    }
  }

  private async runMember(
    step: WorkflowStep,
    context: {
      suiteRunId: string
      organizationId: string
      index: number
      member: SuiteMember
      suite: LoadedSuite
      sessionId: string | null
    },
  ): Promise<string | null> {
    const { suiteRunId, organizationId, index, member, suite } = context
    const runId = memberRunId(suiteRunId, index)
    const label = `run-${index}`

    let sessionId = context.sessionId

    try {
      await step.do(`${label}-create`, () => this.createMemberRun(runId, suiteRunId, member, suite))

      const loaded = await step.do(`${label}-load`, () => loadRun(this.env, runId, organizationId))

      const executed = await step.do(`${label}-execute`, EXECUTE_STEP_CONFIG, () =>
        executeRun(this.env, runId, loaded, { sessionId, keepAlive: true }),
      )

      sessionId = executed.sessionId

      const persisted = await step.do(`${label}-persist`, () =>
        persistRun(this.env, runId, loaded, executed),
      )

      if (persisted.status === 'failed') {
        await step.do(`${label}-repair`, () =>
          maybeQueueAutomaticRepair(this.env, runId).catch((error: unknown) => ({
            queued: false,
            jobId: null,
            reason: error instanceof Error ? error.message : String(error),
          })),
        )
      }
    } catch (error) {
      sessionId = null

      await step.do(`${label}-persist-error`, PERSIST_ERROR_STEP_CONFIG, () =>
        persistRunError(this.env, runId, error),
      )
    }

    await step.do(`${label}-tally`, () => this.tally(suiteRunId))

    return sessionId
  }

  private async createMemberRun(
    runId: string,
    suiteRunId: string,
    member: SuiteMember,
    suite: LoadedSuite,
  ): Promise<{ runId: string }> {
    const db = createDb(this.env.DB)

    await db
      .insert(run)
      .values({
        id: runId,
        intentId: member.intentId,
        environmentId: suite.environmentId,
        environmentName: suite.environmentName,
        baseUrl: suite.baseUrl,
        purpose: 'regression',
        projectId: suite.projectId,
        scriptVersionId: member.scriptVersionId,
        suiteRunId,
        status: 'queued',
        trigger: suite.trigger,
        webhookApiKeyId: suite.webhookApiKeyId,
        webhookApiKeyName: suite.webhookApiKeyName,
        startedAt: new Date(),
      })
      .onConflictDoNothing()

    return { runId }
  }

  private async tally(suiteRunId: string): Promise<SuiteCounts> {
    const db = createDb(this.env.DB)
    const counts = await tallySuite(this.env, suiteRunId)

    await db
      .update(suiteRun)
      .set({
        passedCount: counts.passed,
        failedCount: counts.failed,
        errorCount: counts.error,
      })
      .where(eq(suiteRun.id, suiteRunId))

    return counts
  }

  private async finish(
    suiteRunId: string,
    sessionId: string | null,
  ): Promise<{
    suiteRunId: string
    status: SuiteRunStatus
  }> {
    const db = createDb(this.env.DB)

    if (sessionId) await releaseRunSession(this.env, sessionId)

    const [row] = await db
      .select({ totalCount: suiteRun.totalCount })
      .from(suiteRun)
      .where(eq(suiteRun.id, suiteRunId))
      .limit(1)

    const counts = await tallySuite(this.env, suiteRunId)
    const total = row?.totalCount ?? counts.total

    const status: SuiteRunStatus =
      counts.error > 0
        ? 'error'
        : counts.failed > 0
          ? 'failed'
          : counts.passed === total
            ? 'passed'
            : 'error'

    await db
      .update(suiteRun)
      .set({
        status,
        passedCount: counts.passed,
        failedCount: counts.failed,
        errorCount: counts.error,
        finishedAt: new Date(),
      })
      .where(eq(suiteRun.id, suiteRunId))

    return { suiteRunId, status }
  }

  private async finishError(
    suiteRunId: string,
    sessionId: string | null,
    error: unknown,
  ): Promise<void> {
    const db = createDb(this.env.DB)

    if (sessionId) await releaseRunSession(this.env, sessionId)

    await db
      .update(run)
      .set({
        status: 'error',
        errorMessage: 'The suite could not finish. Review its member runs for details.',
        finishedAt: new Date(),
      })
      .where(and(eq(run.suiteRunId, suiteRunId), inArray(run.status, [...UNFINISHED_RUN_STATUSES])))

    const counts = await tallySuite(this.env, suiteRunId)

    await db
      .update(suiteRun)
      .set({
        status: 'error',
        errorMessage:
          'The suite workflow could not finish. Results may be incomplete; review the member runs and try again.',
        passedCount: counts.passed,
        failedCount: counts.failed,
        errorCount: counts.error,
        finishedAt: new Date(),
      })
      .where(
        and(eq(suiteRun.id, suiteRunId), inArray(suiteRun.status, [...UNFINISHED_RUN_STATUSES])),
      )

    console.error(`[suite-workflow] ${suiteRunId} failed:`, error)
  }
}
