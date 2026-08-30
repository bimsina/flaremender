/**
 * Handing a saved script to a Dynamic Worker.
 *
 * The isolate is built from exactly two modules — the pre-bundled harness and
 * the user's script — and given exactly three bindings: the Browser Rendering
 * binding, the decrypted credentials and the base URL. Notably absent: `DB`,
 * `ARTIFACTS`, `AI`, `LOADER` and ambient network access (`globalOutbound:
 * null`). A script that goes looking for `env` from inside the isolate finds
 * nothing that belongs to another tenant, which is the whole reason execution
 * happens out here rather than in the Workflow's own isolate.
 */
import type { HarnessRequest, HarnessResponse } from '#/engine/contract.ts'
import HARNESS_SOURCE from '#/engine/harness/harness.generated.js?raw'

/** Must be new enough for workerd's real `node:fs`, which traces need. */
const HARNESS_COMPATIBILITY_DATE = '2026-08-01'

const HARNESS_MODULE = 'harness.js'
const SCRIPT_MODULE = 'user-script.js'

/** Whole-script budget. Workflow steps have no wall-clock limit; runs need one. */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 180_000

/** The subset of the harness entrypoint the host calls. */
interface HarnessStub {
  execute(request: HarnessRequest): Promise<HarnessResponse>
}

export interface ExecuteOptions {
  loader: WorkerLoader
  /** Passed through untouched; the harness is what calls Playwright on it. */
  browser: Cloudflare.Env['BROWSER']
  /** The saved script, verbatim. */
  code: string
  baseUrl: string
  /** Decrypted environment variables, keyed by name. */
  creds: Record<string, string>
  timeoutMs?: number
  actionTimeoutMs?: number
  trace?: boolean
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
  const worker = options.loader.load({
    compatibilityDate: HARNESS_COMPATIBILITY_DATE,
    // Playwright reaches for `node:fs`, `node:events` and friends.
    compatibilityFlags: ['nodejs_compat'],
    mainModule: HARNESS_MODULE,
    modules: {
      [HARNESS_MODULE]: HARNESS_SOURCE,
      [SCRIPT_MODULE]: options.code,
    },
    env: {
      BROWSER: options.browser,
      CREDS: options.creds,
      BASE_URL: options.baseUrl,
    },
    // No ambient `fetch`. Bindings still work, so the browser is still reachable.
    globalOutbound: null,
  })

  const harness = worker.getEntrypoint() as unknown as HarnessStub

  return harness.execute({
    timeoutMs: options.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
    actionTimeoutMs: options.actionTimeoutMs ?? 30_000,
    trace: options.trace ?? true,
  })
}
