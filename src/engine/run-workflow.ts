/**
 * The run engine.
 *
 * A run is three durable steps: work out what to execute, execute it, record
 * what happened. The split matters because only the middle one touches the
 * outside world — it is the only step worth retrying, and the only one that
 * ever holds a decrypted credential.
 *
 * Two distinctions run through this file:
 *
 * - A **script failure is a result, not an error.** A failing assertion returns
 *   normally from `execute` so Workflows never retries the browser dance over
 *   something that would fail identically the second time. Only a browser that
 *   would not start throws, and that gets exactly one retry.
 * - **Secrets never reach durable storage.** Decryption happens inside
 *   `execute` and the plaintext dies with it: step return values are persisted
 *   by Workflows, so anything handed between steps has already been scrubbed.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'

import { createDb } from '#/db/index.ts'
import type { ArtifactKeys, RunStatus } from '#/db/schema/app.ts'
import {
  attempt,
  environment,
  environmentVariable,
  intent,
  project,
  run,
  scriptVersion,
} from '#/db/schema/app.ts'
import type { RunOutcome, RunResult } from '#/engine/contract.ts'
import { artifactPrefix, writeArtifacts } from '#/engine/runner/artifacts.ts'
import { executeInDynamicWorker } from '#/engine/runner/loader.ts'
import { createScrubber } from '#/engine/runner/scrub.ts'
import { decryptSecret } from '#/server/crypto.ts'

export interface RunWorkflowParams {
  runId: string
  /** Taken from the session at enqueue time; never from anything the run says. */
  organizationId: string
}

interface LoadedRun {
  intentId: string
  projectId: string
  environmentId: string
  scriptVersionId: string
  code: string
  baseUrl: string
  prefix: string
}

interface ExecutedRun {
  result: RunResult
  artifactKeys: ArtifactKeys
}

/** One attempt per run until the healing loop appends more. */
const ATTEMPT_NUMBER = 1

/**
 * The browser never came up. Distinct from every other failure because it is
 * the only one a retry can plausibly fix — a `429` from Browser Rendering, or a
 * session that vanished — so it is the only one allowed to escape `execute`.
 */
class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserUnavailableError'
  }
}

const OUTCOME_TO_RUN_STATUS: Record<RunOutcome, RunStatus> = {
  passed: 'passed',
  failed: 'failed',
  error: 'error',
}

export class RunWorkflow extends WorkflowEntrypoint<Cloudflare.Env, RunWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<RunWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ runId: string; status: RunStatus }> {
    const { runId, organizationId } = event.payload

    try {
      const loaded = await step.do('load', () => this.load(runId, organizationId))

      const executed = await step.do(
        'execute',
        // One retry buys a transient browser 429 or a lost session another go.
        // A script that failed on its own terms never reaches this path.
        { retries: { limit: 1, delay: '5 seconds' }, timeout: '10 minutes' },
        () => this.execute(loaded),
      )

      return await step.do('persist', () => this.persist(runId, loaded, executed))
    } catch (error) {
      // Whatever went wrong, the run must not sit at 'running' forever.
      await step.do('persist-error', { retries: { limit: 2, delay: '2 seconds' } }, () =>
        this.persistError(runId, error),
      )

      throw error
    }
  }

  /**
   * Resolves the run to the exact bytes that will execute, and claims it.
   *
   * Everything is re-read through the organization the caller was in, so a run
   * row that was somehow retargeted between enqueue and execution resolves to
   * nothing rather than to another tenant's project.
   */
  private async load(runId: string, organizationId: string): Promise<LoadedRun> {
    const db = createDb(this.env.DB)

    const [row] = await db
      .select({
        run,
        environment,
        scriptVersion,
        projectId: project.id,
      })
      .from(run)
      .innerJoin(project, eq(project.id, run.projectId))
      .innerJoin(environment, eq(environment.id, run.environmentId))
      .innerJoin(scriptVersion, eq(scriptVersion.id, run.scriptVersionId))
      .where(and(eq(run.id, runId), eq(project.organizationId, organizationId)))
      .limit(1)

    if (!row) {
      // Retrying cannot conjure a run row; fail the instance immediately.
      throw new NonRetryableError(`Run ${runId} does not exist in this organization.`)
    }

    const prefix = artifactPrefix({ organizationId, projectId: row.projectId, runId })

    await db
      .update(run)
      .set({ status: 'running', artifactPrefix: prefix, workflowInstanceId: runId })
      .where(eq(run.id, runId))

    return {
      intentId: row.run.intentId,
      projectId: row.projectId,
      environmentId: row.run.environmentId,
      scriptVersionId: row.run.scriptVersionId,
      code: row.scriptVersion.code,
      baseUrl: row.environment.baseUrl,
      prefix,
    }
  }

  /**
   * Runs the script in a Dynamic Worker and files what it produced.
   *
   * Throws only for a browser that would not start — the one failure a retry
   * can fix. A broken script, a failed assertion or a timeout all return
   * normally, carrying the outcome the UI will show.
   */
  private async execute(loaded: LoadedRun): Promise<ExecutedRun> {
    const db = createDb(this.env.DB)

    const rows = await db
      .select({
        name: environmentVariable.name,
        encryptedValue: environmentVariable.encryptedValue,
      })
      .from(environmentVariable)
      .where(eq(environmentVariable.environmentId, loaded.environmentId))

    const creds: Record<string, string> = {}
    const undecryptable: Array<string> = []
    for (const row of rows) {
      try {
        creds[row.name] = await decryptSecret(row.encryptedValue)
      } catch {
        // A rotated ENCRYPTION_KEY should read as a missing variable, which the
        // script reports by name, rather than as an opaque engine crash.
        undecryptable.push(row.name)
      }
    }

    // Applied on the way out as well as inside the harness: this is the last
    // point at which the plaintext still exists, and everything downstream —
    // including the Workflow's own step storage — is durable.
    const scrubber = createScrubber(Object.values(creds))

    let result: RunResult
    let screenshot: ArrayBuffer | null = null
    let trace: ArrayBuffer | null = null

    const startedAt = Date.now()

    try {
      const response = await executeInDynamicWorker({
        loader: this.env.LOADER,
        browser: this.env.BROWSER,
        code: loaded.code,
        baseUrl: loaded.baseUrl,
        creds,
      })

      if (response.errorKind === 'browser') {
        throw new BrowserUnavailableError(
          response.result.errorMessage ?? 'The browser session could not be started.',
        )
      }

      result = response.result
      screenshot = response.screenshot
      trace = response.trace
    } catch (error) {
      if (error instanceof BrowserUnavailableError) throw error

      // Anything the isolate could not even start — a syntax error in the saved
      // script is the common one — arrives here as a module-graph failure.
      result = {
        outcome: 'error',
        steps: [],
        errorMessage: error instanceof Error ? error.message : String(error),
        logs: [],
        durationMs: Date.now() - startedAt,
      }
    }

    if (undecryptable.length > 0) {
      result.logs.push(
        `[engine] could not decrypt ${undecryptable.join(', ')} — ENCRYPTION_KEY has changed since they were saved.`,
      )
    }

    const scrubbed: RunResult = {
      outcome: result.outcome,
      steps: result.steps.map((step) => ({
        ...step,
        label: scrubber.text(step.label),
        ...(step.error === undefined ? {} : { error: scrubber.text(step.error) }),
      })),
      errorMessage: scrubber.nullable(result.errorMessage),
      logs: scrubber.lines(result.logs),
      durationMs: result.durationMs,
    }

    const { keys, failures } = await writeArtifacts(this.env.ARTIFACTS, loaded.prefix, {
      screenshot,
      trace,
      result: scrubbed,
    })

    for (const failure of failures)
      scrubbed.logs.push(`[engine] artifact upload failed — ${failure}`)

    return { result: scrubbed, artifactKeys: keys }
  }

  /** The attempt row, the run's verdict and the intent's badge, in one batch. */
  private async persist(
    runId: string,
    loaded: LoadedRun,
    executed: ExecutedRun,
  ): Promise<{ runId: string; status: RunStatus }> {
    const db = createDb(this.env.DB)
    const status = OUTCOME_TO_RUN_STATUS[executed.result.outcome]

    const transcript = [
      ...executed.result.steps.map(
        (step) =>
          `${step.ok ? '✓' : '✘'} ${step.label} (${step.durationMs}ms)${step.error ? `\n    ${step.error}` : ''}`,
      ),
      ...(executed.result.logs.length > 0 ? ['', ...executed.result.logs] : []),
    ].join('\n')

    await db.batch([
      // Deterministic id + do-nothing: `persist` is a retryable step, and the
      // `(runId, attemptNumber)` unique index would otherwise turn a retry into
      // a permanent failure.
      db
        .insert(attempt)
        .values({
          id: `att_${runId.replace(/^run_/, '')}_${ATTEMPT_NUMBER}`,
          runId,
          attemptNumber: ATTEMPT_NUMBER,
          outcome: executed.result.outcome,
          scriptVersionId: loaded.scriptVersionId,
          scriptUsed: loaded.code,
          artifactKeys: executed.artifactKeys,
          logs: transcript,
          errorMessage: executed.result.errorMessage,
          durationMs: executed.result.durationMs,
        })
        .onConflictDoNothing(),
      db.update(run).set({ status, finishedAt: new Date() }).where(eq(run.id, runId)),
      db
        .update(intent)
        .set({ status: status === 'passed' ? 'passing' : 'failing', lastRunId: runId })
        .where(eq(intent.id, loaded.intentId)),
    ])

    return { runId, status }
  }

  /**
   * The safety net. Reached only when a step exhausted its retries, which means
   * the run has no attempt row and no verdict — without this it would show as
   * `running` for ever.
   */
  private async persistError(runId: string, error: unknown): Promise<void> {
    const db = createDb(this.env.DB)

    // Guarded on the non-terminal statuses so a late failure — an artifact
    // upload that threw after `persist` committed, say — cannot rewrite a
    // verdict the run already earned.
    await db
      .update(run)
      .set({ status: 'error', finishedAt: new Date() })
      .where(and(eq(run.id, runId), inArray(run.status, ['queued', 'running'])))

    console.error(`[run-workflow] ${runId} failed:`, error)
  }
}
