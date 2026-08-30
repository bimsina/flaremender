/**
 * An approved plan, generated one test at a time.
 *
 * The same relationship to `GenerateWorkflow` that `SuiteWorkflow` has to
 * `RunWorkflow`: a batch is not a new kind of work, it is the ordinary kind
 * repeated. Each member gets a real `generation_job` row, its own `RunChannel`,
 * its own verification run and its own version history, produced by the exact
 * function a standalone Generate button calls. What a batch adds is three
 * things:
 *
 * - **Order.** Members generate strictly one after another. Each one holds a
 *   browser session for its whole turn loop and Browser Rendering allows very
 *   few concurrent sessions, so a batch that fanned out would spend its time
 *   collecting 429s. Sequential is not a simplification here, it is the shape
 *   the platform wants.
 * - **Isolation.** A member that fails does not end the batch. Generation
 *   already refuses to discard work — a job that gets stuck saves its verified
 *   prefix as a draft with a note — so a failed member leaves the user
 *   something to open, and the next one starts.
 * - **One thing to watch.** The batch has its own channel, and narrates which
 *   member it is on. The members' own cards, statuses and histories are
 *   unchanged; this is the strip across the top, not a replacement for them.
 *
 * **Each member takes a fresh browser session.** Sharing one across generations
 * was considered and rejected for v1: a generation's whole premise is that the
 * saved script is verified from a *cold* browser, and a session carried over
 * from the previous member arrives signed in, with cookies, on some other page.
 * The turn loop would then build the next flow on top of state its script does
 * not create — which is precisely the bug the verification run exists to catch,
 * except it would catch it every time and every member after the first would
 * fail. The cost is one session acquisition per member, paid sequentially; the
 * alternative is a batch that cannot produce a working script.
 *
 * Step budget: Workflows allows 1,024 steps per instance and a generation costs
 * about thirty, which is why `MAX_BATCH_INTENTS` is fifteen.
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'

import { createDb } from '#/db/index.ts'
import type { GenerationJobStatus } from '#/db/schema/app.ts'
import { generationJob, intent, project } from '#/db/schema/app.ts'
import { runGenerationJob } from '#/engine/generation/job.ts'
import { PERSIST_ERROR_STEP_CONFIG, announceRun } from '#/engine/run-steps.ts'

export interface BatchWorkflowParams {
  jobId: string
  environmentId: string
  /** Taken from the session at enqueue time; never from anything a row says. */
  organizationId: string
  /** Who approved the plan. Agent-authored versions still belong to a person. */
  userId: string
  /**
   * The plan, in the order it was approved. A filter rather than a membership:
   * an id whose intent has since been deleted is dropped by the load step.
   */
  intentIds: Array<string>
}

interface BatchMember {
  intentId: string
  title: string
  /** The child job's id — derived, so a retried create writes the same row. */
  jobId: string
}

interface LoadedBatch {
  projectId: string
  environmentId: string
  organizationId: string
  userId: string
  members: Array<BatchMember>
}

/**
 * A member's job id, derived rather than random.
 *
 * `member-N-create` is a retryable step: a random id would leave an orphan job
 * row behind every time the step committed and then failed on its way out.
 * Derived from the batch and the member's position, the retry writes the same
 * row — and the `gen_` prefix keeps it a generation everywhere else in the
 * system, including the socket check and `derivedId` in `generation/steps.ts`.
 */
function memberJobId(batchJobId: string, index: number): string {
  return `gen_${batchJobId.replace(/^bat_/, '')}_${String(index).padStart(3, '0')}`
}

export class BatchGenerateWorkflow extends WorkflowEntrypoint<Cloudflare.Env, BatchWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<BatchWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ jobId: string; status: GenerationJobStatus; passed: number; total: number }> {
    const { jobId, organizationId } = event.payload

    try {
      const batch = await step.do('load', () => this.load(event.payload))

      let passed = 0

      for (const [index, member] of batch.members.entries()) {
        await step.do(`member-${index}-create`, () => this.createMemberJob(batch, member))

        await announceRun(this.env, jobId, {
          type: 'log',
          runId: jobId,
          line: `Writing test ${index + 1} of ${batch.members.length}: “${member.title}”.`,
          at: Date.now(),
        })

        // The whole point of the batch. Anything that escapes a generation has
        // already exhausted its own retries and written its own verdict, so it
        // is swallowed here: a batch whose third test cannot be written still
        // owes an answer about its fourth.
        try {
          const result = await runGenerationJob(this.env, step, {
            jobId: member.jobId,
            intentId: member.intentId,
            organizationId,
            label: `member-${index}-`,
          })

          if (result.status === 'succeeded') passed += 1
        } catch (error) {
          console.error(`[batch] ${jobId} member ${member.jobId} failed:`, error)
        }
      }

      return await step.do('finish', () => this.finish(jobId, passed, batch.members.length))
    } catch (error) {
      await step.do('batch-error', PERSIST_ERROR_STEP_CONFIG, () => this.finishError(jobId, error))
      throw error
    }
  }

  /**
   * Decides what the batch will generate, and claims it.
   *
   * The membership is fixed here and never re-read, and the order is the order
   * the plan was approved in — which is the order the explorer proposed them,
   * which is roughly most-important-first.
   */
  private async load(params: BatchWorkflowParams): Promise<LoadedBatch> {
    const db = createDb(this.env.DB)

    const [row] = await db
      .select({ job: generationJob })
      .from(generationJob)
      .innerJoin(project, eq(project.id, generationJob.projectId))
      .where(
        and(
          eq(generationJob.id, params.jobId),
          eq(project.organizationId, params.organizationId),
          eq(generationJob.organizationId, params.organizationId),
        ),
      )
      .limit(1)

    if (!row) {
      throw new NonRetryableError(`Batch job ${params.jobId} does not exist in this organization.`)
    }

    const found = await db
      .select({ id: intent.id, title: intent.title })
      .from(intent)
      .where(and(eq(intent.projectId, row.job.projectId), inArray(intent.id, params.intentIds)))
      .orderBy(asc(intent.createdAt))

    // The approved order wins over the database's; `intentIds` is the plan as
    // the person ticked it.
    const byId = new Map(found.map((item) => [item.id, item.title]))
    const members: Array<BatchMember> = []

    for (const intentId of params.intentIds) {
      const title = byId.get(intentId)
      if (title === undefined) continue
      members.push({ intentId, title, jobId: memberJobId(params.jobId, members.length) })
    }

    if (members.length === 0) {
      throw new NonRetryableError(`Batch job ${params.jobId} has no intents left to generate.`)
    }

    await db
      .update(generationJob)
      .set({ status: 'running', turns: members.length })
      .where(eq(generationJob.id, params.jobId))

    await announceRun(this.env, params.jobId, {
      type: 'run.started',
      runId: params.jobId,
      at: Date.now(),
    })

    return {
      projectId: row.job.projectId,
      environmentId: row.job.environmentId,
      organizationId: params.organizationId,
      userId: params.userId,
      members,
    }
  }

  /**
   * The member's job row, indistinguishable from one the Generate button made.
   *
   * Written here rather than when the batch was queued so that the row exists
   * immediately before the generation that claims it — a job sitting `'queued'`
   * for the ten minutes its predecessor takes would block the Generate button
   * on that intent for no reason, since `assertNoGenerationInFlight` counts
   * queued jobs.
   */
  private async createMemberJob(
    batch: LoadedBatch,
    member: BatchMember,
  ): Promise<{ jobId: string }> {
    const db = createDb(this.env.DB)

    await db
      .insert(generationJob)
      .values({
        id: member.jobId,
        kind: 'generate',
        intentId: member.intentId,
        projectId: batch.projectId,
        environmentId: batch.environmentId,
        organizationId: batch.organizationId,
        status: 'queued',
        createdBy: batch.userId,
      })
      .onConflictDoNothing()

    return { jobId: member.jobId }
  }

  /**
   * The aggregate. `succeeded` is the strict reading — every member had to have
   * produced a verified script — because a batch that half worked should not
   * report the same thing as one that worked.
   */
  private async finish(
    jobId: string,
    passed: number,
    total: number,
  ): Promise<{ jobId: string; status: GenerationJobStatus; passed: number; total: number }> {
    const db = createDb(this.env.DB)
    const status: GenerationJobStatus = passed === total ? 'succeeded' : 'failed'

    const reason =
      passed === total
        ? null
        : passed === 0
          ? 'None of the tests could be generated. Open them to see how far each got.'
          : `${total - passed} of ${total} tests did not verify. Open them to see how far each got.`

    await db
      .update(generationJob)
      .set({ status, stuckReason: reason, finishedAt: new Date() })
      .where(eq(generationJob.id, jobId))

    await announceRun(
      this.env,
      jobId,
      {
        type: 'run.finished',
        runId: jobId,
        outcome: passed === total ? 'passed' : 'failed',
        errorMessage: reason,
        at: Date.now(),
      },
      { final: true },
    )

    return { jobId, status, passed, total }
  }

  /** The safety net, guarded so a late failure cannot rewrite an earned verdict. */
  private async finishError(jobId: string, error: unknown): Promise<void> {
    const db = createDb(this.env.DB)

    await db
      .update(generationJob)
      .set({
        status: 'failed',
        stuckReason: 'The batch could not be completed.',
        finishedAt: new Date(),
      })
      .where(and(eq(generationJob.id, jobId), inArray(generationJob.status, ['queued', 'running'])))

    console.error(`[batch] ${jobId} failed:`, error)

    await announceRun(
      this.env,
      jobId,
      {
        type: 'run.finished',
        runId: jobId,
        outcome: 'error',
        errorMessage: 'The batch could not be completed.',
        at: Date.now(),
      },
      { final: true },
    )
  }
}
