/**
 * Browser lifecycle for one attempt.
 *
 * This module is compiled *into the harness bundle*, not into the host Worker:
 * Playwright objects cannot cross a Worker Loader boundary, so the browser is
 * launched inside the same isolate as the script that drives it. It lives under
 * `runner/` because it is engine plumbing rather than part of the script
 * contract.
 */
import {
  type Browser,
  type BrowserContext,
  type BrowserWorker,
  type Page,
  launch,
} from '@cloudflare/playwright'

/**
 * Idle timeout for the Browser Rendering session (the service accepts
 * 10s–600s). Deliberately short: it is the only thing that reclaims a session
 * whose run died before `close()`, and concurrent sessions are a hard quota —
 * a leaked one costs the next run a `429`.
 */
export const KEEP_ALIVE_MS = 120_000

/** Per-action ceiling. The whole-script budget is enforced separately. */
export const DEFAULT_ACTION_TIMEOUT_MS = 30_000

export interface BrowserSession {
  browser: Browser
  context: BrowserContext
  page: Page
  sessionId: string | undefined
}

/**
 * Thrown when the browser never came up. The Workflow treats this as a step
 * failure worth one retry, unlike a script that ran and failed.
 */
export class BrowserLaunchError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
  ) {
    super(message)
    this.name = 'BrowserLaunchError'
  }
}

export async function openBrowser(
  endpoint: BrowserWorker,
  options: { baseUrl: string; actionTimeoutMs?: number },
): Promise<BrowserSession> {
  let browser: Browser
  try {
    browser = await launch(endpoint, { keep_alive: KEEP_ALIVE_MS })
  } catch (error) {
    throw new BrowserLaunchError(
      `Could not start a browser session: ${error instanceof Error ? error.message : String(error)}`,
      error,
    )
  }

  try {
    // `baseURL` is what makes `page.goto('/')` mean the environment's base URL.
    const context = await browser.newContext({ baseURL: options.baseUrl })
    context.setDefaultTimeout(options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS)
    context.setDefaultNavigationTimeout(options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS)

    const page = await context.newPage()

    return { browser, context, page, sessionId: browser.sessionId() }
  } catch (error) {
    await closeBrowser(browser)
    throw new BrowserLaunchError(
      `Browser session started but no page could be opened: ${error instanceof Error ? error.message : String(error)}`,
      error,
    )
  }
}

/** Never throws: a failure to close must not mask the result of the run. */
export async function closeBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) return
  try {
    await browser.close()
  } catch {
    // The session expires on its own; nothing here is worth failing a run over.
  }
}
