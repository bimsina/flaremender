import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'

import type { GenerationJobStatus } from '#/db/schema/app.ts'
import { runGenerationJob } from '#/engine/generation/job.ts'

export interface GenerateWorkflowParams {
  jobId: string
  intentId: string
  environmentId: string
  organizationId: string
  userId: string
}

export class GenerateWorkflow extends WorkflowEntrypoint<Cloudflare.Env, GenerateWorkflowParams> {
  override run(
    event: Readonly<WorkflowEvent<GenerateWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ jobId: string; status: GenerationJobStatus }> {
    const { jobId, intentId, organizationId } = event.payload

    return runGenerationJob(this.env, step, { jobId, intentId, organizationId })
  }
}
