/**
 * Browser lifecycle for one attempt.
 *
 * This module is compiled *into the harness bundle*, not into the host Worker:
 * Playwright objects cannot cross a Worker Loader boundary, so the browser is
 * launched inside the same isolate as the script that drives it. It lives under
 * `runner/` because it is engine plumbing rather than part of the script
 * contract.
 *
 * ## Who owns the session
 *
 * Browser Rendering hands out very few concurrent sessions and rate-limits new
 * ones hard, so a suite that took a session per intent spent its third member
 * collecting `429`s. Cloudflare's own guidance is to reuse a session and get
 * isolation from a fresh browser context instead, which is exactly the split
 * this module implements — but it makes *who closes the session* the load-
 * bearing question, because the fork answers `browser.close()` two different
 * ways:
 *
 * - a browser from `launch()` has its `browserProcess.close` overridden to send
 *   CDP `Browser.close`, so closing it **ends the session**;
 * - a browser from `connect()` keeps the stock `connectOverCDP` behaviour, so
 *   closing it only **drops the WebSocket** and leaves the session running.
 *
 * A standalone run therefore still `launch()`es and closes, exactly as before.
 * A suite member instead `acquire()`s the session and `connect()`s to it, so
 * that every member — the first included — tears down symmetrically with a
 * plain disconnect, and the session's death is a single explicit act performed
 * once by the suite (`endSession`) rather than something any one member could
 * do to the members after it.
 */
import {
  type Browser,
  type BrowserContext,
  type BrowserWorker,
  type Page,
  acquire,
  connect,
  launch,
} from '@cloudflare/playwright'

/**
 * Idle timeout for the Browser Rendering session. There is no total-lifetime
 * cap — only inactivity kills a session — so this is set near the maximum so a
 * script's own long waits never race the platform; the whole-script budget in
 * the harness is what bounds a run, and it fails with a readable timeout
 * instead of a dead session. The cost is a longer reclaim for a session leaked
 * by an isolate crash — rare, and `close()` in the harness's `finally` plus the
 * host's cleanup cover the normal paths.
 *
 * It doubles as the gap a suite may leave between two members: the session has
 * to survive from one member's teardown to the next member's `connect`, and a
 * member is bounded by the script timeout well under this.
 *
 * The fork's types document the range as 10_000–600_000ms, but the service
 * 400s (error 1031) at exactly 600_000 — verified empirically 2026-08-30.
 * 570_000 is accepted.
 */
export const KEEP_ALIVE_MS = 570_000

/** Per-action ceiling. The whole-script budget is enforced separately. */
export const DEFAULT_ACTION_TIMEOUT_MS = 30_000

export interface BrowserSession {
  browser: Browser
  context: BrowserContext
  page: Page
  sessionId: string | undefined
  /**
   * Whether this isolate joined an existing session rather than creating one.
   * Only ever true inside a suite, and only ever from the second member on.
   */
  reused: boolean
  /**
   * Whether the browser came from `connect()`, which decides what `close()`
   * means — see the note at the top of this file.
   */
  connected: boolean
}

export interface OpenBrowserOptions {
  baseUrl: string
  actionTimeoutMs?: number
  /**
   * A session to join instead of taking a new one. A dead id is not an error:
   * the session may have been reclaimed between members, and the right answer
   * is a fresh session rather than a failed run.
   */
  sessionId?: string | null
  /**
   * Whether the session must outlive this script. Set for every member of a
   * suite, so the session is acquired-and-connected rather than launched and
   * no member's teardown can end it.
   */
  keepSessionAlive?: boolean
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What `openBrowser` resolved to before a context was opened on it. */
interface AttachedBrowser {
  browser: Browser
  sessionId: string | undefined
  reused: boolean
  connected: boolean
}

/**
 * Gets a browser, preferring the session the caller already has.
 *
 * The fallback is the point: a `connect` that fails means the session went away
 * — a lapsed keep-alive, a reclaim, an isolate that died holding it — and a
 * suite must carry on with a new one rather than failing every remaining
 * member. Only the *fresh* path can raise `BrowserLaunchError`, so a `429` is
 * still the retryable failure it always was.
 */
async function attachBrowser(
  endpoint: BrowserWorker,
  options: OpenBrowserOptions,
): Promise<AttachedBrowser> {
  if (options.sessionId) {
    try {
      const browser = await connect(endpoint, options.sessionId)
      return { browser, sessionId: options.sessionId, reused: true, connected: true }
    } catch {
      // Deliberately swallowed: falling through to a fresh session is the
      // recovery, and the caller learns which session ran from the response.
    }
  }

  try {
    if (options.keepSessionAlive) {
      // Acquire then connect, rather than launch: a connected browser's
      // `close()` is a disconnect, which is the only teardown a suite member is
      // allowed to perform on a session it shares with the members after it.
      const { sessionId } = await acquire(endpoint, { keep_alive: KEEP_ALIVE_MS })
      const browser = await connect(endpoint, sessionId)
      return { browser, sessionId, reused: false, connected: true }
    }

    const browser = await launch(endpoint, { keep_alive: KEEP_ALIVE_MS })
    return { browser, sessionId: browser.sessionId(), reused: false, connected: false }
  } catch (error) {
    throw new BrowserLaunchError(`Could not start a browser session: ${describe(error)}`, error)
  }
}

export async function openBrowser(
  endpoint: BrowserWorker,
  options: OpenBrowserOptions,
): Promise<BrowserSession> {
  const attached = await attachBrowser(endpoint, options)

  try {
    // A fresh context every time, reused session or not: it is an incognito
    // profile, so cookies, storage and cache from the previous member cannot
    // reach this one. Isolation comes from here, not from the session.
    // `baseURL` is what makes `page.goto('/')` mean the environment's base URL.
    const context = await attached.browser.newContext({ baseURL: options.baseUrl })
    context.setDefaultTimeout(options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS)
    context.setDefaultNavigationTimeout(options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS)

    const page = await context.newPage()

    return {
      browser: attached.browser,
      context,
      page,
      sessionId: attached.sessionId,
      reused: attached.reused,
      connected: attached.connected,
    }
  } catch (error) {
    await teardownBrowser(attached.browser, {
      keepSessionAlive: false,
      connected: attached.connected,
    })
    throw new BrowserLaunchError(
      `Browser session started but no page could be opened: ${describe(error)}`,
      error,
    )
  }
}

/**
 * Ends a Browser Rendering session that a `connect()` holds open.
 *
 * `close()` on a connected browser only drops the socket, so the session has to
 * be told to go away in the one language it understands. Best effort by
 * definition: if this does not land the session still expires on its own after
 * `KEEP_ALIVE_MS` of silence — later than we would like, but not for ever.
 */
export async function endSession(browser: Browser): Promise<void> {
  try {
    const cdp = await browser.newBrowserCDPSession()
    await cdp.send('Browser.close')
  } catch {
    // Expected on the happy path as often as not: the transport dies under the
    // very command that killed it, and the rejection means it worked.
  }
}

/**
 * Tears one attempt down. Never throws: a failure to close must not mask the
 * result of the run.
 *
 * The context always goes — that is the isolation boundary, and leaving it open
 * would leak a profile into the next member. What happens to the *session*
 * depends on who owns it.
 */
export async function teardownBrowser(
  browser: Browser | undefined,
  options: { keepSessionAlive: boolean; connected: boolean; context?: BrowserContext },
): Promise<void> {
  if (!browser) return

  if (options.context) {
    try {
      await options.context.close()
    } catch {
      // The session teardown below reclaims it either way.
    }
  }

  // A connected browser that nobody is going to reuse would otherwise sit
  // there holding one of the account's few concurrent slots.
  if (!options.keepSessionAlive && options.connected) await endSession(browser)

  try {
    await browser.close()
  } catch {
    // The session expires on its own; nothing here is worth failing a run over.
  }
}

/**
 * Joins a session for the sole purpose of ending it.
 *
 * The suite's own cleanup: no member may end the shared session, so exactly one
 * caller does, once, after the last member has been accounted for.
 */
export async function releaseSession(
  endpoint: BrowserWorker,
  sessionId: string,
): Promise<{ released: boolean; message?: string }> {
  let browser: Browser
  try {
    browser = await connect(endpoint, sessionId)
  } catch (error) {
    // Already gone is the outcome we wanted, and indistinguishable from here.
    return { released: false, message: describe(error) }
  }

  await endSession(browser)

  try {
    await browser.close()
  } catch {
    // The socket is already dead if `Browser.close` landed.
  }

  return { released: true }
}
