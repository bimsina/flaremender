import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'

import type { RunStatus } from '#/db/schema/app.ts'
import {
  EXECUTE_STEP_CONFIG,
  PERSIST_ERROR_STEP_CONFIG,
  executeRun,
  loadRun,
  persistRun,
  persistRunError,
} from '#/engine/run-steps.ts'

export interface RunWorkflowParams {
  runId: string
  organizationId: string
}

export class RunWorkflow extends WorkflowEntrypoint<Cloudflare.Env, RunWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<RunWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ runId: string; status: RunStatus }> {
    const { runId, organizationId } = event.payload

    try {
      const loaded = await step.do('load', () => loadRun(this.env, runId, organizationId))

      const executed = await step.do('execute', EXECUTE_STEP_CONFIG, () =>
        executeRun(this.env, runId, loaded),
      )

      return await step.do('persist', () => persistRun(this.env, runId, loaded, executed))
    } catch (error) {
      await step.do('persist-error', PERSIST_ERROR_STEP_CONFIG, () =>
        persistRunError(this.env, runId, error),
      )

      throw error
    }
  }
}
