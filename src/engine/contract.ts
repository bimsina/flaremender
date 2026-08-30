/**
 * The wire between the three halves of a run: the Workflow that orchestrates it,
 * the harness that executes the script inside a Dynamic Worker, and the UI that
 * eventually watches it.
 *
 * Everything here is structured-clone friendly — these types cross a Worker
 * Loader RPC boundary, so no classes, no functions, no `undefined`-only fields
 * that matter.
 */

/** How a run ended. A thrown assertion is `'failed'`; anything else is `'error'`. */
export type RunOutcome = 'passed' | 'failed' | 'error'

/**
 * One instrumented Playwright call — an action (`page.getByRole(…).click()`) or
 * an assertion (`expect(…).toBeVisible()`). The harness records these
 * automatically; the script never declares them.
 */
export interface RunStep {
  label: string
  ok: boolean
  durationMs: number
  /** Present only when `ok` is false. Already scrubbed. */
  error?: string
}

/** What one execution of one script produced. Persisted onto the attempt row. */
export interface RunResult {
  outcome: RunOutcome
  steps: Array<RunStep>
  /** Null when the script passed. Already scrubbed by the time it is persisted. */
  errorMessage: string | null
  /** `console.*` from the script plus page console messages, oldest first. */
  logs: Array<string>
  durationMs: number
}

/**
 * Why an `'error'` outcome happened, which decides whether retrying is worth
 * anything. `'browser'` means we never got as far as the user's code, so the
 * Workflow step throws and lets Workflows retry it; everything else is a real
 * result and is persisted as-is.
 */
export type RunErrorKind = 'browser' | 'script' | 'harness'

/** What the harness hands back over RPC. Binary artifacts ride along as bytes. */
export interface HarnessResponse {
  result: RunResult
  errorKind: RunErrorKind | null
  /** PNG bytes of the page at the moment of failure, when one could be taken. */
  screenshot: ArrayBuffer | null
  /** Playwright trace zip, when tracing started successfully. */
  trace: ArrayBuffer | null
}

/**
 * The options the Workflow passes into `harness.execute()`. The base URL and
 * the credentials arrive as *bindings* instead, so they are configuration of
 * the isolate rather than arguments a caller could vary per call.
 */
export interface HarnessRequest {
  /** Wall-clock budget for the whole script, in milliseconds. */
  timeoutMs: number
  /** Per-action Playwright timeout, in milliseconds. */
  actionTimeoutMs: number
  /** Whether to record a Playwright trace. */
  trace: boolean
}

/**
 * A live progress event.
 *
 * `index` counts the order steps *started* in, not the order they finished, so
 * a `step.started` and its `step.finished` always carry the same number and the
 * UI can key on it. Every event is already scrubbed by whoever produced it —
 * step events are redacted inside the harness, where the plaintext lives.
 */
export type RunEvent =
  | { type: 'run.started'; runId: string; at: number }
  | { type: 'step.started'; runId: string; index: number; label: string; at: number }
  | { type: 'step.finished'; runId: string; index: number; step: RunStep; at: number }
  | { type: 'log'; runId: string; line: string; at: number }
  | {
      type: 'run.finished'
      runId: string
      outcome: RunOutcome
      errorMessage: string | null
      at: number
    }

/**
 * How an event travels once the channel has it.
 *
 * The sequence number is assigned by the Durable Object, is unique and
 * monotonic per run, and is what makes a replay and a live broadcast
 * indistinguishable to the client: it drops anything it has already seen.
 */
export interface RunEventEnvelope {
  seq: number
  event: RunEvent
}

/**
 * The only thing the harness is allowed to do with its channel.
 *
 * Declared here rather than imported from `run-channel.ts` so the harness
 * bundle never pulls the Durable Object implementation in — and so the sandbox's
 * view of the channel is, in the type system as well as in practice, one method.
 */
export interface RunChannelSink {
  push(event: RunEvent): Promise<void>
}
