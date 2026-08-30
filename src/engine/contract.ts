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
 * A live progress event. Nothing publishes these yet — M6 wires the RunChannel
 * Durable Object up to them — but the harness already produces the data each
 * one carries, so the shape is fixed here rather than invented twice.
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
