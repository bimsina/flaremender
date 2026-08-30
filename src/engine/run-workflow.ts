/**
 * One intent, executed once.
 *
 * The workflow is deliberately nothing but an ordering: load, execute, persist,
 * and a safety net if any of that will not complete. What each of those means
 * lives in `run-steps.ts`, shared verbatim with `SuiteWorkflow` — a suite member
 * and a standalone run are the same execution, and this file exists to say what
 * a *single* one of them is durable across, not to redefine it.
 *
 * The step boundaries are where the durability is, and they are chosen so that
 * only the middle one touches the outside world: it is the only one worth
 * retrying, and the only one that ever holds a decrypted credential.
 */
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
  /** Taken from the session at enqueue time; never from anything the run says. */
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

      // One retry buys a transient browser 429 or a lost session another go.
      // A script that failed on its own terms never reaches this path.
      const executed = await step.do('execute', EXECUTE_STEP_CONFIG, () =>
        executeRun(this.env, runId, loaded),
      )

      return await step.do('persist', () => persistRun(this.env, runId, loaded, executed))
    } catch (error) {
      // Whatever went wrong, the run must not sit at 'running' forever.
      await step.do('persist-error', PERSIST_ERROR_STEP_CONFIG, () =>
        persistRunError(this.env, runId, error),
      )

      throw error
    }
  }
}
