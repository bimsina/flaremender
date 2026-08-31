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

export const KEEP_ALIVE_MS = 570_000

export const DEFAULT_ACTION_TIMEOUT_MS = 30_000

export interface BrowserSession {
  browser: Browser
  context: BrowserContext
  page: Page
  sessionId: string | undefined
  reused: boolean
  connected: boolean
}

export interface OpenBrowserOptions {
  baseUrl: string
  actionTimeoutMs?: number
  sessionId?: string | null
  keepSessionAlive?: boolean
}

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

interface AttachedBrowser {
  browser: Browser
  sessionId: string | undefined
  reused: boolean
  connected: boolean
}

async function attachBrowser(
  endpoint: BrowserWorker,
  options: OpenBrowserOptions,
): Promise<AttachedBrowser> {
  if (options.sessionId) {
    try {
      const browser = await connect(endpoint, options.sessionId)
      return { browser, sessionId: options.sessionId, reused: true, connected: true }
    } catch {}
  }

  try {
    if (options.keepSessionAlive) {
      // acquire + connect makes close() disconnect without ending the suite’s shared session.
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
    // Each suite member needs a fresh context, even when it reuses the browser session.
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

export interface AttachedSession {
  browser: Browser
  context: BrowserContext
  page: Page
}

export class SessionLostError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
  ) {
    super(message)
    this.name = 'SessionLostError'
  }
}

/** Use the default context: incognito contexts are destroyed when a generation turn disconnects. */
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

async function connectPersistent(endpoint: BrowserWorker, sessionId: string): Promise<Browser> {
  // The fork supports persistent connections but omits the option from its published type.
  return connect(endpoint, { sessionId, persistent: true } as WorkersConnectOptions)
}

function hasNavigated(page: Page): boolean {
  try {
    const url = page.url()
    return url.length > 0 && url !== 'about:blank'
  } catch {
    return false
  }
}

const ATTACH_DISCOVERY_TIMEOUT_MS = 5_000
const ATTACH_DISCOVERY_INTERVAL_MS = 100

/** CDP discovers targets asynchronously after connect resolves; wait before declaring the page lost. */
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

    const navigated = pages.find(hasNavigated)
    if (navigated) return navigated

    if (Date.now() >= deadline) return pages[0] ?? null

    await new Promise((resolve) => setTimeout(resolve, ATTACH_DISCOVERY_INTERVAL_MS))
  }
}

/** Never create a replacement page here; signal session loss so the loop replays its verified steps. */
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

export async function disconnectBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) return
  try {
    await browser.close()
  } catch {}
}

function applyTimeouts(context: BrowserContext, actionTimeoutMs?: number): void {
  context.setDefaultTimeout(actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS)
  context.setDefaultNavigationTimeout(actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS)
}

/** close() only disconnects an attached browser; CDP Browser.close releases the session. */
export async function endSession(browser: Browser): Promise<void> {
  try {
    const cdp = await browser.newBrowserCDPSession()
    await cdp.send('Browser.close')
  } catch {
    // Closing the browser can reject this command by closing its transport.
  }
}

export async function teardownBrowser(
  browser: Browser | undefined,
  options: { keepSessionAlive: boolean; connected: boolean; context?: BrowserContext },
): Promise<void> {
  if (!browser) return

  if (options.context) {
    try {
      await options.context.close()
    } catch {}
  }

  if (!options.keepSessionAlive && options.connected) await endSession(browser)

  try {
    await browser.close()
  } catch {}
}

export async function releaseSession(
  endpoint: BrowserWorker,
  sessionId: string,
): Promise<{ released: boolean; message?: string }> {
  let browser: Browser
  try {
    browser = await connect(endpoint, sessionId)
  } catch (error) {
    return { released: false, message: describe(error) }
  }

  await endSession(browser)

  try {
    await browser.close()
  } catch {}

  return { released: true }
}
