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
  organizationId: string
  userId: string
  intentIds: Array<string>
}

interface BatchMember {
  intentId: string
  title: string
  jobId: string
}

interface LoadedBatch {
  projectId: string
  environmentId: string
  organizationId: string
  userId: string
  members: Array<BatchMember>
}

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
