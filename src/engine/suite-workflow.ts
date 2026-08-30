/**
 * A whole project, executed once.
 *
 * A suite is not a new kind of execution — it is the ordinary one, repeated.
 * Each member gets a real `run` row, its own artifacts, its own attempt and its
 * own `RunChannel`, produced by the exact functions `RunWorkflow` calls. What a
 * suite adds is threefold:
 *
 * - **Order.** Members run strictly one after another. Browser Rendering allows
 *   very few concurrent sessions, so a suite that fanned out would spend its
 *   time collecting `429`s; sequential is not a simplification, it is the shape
 *   the platform wants. It also means a suite's wall time is the sum of its
 *   members, which is why the counts below are updated as it goes.
 * - **One browser session for the whole suite.** Sequential was not enough on
 *   its own: taking a *new* session per member hit the same rate limit from the
 *   third intent on. The first member acquires a session, every member after it
 *   connects to that one, and the suite ends it in `finish`. Isolation is not
 *   the session's job — each member opens a fresh incognito context, so no
 *   cookie, cache entry or open page survives from one intent to the next.
 *   A session that dies mid-suite is not fatal: the harness quietly takes a new
 *   one and reports which it used, and the suite carries on with that.
 * - **Isolation.** A member that fails, errors, or cannot be executed at all
 *   does not end the suite. Its failure is recorded on its own run row and the
 *   next member starts. A suite stops early only if the suite itself breaks.
 * - **An aggregate verdict.** `passed` requires every member to have passed;
 *   `error` outranks `failed`, because "we could not find out" is worse news
 *   than "we found a bug".
 *
 * Step budget: Workflows allows 1,024 steps per instance and each member costs
 * five (create, load, execute, persist, tally) — six if it has to be salvaged —
 * on top of the suite's own two. Roughly 170 intents fit in one suite, which is
 * far more than a project's browser-minute budget would allow anyway.
 */
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'

import { createDb } from '#/db/index.ts'
import type { SuiteRunStatus } from '#/db/schema/app.ts'
import { intent, project, run, suiteRun } from '#/db/schema/app.ts'
import {
  EXECUTE_STEP_CONFIG,
  PERSIST_ERROR_STEP_CONFIG,
  executeRun,
  loadRun,
  persistRun,
  persistRunError,
  releaseRunSession,
} from '#/engine/run-steps.ts'

export interface SuiteWorkflowParams {
  suiteRunId: string
  /** Taken from the session at enqueue time; never from anything a row says. */
  organizationId: string
}

interface SuiteMember {
  intentId: string
  /** Snapshotted when the suite started: an edit mid-suite must not retarget it. */
  scriptVersionId: string
}

interface LoadedSuite {
  projectId: string
  environmentId: string
  trigger: 'manual' | 'schedule'
  members: Array<SuiteMember>
}

interface SuiteCounts {
  total: number
  passed: number
  failed: number
  error: number
}

/** Non-terminal on both tables, and therefore safe for a guarded update to claim. */
const UNFINISHED_RUN_STATUSES = ['queued', 'running'] as const

/**
 * A member's run id, derived rather than random.
 *
 * `run-N-create` is a retryable step: a random id would leave an orphan row
 * behind every time the step committed and then failed on its way out. Derived
 * from the suite and the member's position, the retry writes the same row.
 */
function memberRunId(suiteRunId: string, index: number): string {
  return `run_${suiteRunId.replace(/^srun_/, '')}_${String(index).padStart(3, '0')}`
}

/**
 * What the member runs actually say, read back rather than accumulated.
 *
 * Counting from the database instead of from a running total makes every tally
 * idempotent: a replayed step, a resumed instance and a first pass all compute
 * the same numbers from the same rows. `'healed'` counts as passed — it is a
 * pass that took a repair, and a suite is not the place that distinction lives.
 */
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
    const { suiteRunId, organizationId } = event.payload

    /**
     * The session the members share. Hoisted so the failure path can hand it
     * back too, and only ever assigned from a step's return value — so a
     * resumed instance recomputes exactly the session the first pass used.
     */
    let sessionId: string | null = null

    try {
      const suite = await step.do('load', () => this.load(suiteRunId, organizationId))

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

      return await step.do('finish', () => this.finish(suiteRunId, sessionId))
    } catch (error) {
      // The suite itself broke — not a member. Without this it, and any member
      // it had already created, would sit at 'running' for ever.
      await step.do('finish-error', PERSIST_ERROR_STEP_CONFIG, () =>
        this.finishError(suiteRunId, sessionId, error),
      )

      throw error
    }
  }

  /**
   * Decides what the suite will run, and claims it.
   *
   * The membership is fixed here and never re-read: an intent created while the
   * suite is running belongs to the next suite, not this one, and the counts
   * shown against `totalCount` have to mean something for the whole of it.
   * Order is by creation, which is the only ordering a person can predict.
   */
  private async load(suiteRunId: string, organizationId: string): Promise<LoadedSuite> {
    const db = createDb(this.env.DB)

    const [row] = await db
      .select({ suiteRun })
      .from(suiteRun)
      .innerJoin(project, eq(project.id, suiteRun.projectId))
      .where(and(eq(suiteRun.id, suiteRunId), eq(project.organizationId, organizationId)))
      .limit(1)

    if (!row) {
      throw new NonRetryableError(`Suite run ${suiteRunId} does not exist in this organization.`)
    }

    const members = await db
      .select({ intentId: intent.id, scriptVersionId: intent.currentVersionId })
      .from(intent)
      .where(and(eq(intent.projectId, row.suiteRun.projectId), isNotNull(intent.currentVersionId)))
      .orderBy(asc(intent.createdAt))

    if (members.length === 0) {
      // Guarded in `runSuite` too; reaching it here means every script was
      // deleted between queueing and starting, and there is nothing to say.
      throw new NonRetryableError(`Suite run ${suiteRunId} has no runnable intents.`)
    }

    await db
      .update(suiteRun)
      .set({ status: 'running', totalCount: members.length })
      .where(eq(suiteRun.id, suiteRunId))

    return {
      projectId: row.suiteRun.projectId,
      environmentId: row.suiteRun.environmentId,
      trigger: row.suiteRun.trigger,
      // `currentVersionId` is nullable on the column but not in this result —
      // the query filtered the nulls out.
      members: members.map((member) => ({
        intentId: member.intentId,
        scriptVersionId: member.scriptVersionId!,
      })),
    }
  }

  /**
   * One member, start to verdict, on exactly the terms a standalone run gets.
   *
   * The `try` covers the member and nothing else. Anything that escapes it —
   * an execute step that exhausted its retries, a load that found no row — is
   * turned into a verdict on that member's own run and swallowed, because a
   * suite whose fourth intent cannot start still owes an answer about its
   * fifth.
   *
   * Returns the session the next member should join. That is whatever the
   * harness reports having used, which is not always what it was given — and
   * `null` after a member that never got as far as reporting, so the next one
   * starts clean rather than chasing a session that may be the reason this one
   * failed.
   */
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
        // `keepAlive` for every member without exception: the suite owns the
        // session's lifetime, so no member may end one the next one needs.
        executeRun(this.env, runId, loaded, { sessionId, keepAlive: true }),
      )

      sessionId = executed.sessionId

      await step.do(`${label}-persist`, () => persistRun(this.env, runId, loaded, executed))
    } catch (error) {
      // Only a browser that would not come up escapes `executeRun`, so the
      // session is exactly what is in doubt here. Dropping it costs one
      // acquisition; keeping a dead one would cost every member after this.
      sessionId = null

      await step.do(`${label}-persist-error`, PERSIST_ERROR_STEP_CONFIG, () =>
        persistRunError(this.env, runId, error),
      )
    }

    // Outside the `catch` so the strip moves whether the member passed or blew
    // up, and after it so the counts it reads include this member's verdict.
    await step.do(`${label}-tally`, () => this.tally(suiteRunId))

    return sessionId
  }

  /** The member's run row, indistinguishable from a hand-started one but for `suiteRunId`. */
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
        projectId: suite.projectId,
        scriptVersionId: member.scriptVersionId,
        suiteRunId,
        status: 'queued',
        // A suite's trigger is a run trigger too, so history reads the same
        // whichever level you look at it from.
        trigger: suite.trigger,
        startedAt: new Date(),
      })
      .onConflictDoNothing()

    return { runId }
  }

  /** Progress, written after every member so a poll can watch it move. */
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

  /**
   * The aggregate verdict.
   *
   * `passed` is the strict reading: every member the suite set out to run has
   * to have passed, so a member whose row vanished mid-suite reads as `error`
   * rather than quietly rounding up to green.
   */
  private async finish(
    suiteRunId: string,
    sessionId: string | null,
  ): Promise<{
    suiteRunId: string
    status: SuiteRunStatus
  }> {
    const db = createDb(this.env.DB)

    // Before the verdict, not after: the session is a shared, scarce resource
    // and this step is the only place that is certain no member still wants it.
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

  /**
   * The safety net, guarded the same way `persistRunError` is: it may only
   * claim a suite, or a member, that has not already reached a verdict.
   */
  private async finishError(
    suiteRunId: string,
    sessionId: string | null,
    error: unknown,
  ): Promise<void> {
    const db = createDb(this.env.DB)

    // The suite is over however it ended, and a session nobody will reuse holds
    // one of the account's few concurrent slots until its keep-alive lapses.
    if (sessionId) await releaseRunSession(this.env, sessionId)

    // Members that never got their own answer, first — a run left at 'running'
    // is indistinguishable in the UI from one still going, and nothing is
    // coming back for it. Tallying afterwards is what makes the suite's counts
    // agree with the rows underneath it.
    await db
      .update(run)
      .set({ status: 'error', finishedAt: new Date() })
      .where(and(eq(run.suiteRunId, suiteRunId), inArray(run.status, [...UNFINISHED_RUN_STATUSES])))

    const counts = await tallySuite(this.env, suiteRunId)

    await db
      .update(suiteRun)
      .set({
        status: 'error',
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
