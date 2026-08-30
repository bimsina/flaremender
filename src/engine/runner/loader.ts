/**
 * Handing a saved script to a Dynamic Worker.
 *
 * The isolate is built from exactly two modules — the pre-bundled harness and
 * the user's script — and given four bindings: the Browser Rendering binding,
 * the decrypted credentials, the base URL and a stub for this run's live
 * channel. Notably absent: `DB`, `ARTIFACTS`, `AI`, `LOADER` and ambient network
 * access (`globalOutbound: null`). A script that goes looking for `env` from
 * inside the isolate finds nothing that belongs to another tenant, which is the
 * whole reason execution happens out here rather than in the Workflow's own
 * isolate.
 *
 * The channel stub is the one addition that reaches back out, and it is
 * deliberately the narrowest thing that could: it addresses a single run's
 * Durable Object — the run being executed — and that object's only write method
 * appends an event to that run's own progress feed. A hostile script can spam
 * its own progress panel. It cannot read anything, reach another run, or learn
 * that other runs exist.
 */
import type {
  ActResponse,
  AttachRequest,
  HarnessRequest,
  HarnessResponse,
  ObserveResponse,
  SessionStartRequest,
  SessionStartResponse,
} from '#/engine/contract.ts'
import HARNESS_SOURCE from '#/engine/harness/harness.generated.js?raw'

/** Must be new enough for workerd's real `node:fs`, which traces need. */
const HARNESS_COMPATIBILITY_DATE = '2026-08-01'

const HARNESS_MODULE = 'harness.js'
const SCRIPT_MODULE = 'user-script.js'

/**
 * Whole-script budget. Workflow steps have no wall-clock limit; runs need one.
 * Must stay below the session keep-alive (so the budget fires before idle
 * death) and the workflow's execute-step timeout (so the failure is a result,
 * not a step error). Fixed for now; a per-intent override is a later add.
 */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 300_000

/** Per-fragment budget during generation. Far shorter than a whole script. */
export const DEFAULT_FRAGMENT_TIMEOUT_MS = 60_000

/**
 * What one Playwright call may take while a model is writing the script.
 *
 * A third of what a real run allows, and deliberately so. In a run, a slow
 * locator is usually a slow page and waiting is the right thing to do. In
 * generation it is nearly always a locator that will never match — a
 * `getByLabel` on a field that only has a placeholder — and every one of those
 * costs the job a wait it will spend again on the next guess. Failing in ten
 * seconds instead of thirty buys two more attempts inside the same budget,
 * which is worth far more than the rare slow page it gives up on. The saved
 * script is verified at the full run timeout, so nothing generous is lost.
 */
export const GENERATION_ACTION_TIMEOUT_MS = 10_000

/** How much aria snapshot the model is shown per observation. */
export const DEFAULT_SNAPSHOT_LIMIT = 10_000

/** The subset of the harness entrypoint the host calls. */
interface HarnessStub {
  execute(request: HarnessRequest): Promise<HarnessResponse>
  startSession(request: SessionStartRequest): Promise<SessionStartResponse>
  observe(request: AttachRequest): Promise<ObserveResponse>
  act(request: AttachRequest): Promise<ActResponse>
  release(sessionId: string): Promise<{ released: boolean; message?: string }>
}

/** What every isolate this module builds is given, and nothing more. */
interface HarnessBindings {
  browser: Cloudflare.Env['BROWSER']
  creds: Record<string, string>
  baseUrl: string
  runId: string
  channel?: RunChannelStub | null
}

/**
 * Builds the isolate. Every entry point below differs only in what it hands the
 * module slot and which method it then calls, so the load itself is stated once.
 */
function loadHarness(loader: WorkerLoader, code: string, bindings: HarnessBindings): HarnessStub {
  const worker = loader.load({
    compatibilityDate: HARNESS_COMPATIBILITY_DATE,
    // Playwright reaches for `node:fs`, `node:events` and friends.
    compatibilityFlags: ['nodejs_compat'],
    mainModule: HARNESS_MODULE,
    modules: {
      [HARNESS_MODULE]: HARNESS_SOURCE,
      [SCRIPT_MODULE]: code,
    },
    env: {
      BROWSER: bindings.browser,
      CREDS: bindings.creds,
      BASE_URL: bindings.baseUrl,
      RUN_ID: bindings.runId,
      CHANNEL: bindings.channel ?? null,
    },
    // No ambient `fetch`. Bindings still work, so the browser is still reachable.
    globalOutbound: null,
  })

  return worker.getEntrypoint() as unknown as HarnessStub
}

/**
 * Stands in for the saved script when the isolate is loaded for something other
 * than running one. The module slot is not optional — the harness imports it
 * statically — but `release` never reaches for it.
 */
const NO_SCRIPT = 'export default async function () {}\n'

/** A stub for one run's `RunChannel`, as `RUN_CHANNEL.getByName()` returns it. */
type RunChannelStub = ReturnType<Cloudflare.Env['RUN_CHANNEL']['getByName']>

export interface ExecuteOptions {
  loader: WorkerLoader
  /** Passed through untouched; the harness is what calls Playwright on it. */
  browser: Cloudflare.Env['BROWSER']
  /** The run being executed; only used to label the events it emits. */
  runId: string
  /** The saved script, verbatim. */
  code: string
  baseUrl: string
  /** Decrypted environment variables, keyed by name. */
  creds: Record<string, string>
  /** This run's live channel. Omit to run without streaming. */
  channel?: RunChannelStub | null
  timeoutMs?: number
  actionTimeoutMs?: number
  trace?: boolean
  /**
   * A Browser Rendering session to join rather than take. Set by a suite from
   * its second member on; the response says which session actually ran.
   */
  sessionId?: string | null
  /** Leave the session running when the script finishes. A suite's business. */
  keepSessionAlive?: boolean
}

/**
 * Loads the isolate and runs the script once.
 *
 * Rejects only when the isolate itself could not be built or reached — a syntax
 * error in the script surfaces here, as a module-graph failure, and the caller
 * turns it into an `'error'` result. Everything the script *does* comes back
 * inside the response.
 */
export async function executeInDynamicWorker(options: ExecuteOptions): Promise<HarnessResponse> {
  const harness = loadHarness(options.loader, options.code, {
    browser: options.browser,
    creds: options.creds,
    baseUrl: options.baseUrl,
    runId: options.runId,
    channel: options.channel,
  })

  return harness.execute({
    timeoutMs: options.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
    actionTimeoutMs: options.actionTimeoutMs ?? 30_000,
    trace: options.trace ?? true,
    sessionId: options.sessionId ?? null,
    keepSessionAlive: options.keepSessionAlive ?? false,
  })
}

/**
 * Ends a Browser Rendering session the host cannot reach itself.
 *
 * Closing a session means speaking CDP to it, and CDP lives in Playwright,
 * which lives in the harness bundle — the host Worker has neither. So the
 * cheapest thing that can do it is a fresh isolate carrying no script, no
 * credentials and no channel: the browser binding is the only capability it
 * gets, and the only thing it does with it is hang up.
 */
export async function releaseBrowserSession(options: {
  loader: WorkerLoader
  browser: Cloudflare.Env['BROWSER']
  sessionId: string
}): Promise<{ released: boolean; message?: string }> {
  const harness = loadHarness(options.loader, NO_SCRIPT, {
    browser: options.browser,
    creds: {},
    baseUrl: '',
    runId: '',
  })

  return harness.release(options.sessionId)
}

/* --------------------------------------------------------- Generation mode */

/**
 * The three calls a generation loop makes, and how they differ from a run.
 *
 * A run is one isolate for one script. Generation is one isolate *per turn* —
 * the model writes a fragment, the fragment executes, the model sees what
 * happened and writes the next one — because a Worker Loader stub cannot cross
 * a Workflow step boundary any more than a browser can. What holds the flow
 * together across all those isolates is the Browser Rendering session, which is
 * opened once by `startGenerationSession` and joined by everything after it.
 *
 * **All three are given the credentials, including the two that run no script.**
 * `act` needs them because `secret('NAME')` has to resolve to a real value for
 * the fragment to sign in. `observe` and `startSession` need them for the
 * opposite reason: the scrubber is built from the values, so an isolate handed
 * an empty set has nothing to redact *with*, and every page it reads goes to
 * the model verbatim.
 *
 * That is not hypothetical. An aria snapshot carries the text of the page,
 * which routinely includes the very value that was just typed into it — a demo
 * site that prints its own password, a form that reflects what you filled in, a
 * token in the URL. Withholding the credentials from the two calls that only
 * *look* at the page reads like least privilege and is the opposite: it is
 * precisely the path by which a secret reaches the model, the transcript and
 * durable workflow storage.
 */
export interface GenerationSessionOptions {
  loader: WorkerLoader
  browser: Cloudflare.Env['BROWSER']
  baseUrl: string
  /** Decrypted environment variables — what the scrubber is built from. */
  creds: Record<string, string>
  actionTimeoutMs?: number
  snapshotLimit?: number
}

export async function startGenerationSession(
  options: GenerationSessionOptions,
): Promise<SessionStartResponse> {
  const harness = loadHarness(options.loader, NO_SCRIPT, {
    browser: options.browser,
    creds: options.creds,
    baseUrl: options.baseUrl,
    runId: '',
  })

  return harness.startSession({
    actionTimeoutMs: options.actionTimeoutMs ?? GENERATION_ACTION_TIMEOUT_MS,
    snapshotLimit: options.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT,
  })
}

export async function observeInDynamicWorker(
  options: GenerationSessionOptions & { sessionId: string },
): Promise<ObserveResponse> {
  const harness = loadHarness(options.loader, NO_SCRIPT, {
    browser: options.browser,
    creds: options.creds,
    baseUrl: options.baseUrl,
    runId: '',
  })

  return harness.observe({
    sessionId: options.sessionId,
    actionTimeoutMs: options.actionTimeoutMs ?? GENERATION_ACTION_TIMEOUT_MS,
    timeoutMs: DEFAULT_FRAGMENT_TIMEOUT_MS,
    snapshotLimit: options.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT,
  })
}

export async function actInDynamicWorker(
  options: GenerationSessionOptions & {
    sessionId: string
    /** The fragment, already wrapped into the module shape the harness runs. */
    code: string
    /** The generation job's channel, so executed steps stream live. */
    channel?: RunChannelStub | null
    /** The job id — what the streamed events are labelled with. */
    jobId: string
    stepIndexOffset?: number
    timeoutMs?: number
  },
): Promise<ActResponse> {
  const harness = loadHarness(options.loader, options.code, {
    browser: options.browser,
    creds: options.creds,
    baseUrl: options.baseUrl,
    runId: options.jobId,
    channel: options.channel,
  })

  return harness.act({
    sessionId: options.sessionId,
    actionTimeoutMs: options.actionTimeoutMs ?? GENERATION_ACTION_TIMEOUT_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_FRAGMENT_TIMEOUT_MS,
    snapshotLimit: options.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT,
    stepIndexOffset: options.stepIndexOffset ?? 0,
  })
}
