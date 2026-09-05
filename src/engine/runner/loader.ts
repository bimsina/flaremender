/** Untrusted scripts must never receive DB, R2, AI or unrestricted outbound access. */
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

const HARNESS_COMPATIBILITY_DATE = '2026-08-01'

const HARNESS_MODULE = 'harness.js'
const SCRIPT_MODULE = 'user-script.js'

export const DEFAULT_SCRIPT_TIMEOUT_MS = 300_000

export const DEFAULT_FRAGMENT_TIMEOUT_MS = 60_000

export const GENERATION_ACTION_TIMEOUT_MS = 10_000

export const DEFAULT_SNAPSHOT_LIMIT = 10_000

interface HarnessStub {
  execute(request: HarnessRequest): Promise<HarnessResponse>
  startSession(request: SessionStartRequest): Promise<SessionStartResponse>
  observe(request: AttachRequest): Promise<ObserveResponse>
  act(request: AttachRequest): Promise<ActResponse>
  release(sessionId: string): Promise<{ released: boolean; message?: string }>
}

interface HarnessBindings {
  browser: Cloudflare.Env['BROWSER']
  creds: Record<string, string>
  baseUrl: string
  runId: string
  channel?: RunChannelStub | null
}

function loadHarness(loader: WorkerLoader, code: string, bindings: HarnessBindings): HarnessStub {
  const worker = loader.load({
    compatibilityDate: HARNESS_COMPATIBILITY_DATE,
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
    globalOutbound: null,
  })

  return worker.getEntrypoint() as unknown as HarnessStub
}

const NO_SCRIPT = 'export default async function () {}\n'

type RunChannelStub = ReturnType<Cloudflare.Env['RUN_CHANNEL']['getByName']>

export interface ExecuteOptions {
  loader: WorkerLoader
  browser: Cloudflare.Env['BROWSER']
  runId: string
  code: string
  baseUrl: string
  creds: Record<string, string>
  channel?: RunChannelStub | null
  timeoutMs?: number
  actionTimeoutMs?: number
  trace?: boolean
  sessionId?: string | null
  keepSessionAlive?: boolean
}

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

export interface GenerationSessionOptions {
  loader: WorkerLoader
  browser: Cloudflare.Env['BROWSER']
  baseUrl: string
  creds: Record<string, string>
  actionTimeoutMs?: number
  snapshotLimit?: number
}

export async function startGenerationSession(
  options: GenerationSessionOptions & { channel?: RunChannelStub | null; jobId?: string },
): Promise<SessionStartResponse> {
  const harness = loadHarness(options.loader, NO_SCRIPT, {
    browser: options.browser,
    creds: options.creds,
    baseUrl: options.baseUrl,
    runId: options.jobId ?? '',
    channel: options.channel,
  })

  return harness.startSession({
    actionTimeoutMs: options.actionTimeoutMs ?? GENERATION_ACTION_TIMEOUT_MS,
    snapshotLimit: options.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT,
  })
}

export async function observeInDynamicWorker(
  options: GenerationSessionOptions & {
    sessionId: string
    channel?: RunChannelStub | null
    jobId?: string
  },
): Promise<ObserveResponse> {
  const harness = loadHarness(options.loader, NO_SCRIPT, {
    browser: options.browser,
    creds: options.creds,
    baseUrl: options.baseUrl,
    runId: options.jobId ?? '',
    channel: options.channel,
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
    code: string
    channel?: RunChannelStub | null
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
