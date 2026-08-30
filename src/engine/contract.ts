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
  /**
   * The Browser Rendering session the script actually ran in.
   *
   * Not necessarily the one that was asked for: a session can be reclaimed
   * between two members of a suite, and the harness silently takes a fresh one
   * rather than failing the run. The caller threads whatever comes back into
   * the next member, so this is how a suite finds out its session changed.
   */
  sessionId: string | null
  /** Whether the requested session was still there. Diagnostic only. */
  sessionReused: boolean
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
  /**
   * A Browser Rendering session to join instead of taking a new one. Set by a
   * suite from the second member on; a dead id degrades to a fresh session
   * rather than to a failed run.
   */
  sessionId?: string | null
  /**
   * Whether the session must outlive this script. Set for every member of a
   * suite: the session is shared, and ending it is the suite's job alone.
   */
  keepSessionAlive?: boolean
}

/* ------------------------------------------------------------- Generation */

/**
 * What the page looks like right now, in the terms a language model can act on.
 *
 * Deliberately not a screenshot: a script is written against the accessibility
 * tree — roles, names, labels — so showing the model the same tree its locators
 * will resolve against is what makes `getByRole('button', { name: 'Login' })`
 * a thing it can *read off* the page rather than guess at.
 */
export interface PageObservation {
  url: string
  title: string
  /** Aria snapshot in Playwright's YAML dialect, already scrubbed. */
  snapshot: string
  /** Whether the snapshot had to be trimmed to fit the budget. */
  truncated: boolean
}

/**
 * The three generation-time harness calls all attach to a session that is
 * already open, act on the page that is already there, and leave both running.
 *
 * That is the whole difference from `execute`, and it is not a small one: the
 * generation loop is a *conversation* with a live browser, so state has to
 * survive from one fragment to the next. A fresh incognito context per call —
 * which is exactly right for a run — would reset the flow to a signed-out home
 * page every turn.
 */
export interface AttachRequest {
  /** The session to join. Owned by the workflow, never ended by these calls. */
  sessionId: string
  actionTimeoutMs: number
  /** Wall-clock budget for one fragment. */
  timeoutMs: number
  /** How many characters of aria snapshot to bring back. */
  snapshotLimit: number
  /**
   * Where this fragment's live step numbering continues from. Each fragment
   * runs in its own isolate and would otherwise start counting at zero, which
   * the UI keys on and would collapse into the previous fragment's steps.
   */
  stepIndexOffset?: number
}

/** Opening the loop's session: take one, land on the base URL, look around. */
export interface SessionStartRequest {
  actionTimeoutMs: number
  snapshotLimit: number
}

export interface SessionStartResponse {
  sessionId: string | null
  observation: PageObservation | null
  errorMessage: string | null
}

export interface ObserveResponse {
  observation: PageObservation | null
  errorMessage: string | null
  /**
   * The session itself could not be joined. Distinct from every other failure
   * because it is the only one the loop recovers from by starting again rather
   * than by asking the model to try something else.
   */
  sessionLost: boolean
}

/** What one candidate fragment did to the live page. */
export interface ActResponse {
  ok: boolean
  steps: Array<RunStep>
  logs: Array<string>
  errorMessage: string | null
  /** The page after the fragment ran — present even when it threw. */
  observation: PageObservation | null
  durationMs: number
  sessionLost: boolean
}

/**
 * A live progress event.
 *
 * `index` counts the order steps *started* in, not the order they finished, so
 * a `step.started` and its `step.finished` always carry the same number and the
 * UI can key on it. Every event is already scrubbed by whoever produced it —
 * step events are redacted inside the harness, where the plaintext lives.
 *
 * `runId` is really the *channel* id: a run streams under its own id, and a
 * generation job streams under the job id. The field keeps its name because the
 * events, the Durable Object and the client are otherwise identical, and giving
 * the two producers different wire formats would buy nothing.
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
