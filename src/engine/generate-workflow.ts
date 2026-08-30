/**
 * One intent's script, as a workflow.
 *
 * Deliberately almost nothing: the generation itself lives in
 * `generation/job.ts`, because `BatchGenerateWorkflow` runs exactly the same
 * thing several times over and the two must not be allowed to drift. What this
 * class contributes is the *binding* — a name in `wrangler.jsonc`, a params
 * shape, and an instance id that matches the job row so the live channel, the
 * socket check and the workflow all agree on one handle.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'

import type { GenerationJobStatus } from '#/db/schema/app.ts'
import { runGenerationJob } from '#/engine/generation/job.ts'

export interface GenerateWorkflowParams {
  jobId: string
  intentId: string
  environmentId: string
  /** Taken from the session at enqueue time; never from anything a row says. */
  organizationId: string
  /** Who asked. Agent-authored versions are still attributed to a person. */
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
