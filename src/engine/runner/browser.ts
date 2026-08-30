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
  type WorkersConnectOptions,
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
    applyTimeouts(context, options.actionTimeoutMs)

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

/* -------------------------------------------------- Generation: attach mode */

/**
 * Why generation does not use `openBrowser`.
 *
 * A run wants isolation and gets it from a fresh incognito context per script.
 * Generation wants the opposite: the model writes one small fragment per turn,
 * each fragment runs in its own throwaway isolate, and the *page* has to be
 * exactly where the last fragment left it — signed in, three screens deep.
 *
 * So attach mode connects to the session and reuses what is already there
 * instead of opening anything: `browser.contexts()` over a CDP connection
 * always includes the default browser context, and the page created when the
 * session was opened is still in it. Nothing here ever closes a context or ends
 * a session — `browser.close()` on a connected browser is a disconnect, which
 * is the only teardown a turn is allowed to perform.
 *
 * The cost is that the default context takes no `baseURL`, so relative
 * navigation is resolved by a shim in the harness rather than by Playwright.
 * That is a fair trade for a page that survives twenty-four turns.
 */
export interface AttachedSession {
  browser: Browser
  context: BrowserContext
  page: Page
}

/**
 * Thrown when the session could not be joined. The loop answers this by taking
 * a new session and replaying what it has verified so far, so it is worth
 * telling apart from a fragment that simply did not work.
 */
export class SessionLostError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
  ) {
    super(message)
    this.name = 'SessionLostError'
  }
}

/**
 * Opens the session a generation loop will live in.
 *
 * `acquire` then `connect`, for the same reason a suite does it: a connected
 * browser's `close()` is a disconnect, so no turn can accidentally end the
 * session the turns after it need.
 *
 * The page is opened on the session's **default** context, and `newContext()`
 * is deliberately not a fallback. An incognito context belongs to the
 * connection that created it, so the disconnect at the end of this isolate
 * takes it — and the page in it — with it. The next turn would then reconnect
 * to a session with nothing on it, which is precisely the state this whole
 * mode exists to avoid.
 */
export async function openGenerationSession(
  endpoint: BrowserWorker,
  options: { actionTimeoutMs?: number },
): Promise<AttachedSession & { sessionId: string }> {
  let sessionId: string
  let browser: Browser

  try {
    const acquired = await acquire(endpoint, { keep_alive: KEEP_ALIVE_MS })
    sessionId = acquired.sessionId
    browser = await connectPersistent(endpoint, sessionId)
  } catch (error) {
    throw new BrowserLaunchError(`Could not start a browser session: ${describe(error)}`, error)
  }

  try {
    const context = await findDefaultContext(browser)
    if (!context) {
      throw new Error('the session never reported a browser context')
    }

    applyTimeouts(context, options.actionTimeoutMs)
    const page = context.pages()[0] ?? (await context.newPage())
    return { browser, context, page, sessionId }
  } catch (error) {
    await teardownBrowser(browser, { keepSessionAlive: false, connected: true })
    throw new BrowserLaunchError(
      `Browser session started but no page could be opened: ${describe(error)}`,
      error,
    )
  }
}

/**
 * Joins a session so that what is already open on it can be reached.
 *
 * `connect()` without this flag is why generation could not hold a page. Two
 * things in the fork conspire, and both are invisible from the outside:
 *
 * - a non-persistent connection never builds a default browser context, so
 *   `browser.contexts()` comes back **empty** for a session that has pages on
 *   it — there is nothing to attach to and no way to tell that apart from an
 *   empty session;
 * - and the obvious workaround, `browser.newContext()`, creates the context
 *   with `disposeOnDetach: true`, so Chrome destroys it the moment this
 *   isolate's socket closes. The page really is gone by the next turn.
 *
 * Together they produce a loop that silently starts over every fragment: each
 * turn gets a pristine browser, every locator fails against a blank page, and
 * the model is told its locators are wrong. Connecting persistently gives back
 * the real default context, whose pages outlive any one connection — which is
 * the entire premise of generating against a live session.
 *
 * Runs deliberately do not use this: they want a throwaway incognito context
 * per script, and `disposeOnDetach` is exactly right for that.
 */
async function connectPersistent(endpoint: BrowserWorker, sessionId: string): Promise<Browser> {
  // `persistent` is honoured by the fork's `connect` but absent from its
  // published options type, which describes only `sessionId`.
  return connect(endpoint, { sessionId, persistent: true } as WorkersConnectOptions)
}

/** A page that has been somewhere is the loop's; `about:blank` never is. */
function hasNavigated(page: Page): boolean {
  try {
    const url = page.url()
    return url.length > 0 && url !== 'about:blank'
  } catch {
    // A page whose URL cannot be read is not one to carry a flow on.
    return false
  }
}

/** How long a reconnect waits for the session's existing page to show up. */
const ATTACH_DISCOVERY_TIMEOUT_MS = 5_000
const ATTACH_DISCOVERY_INTERVAL_MS = 100

/**
 * Finds the page a previous turn left running, waiting for it to appear.
 *
 * The waiting is the whole point. `connect()` resolves as soon as the CDP
 * socket is up, but the targets behind it are discovered asynchronously — so
 * `browser.contexts()` immediately afterwards can legitimately be empty for a
 * session that has a perfectly good page on it. Reading it once and believing
 * the answer is how a turn concludes it has been given a blank browser, and it
 * is the difference between a loop that builds on its own progress and one that
 * starts the flow over every time.
 *
 * Returns null only when the session really has nothing on it, which is the
 * loop's cue to take a fresh one and replay.
 */
async function findDefaultContext(browser: Browser): Promise<BrowserContext | null> {
  const deadline = Date.now() + ATTACH_DISCOVERY_TIMEOUT_MS

  for (;;) {
    const context = browser.contexts()[0]
    if (context) return context
    if (Date.now() >= deadline) return null

    await new Promise((resolve) => setTimeout(resolve, ATTACH_DISCOVERY_INTERVAL_MS))
  }
}

async function findAttachedPage(browser: Browser): Promise<Page | null> {
  const deadline = Date.now() + ATTACH_DISCOVERY_TIMEOUT_MS

  for (;;) {
    const pages = browser.contexts().flatMap((candidate) => candidate.pages())

    // A page that has been somewhere is the flow's. A bare `about:blank` might
    // be the loop's page caught mid-discovery, so it is not accepted while
    // there is still time to see it navigate — or to see a better one appear.
    const navigated = pages.find(hasNavigated)
    if (navigated) return navigated

    if (Date.now() >= deadline) return pages[0] ?? null

    await new Promise((resolve) => setTimeout(resolve, ATTACH_DISCOVERY_INTERVAL_MS))
  }
}

/**
 * Rejoins the loop's session and finds the page the last turn left behind.
 *
 * Two rules, both learned the hard way, and both about the same failure: a turn
 * that silently lands on the wrong page.
 *
 * **Nothing is ever created here.** The earlier version fell back to
 * `newContext()`/`newPage()` when it could not find what it wanted, which reads
 * as defensive and is the opposite: a fresh blank page is a perfectly usable
 * page, so the fragment runs, every locator times out against nothing, and the
 * model is told its locators are wrong when what actually happened is that its
 * browser was taken away. It then re-navigates, which *does* work, and the
 * script fills up with recovery navigations for a problem it never had. A
 * session with no page is a lost session and is worth saying so: the loop
 * answers `SessionLostError` by taking a fresh session and replaying the
 * verified prefix, which is exactly the right recovery and leaves no litter.
 *
 * **The page is chosen by where it has been, not by its position.** Page order
 * across a fresh CDP connection is not something to rely on, and a session can
 * carry a stray `about:blank` the browser opened for its own reasons. The page
 * the flow lives on is the one that has navigated somewhere.
 */
export async function attachGenerationSession(
  endpoint: BrowserWorker,
  sessionId: string,
  options: { actionTimeoutMs?: number },
): Promise<AttachedSession> {
  let browser: Browser
  try {
    browser = await connectPersistent(endpoint, sessionId)
  } catch (error) {
    throw new SessionLostError(`Could not rejoin session ${sessionId}: ${describe(error)}`, error)
  }

  try {
    const page = await findAttachedPage(browser)

    if (!page) {
      throw new Error('the session has no open page')
    }

    const context = page.context()
    applyTimeouts(context, options.actionTimeoutMs)

    return { browser, context, page }
  } catch (error) {
    await disconnectBrowser(browser)
    throw new SessionLostError(
      `Rejoined session ${sessionId} but found no usable page: ${describe(error)}`,
      error,
    )
  }
}

/**
 * Drops this isolate's CDP socket and leaves everything else exactly as it was.
 * The counterpart of `teardownBrowser` for a turn, which owns nothing.
 */
export async function disconnectBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) return
  try {
    await browser.close()
  } catch {
    // A socket that is already gone needs no closing.
  }
}

function applyTimeouts(context: BrowserContext, actionTimeoutMs?: number): void {
  context.setDefaultTimeout(actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS)
  context.setDefaultNavigationTimeout(actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS)
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
