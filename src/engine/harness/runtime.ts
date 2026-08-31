/**
 * The harness — the entrypoint of the Dynamic Worker that actually runs a test.
 *
 * `scripts/build-harness.mjs` bundles this file, `@cloudflare/playwright` and
 * everything it imports into one JS string; `src/engine/runner/loader.ts` hands
 * that string to the Worker Loader alongside the saved script. Inside the
 * resulting isolate the script gets real Playwright driving real Browser
 * Rendering, and nothing else: the isolate's bindings are the browser, the
 * decrypted credentials and a base URL. No database, no R2 bucket, no ambient
 * network — a hostile script has nothing to reach for.
 *
 * Artifacts come back as bytes over RPC precisely so the bucket binding can stay
 * on the host side.
 */
import fs from 'node:fs'
import type { BrowserWorker, Page } from '@cloudflare/playwright'
import { expect as playwrightExpect } from '@cloudflare/playwright/test'
import { WorkerEntrypoint } from 'cloudflare:workers'

import type {
  ActResponse,
  AttachRequest,
  HarnessRequest,
  HarnessResponse,
  ObserveResponse,
  PageObservation,
  RunChannelSink,
  RunErrorKind,
  RunEvent,
  RunOutcome,
  RunResult,
  RunStep,
  SessionStartRequest,
  SessionStartResponse,
} from '#/engine/contract.ts'
import {
  type AttachedSession,
  type BrowserSession,
  BrowserLaunchError,
  SessionLostError,
  attachGenerationSession,
  disconnectBrowser,
  openBrowser,
  openGenerationSession,
  releaseSession,
  teardownBrowser,
} from '#/engine/runner/browser.ts'
import { type Scrubber, createScrubber } from '#/engine/runner/scrub.ts'
import { createInstrumentation } from './instrument.ts'
import userScript from './user-script.ts'

/** `node:fs` inside a Worker only serves `/tmp`, which is where traces land. */
const TRACE_PATH = '/tmp/flaremender-trace.zip'

const MAX_LOG_LINES = 500
const MAX_LOG_LINE_LENGTH = 2000

interface HarnessEnv {
  /** The host's Browser Rendering binding, passed straight through. */
  BROWSER: BrowserWorker
  /** Decrypted environment variables, exposed to the script as `secret(name)`. */
  CREDS: Record<string, string>
  /** What relative navigations resolve against. */
  BASE_URL: string
  /** Which run these events belong to. */
  RUN_ID: string
  /**
   * This run's live channel, and nothing else — a stub whose only method is
   * `push`, bound to a single run's Durable Object. It is the one capability the
   * sandbox has that reaches back out, which is why every event that goes
   * through it is redacted first, here, where the plaintext lives.
   *
   * Absent when the host chose not to stream; the harness works either way.
   */
  CHANNEL?: RunChannelSink | null
}

/**
 * Sends events in the order they were produced, without making the script wait.
 *
 * Each `push` is chained onto the last so the Durable Object's sequence numbers
 * follow the script; failures are swallowed, because a channel that has gone
 * away must never turn a passing test into a failing one.
 */
function createEmitter(channel: RunChannelSink | null | undefined) {
  if (!channel) return { emit: (_event: RunEvent) => {}, drain: async () => {} }

  let tail: Promise<void> = Promise.resolve()

  return {
    emit(event: RunEvent): void {
      tail = tail.then(() => channel.push(event)).catch(() => {})
    },
    /** Awaited before the response goes back, so nothing is lost on teardown. */
    drain: () => tail,
  }
}

function formatLogArg(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Captures `console.*` from the script without forwarding it.
 *
 * Deliberately *not* chained to the real console: a script is free to log a
 * value it read with `secret()`, and the copy that reaches the platform's logs
 * would never pass through the scrubber.
 */
function captureConsole(push: (line: string) => void): () => void {
  const original = globalThis.console
  const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const

  const patched = Object.create(original) as Console
  for (const level of levels) {
    Object.defineProperty(patched, level, {
      value: (...args: Array<unknown>) => push(`[${level}] ${args.map(formatLogArg).join(' ')}`),
      writable: true,
      configurable: true,
    })
  }

  try {
    globalThis.console = patched
  } catch {
    return () => {}
  }

  return () => {
    globalThis.console = original
  }
}

/**
 * An assertion that did not hold, or a locator that never resolved, is a *test
 * failure*. A `ReferenceError` in the script is not — that is the script being
 * broken, which reads differently in the UI and is never worth retrying.
 */
function classify(error: unknown): RunOutcome {
  if (!(error instanceof Error)) return 'error'
  if ('matcherResult' in error && error.matcherResult) return 'failed'
  if (error.name === 'TimeoutError') return 'failed'
  return /^(?:locator|expect|page|frame|element)[\w.]*:\s*Timeout/i.test(error.message)
    ? 'failed'
    : 'error'
}

/**
 * The message, plus only the stack frames that point at the user's own script.
 *
 * A Playwright failure already explains itself in prose; twenty frames of
 * bundled harness internals underneath it explain nothing and leak the shape of
 * the engine into a test report. The `user-script.js` frames are the ones worth
 * keeping — they carry the line number the author can act on.
 */
function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)

  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at\b/.test(line) && line.includes('user-script.js'))

  return frames.length > 0 ? `${error.message}\n${frames.join('\n')}` : error.message
}

class ScriptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Script did not finish within ${Math.round(timeoutMs / 1000)}s.`)
    this.name = 'TimeoutError'
  }
}

/* --------------------------------------------------------- Generation mode */

/** How long the snapshot itself may take before it is not worth waiting for. */
const SNAPSHOT_TIMEOUT_MS = 15_000

/**
 * How much of the budget the top of the page gets, verbatim.
 *
 * Above this line the snapshot is kept exactly as Playwright produced it —
 * indentation and all — because the hierarchy is half of what makes it
 * readable. Below it only the rows a locator could target survive, on the
 * grounds that a model deciding what to click next needs the *names* of the
 * things further down the page far more than it needs their nesting.
 */
const SNAPSHOT_VERBATIM_SHARE = 0.6

/** Roles worth keeping once the verbatim budget is spent. */
const ACTIONABLE_ROLE =
  /^\s*-\s*(?:button|link|textbox|searchbox|combobox|listbox|option|checkbox|radio|menuitem[a-z]*|tab|switch|slider|spinbutton|heading|alert|status|dialog|cell|columnheader|rowheader|text)\b/

function fitSnapshot(snapshot: string, limit: number): { snapshot: string; truncated: boolean } {
  if (snapshot.length <= limit) return { snapshot, truncated: false }

  const verbatimBudget = Math.floor(limit * SNAPSHOT_VERBATIM_SHARE)
  const kept: Array<string> = []
  let size = 0
  let spentVerbatim = false

  for (const line of snapshot.split('\n')) {
    if (!spentVerbatim && size + line.length + 1 > verbatimBudget) {
      spentVerbatim = true
      kept.push('  # …only actionable rows below this point…')
      size += 48
    }

    if (spentVerbatim && !ACTIONABLE_ROLE.test(line)) continue
    if (size + line.length + 1 > limit) break

    kept.push(line)
    size += line.length + 1
  }

  return { snapshot: kept.join('\n'), truncated: true }
}

/**
 * What the page is, right now.
 *
 * Never throws: an observation is context, and a turn that cannot see the page
 * is still better off being told so than being failed. A snapshot that times
 * out — a page mid-navigation is the usual reason — comes back as a note in
 * place of the tree.
 */
async function observePage(
  page: Page,
  limit: number,
  scrubber: Scrubber,
): Promise<PageObservation> {
  let url = ''
  let title = ''

  try {
    url = page.url()
  } catch {
    // A page that cannot report its own URL is about to fail louder elsewhere.
  }

  try {
    title = await page.title()
  } catch {
    title = ''
  }

  let snapshot = ''
  let truncated = false
  try {
    const raw = await page.locator('body').ariaSnapshot({ timeout: SNAPSHOT_TIMEOUT_MS })
    const fitted = fitSnapshot(raw, limit)
    snapshot = fitted.snapshot
    truncated = fitted.truncated
  } catch (error) {
    snapshot = `# the page could not be snapshotted: ${messageOf(error)}`
  }

  return {
    url: scrubber.text(url),
    title: scrubber.text(title),
    snapshot: scrubber.text(snapshot),
    truncated,
  }
}

/**
 * Relative navigation, in a context that has no `baseURL`.
 *
 * Attach mode reuses the browser's default context so that a page survives
 * between turns, and the default context cannot be given a `baseURL` — that is
 * a `newContext` option. Rather than teach the model two dialects of navigation
 * (absolute while generating, relative in the saved script), the two calls that
 * take a URL resolve one here. The fragment the model writes is therefore the
 * fragment that ends up in the file.
 */
function withBaseUrl(page: Page, baseUrl: string): Page {
  if (!baseUrl) return page

  const resolve = (value: unknown): unknown =>
    typeof value === 'string' && value.startsWith('/') ? new URL(value, baseUrl).toString() : value

  return new Proxy(page, {
    get(target, property) {
      const value = (target as unknown as Record<string | symbol, unknown>)[property]
      if (typeof value !== 'function') return value
      if (property !== 'goto' && property !== 'waitForURL') return value

      return function resolved(this: unknown, first: unknown, ...rest: Array<unknown>) {
        // Applied to the real page: Playwright's internals use private fields,
        // which a proxy receiver would not satisfy.
        return (value as (...args: Array<unknown>) => unknown).apply(target, [
          resolve(first),
          ...rest,
        ])
      }
    },
  }) as Page
}

export default class Harness extends WorkerEntrypoint<HarnessEnv> {
  /**
   * Runs the saved script once and reports what happened.
   *
   * Never throws for anything the script did: a failing assertion, a broken
   * script and a timeout are all *results*. It throws only when the browser
   * itself could not be reached, which is the one case worth retrying.
   */
  async execute(request: HarnessRequest): Promise<HarnessResponse> {
    const startedAt = Date.now()
    const creds = this.env.CREDS ?? {}
    const scrubber = createScrubber(Object.values(creds))

    const logs: Array<string> = []
    const push = (line: string) => {
      if (logs.length >= MAX_LOG_LINES) return
      logs.push(line.length > MAX_LOG_LINE_LENGTH ? `${line.slice(0, MAX_LOG_LINE_LENGTH)}…` : line)
    }

    const runId = this.env.RUN_ID ?? ''
    const channel = createEmitter(this.env.CHANNEL)

    const instrumentation = createInstrumentation({
      redact: scrubber.text,
      onStepStarted: (index, label) =>
        channel.emit({ type: 'step.started', runId, index, label, at: Date.now() }),
      onStep: (index, step) =>
        channel.emit({ type: 'step.finished', runId, index, step, at: Date.now() }),
    })

    let session: BrowserSession | undefined
    let outcome: RunOutcome = 'passed'
    let errorKind: RunErrorKind | null = null
    let errorMessage: string | null = null
    let screenshot: ArrayBuffer | null = null
    let trace: ArrayBuffer | null = null
    let tracing = false
    const artifactWarnings: Array<string> = []

    const restoreConsole = captureConsole(push)

    try {
      session = await openBrowser(this.env.BROWSER, {
        baseUrl: this.env.BASE_URL,
        actionTimeoutMs: request.actionTimeoutMs,
        sessionId: request.sessionId,
        keepSessionAlive: request.keepSessionAlive,
      })

      if (request.trace) {
        try {
          // Tracing is a property of the context, not of the browser, and every
          // run gets its own context — so a reused session still produces one
          // self-contained trace per member.
          await session.context.tracing.start({ screenshots: true, snapshots: true })
          tracing = true
        } catch (error) {
          artifactWarnings.push(`Tracing could not start: ${messageOf(error)}`)
        }
      }

      // Page-side output is as much a part of "what happened" as the script's.
      session.page.on('console', (message) => push(`[page:${message.type()}] ${message.text()}`))
      session.page.on('pageerror', (error) => push(`[page:error] ${error.message}`))

      const context = {
        page: instrumentation.watch(session.page, 'page'),
        expect: instrumentation.watchExpect(playwrightExpect),
        secret: (name: string): string => {
          const value = creds[name]
          if (value === undefined) {
            throw new Error(
              `No environment variable named "${name}". Add it to this environment before running.`,
            )
          }
          return value
        },
      }

      if (typeof userScript !== 'function') {
        throw new Error(
          'The script must `export default` a function taking { page, expect, secret }.',
        )
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.resolve(userScript(context)),
          new Promise((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new ScriptTimeoutError(request.timeoutMs)),
              request.timeoutMs,
            )
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    } catch (error) {
      if (error instanceof BrowserLaunchError) {
        outcome = 'error'
        errorKind = 'browser'
        errorMessage = error.message
      } else {
        outcome = classify(error)
        errorKind = outcome === 'failed' ? null : 'script'
        errorMessage = messageOf(error)
      }

      // Best effort: a screenshot of the failure is often the whole diagnosis.
      if (session) {
        try {
          const bytes = await session.page.screenshot({ fullPage: false, timeout: 10_000 })
          screenshot = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer
        } catch (screenshotError) {
          artifactWarnings.push(`Failure screenshot unavailable: ${messageOf(screenshotError)}`)
        }
      }
    } finally {
      restoreConsole()

      if (session && tracing) {
        try {
          await session.context.tracing.stop({ path: TRACE_PATH })
          const bytes = await fs.promises.readFile(TRACE_PATH)
          trace = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer
        } catch (error) {
          artifactWarnings.push(`Trace unavailable: ${messageOf(error)}`)
        }
      }

      // The context always goes — it is the isolation boundary, and the next
      // member of a suite must not inherit this one's cookies. The session
      // survives only when someone else is going to reuse it.
      if (session) {
        await teardownBrowser(session.browser, {
          keepSessionAlive: request.keepSessionAlive === true,
          connected: session.connected,
          context: session.context,
        })
      }

      // The isolate is about to be torn down with the RPC response; anything
      // still in flight to the channel would go with it.
      await channel.drain()
    }

    const result: RunResult = {
      outcome,
      steps: instrumentation.steps,
      errorMessage: scrubber.nullable(errorMessage),
      logs: scrubber.lines(logs),
      durationMs: Date.now() - startedAt,
    }

    return {
      result,
      artifactWarnings: scrubber.lines(artifactWarnings),
      errorKind,
      screenshot,
      trace,
      sessionId: session?.sessionId ?? null,
      sessionReused: session?.reused ?? false,
    }
  }

  /**
   * Opens the session a generation loop will spend its whole life in.
   *
   * The page it leaves behind — parked on the environment's base URL — is what
   * every `observe` and `act` after this will find and carry forward. Nothing
   * is closed on the way out but this isolate's own socket.
   */
  async startSession(request: SessionStartRequest): Promise<SessionStartResponse> {
    const scrubber = createScrubber(Object.values(this.env.CREDS ?? {}))
    const baseUrl = this.env.BASE_URL ?? ''

    let session: (AttachedSession & { sessionId: string }) | undefined
    try {
      session = await openGenerationSession(this.env.BROWSER, {
        actionTimeoutMs: request.actionTimeoutMs,
      })

      if (baseUrl) await session.page.goto(baseUrl)

      const observation = await observePage(session.page, request.snapshotLimit, scrubber)
      return { sessionId: session.sessionId, observation, errorMessage: null }
    } catch (error) {
      return {
        // Reported even on failure: a session that was taken and then could not
        // be navigated still exists, and the workflow has to be able to end it.
        sessionId: session?.sessionId ?? null,
        observation: null,
        errorMessage: scrubber.text(messageOf(error)),
      }
    } finally {
      await disconnectBrowser(session?.browser)
    }
  }

  /** Looks at the loop's live page without touching it. */
  async observe(request: AttachRequest): Promise<ObserveResponse> {
    const scrubber = createScrubber(Object.values(this.env.CREDS ?? {}))

    let session: AttachedSession | undefined
    try {
      session = await attachGenerationSession(this.env.BROWSER, request.sessionId, {
        actionTimeoutMs: request.actionTimeoutMs,
      })

      const observation = await observePage(session.page, request.snapshotLimit, scrubber)
      return { observation, errorMessage: null, sessionLost: false }
    } catch (error) {
      return {
        observation: null,
        errorMessage: scrubber.text(messageOf(error)),
        sessionLost: error instanceof SessionLostError,
      }
    } finally {
      await disconnectBrowser(session?.browser)
    }
  }

  /**
   * Runs one candidate fragment against the live page, for real.
   *
   * The module the loader supplied is the fragment wrapped in the same
   * `{ page, expect, secret }` shape a saved script has, so a fragment that
   * works here is a fragment that works in the finished file — which is the
   * entire reason generation drives a real browser instead of guessing.
   *
   * Never throws. A fragment that fails is a *result*: the loop shows the model
   * the error and the page it left behind, and asks for something different.
   */
  async act(request: AttachRequest): Promise<ActResponse> {
    const startedAt = Date.now()
    const creds = this.env.CREDS ?? {}
    const scrubber = createScrubber(Object.values(creds))
    const runId = this.env.RUN_ID ?? ''
    const channel = createEmitter(this.env.CHANNEL)

    const logs: Array<string> = []
    const push = (line: string) => {
      if (logs.length >= MAX_LOG_LINES) return
      logs.push(line.length > MAX_LOG_LINE_LENGTH ? `${line.slice(0, MAX_LOG_LINE_LENGTH)}…` : line)
    }

    const instrumentation = createInstrumentation({
      redact: scrubber.text,
      startIndex: request.stepIndexOffset ?? 0,
      onStepStarted: (index, label) =>
        channel.emit({ type: 'step.started', runId, index, label, at: Date.now() }),
      onStep: (index, step) =>
        channel.emit({ type: 'step.finished', runId, index, step, at: Date.now() }),
    })

    let session: AttachedSession | undefined
    let ok = true
    let errorMessage: string | null = null
    let sessionLost = false
    let observation: PageObservation | null = null

    const restoreConsole = captureConsole(push)

    try {
      session = await attachGenerationSession(this.env.BROWSER, request.sessionId, {
        actionTimeoutMs: request.actionTimeoutMs,
      })

      const onConsole = (message: { type: () => string; text: () => string }) =>
        push(`[page:${message.type()}] ${message.text()}`)
      session.page.on('console', onConsole)

      const context = {
        page: instrumentation.watch(withBaseUrl(session.page, this.env.BASE_URL ?? ''), 'page'),
        expect: instrumentation.watchExpect(playwrightExpect),
        secret: (name: string): string => {
          const value = creds[name]
          if (value === undefined) {
            throw new Error(
              `No environment variable named "${name}". Add it to this environment before running.`,
            )
          }
          return value
        },
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.resolve(userScript(context)),
          new Promise((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new ScriptTimeoutError(request.timeoutMs)),
              request.timeoutMs,
            )
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        session.page.off('console', onConsole)
      }
    } catch (error) {
      ok = false
      sessionLost = error instanceof SessionLostError
      errorMessage = messageOf(error)
    } finally {
      restoreConsole()

      // The page is the loop's state, so it is looked at *after* the fragment
      // ran whether or not the fragment worked — a failure that navigated
      // somewhere unexpected is exactly what the model needs to see.
      if (session) {
        try {
          observation = await observePage(session.page, request.snapshotLimit, scrubber)
        } catch {
          observation = null
        }
      }

      // A disconnect, never a teardown: the session and its page belong to the
      // workflow and have to outlive this isolate.
      await disconnectBrowser(session?.browser)
      await channel.drain()
    }

    const steps: Array<RunStep> = instrumentation.steps.map((step) => ({
      ...step,
      label: scrubber.text(step.label),
      ...(step.error === undefined ? {} : { error: scrubber.text(step.error) }),
    }))

    return {
      ok,
      steps,
      logs: scrubber.lines(logs),
      errorMessage: scrubber.nullable(errorMessage),
      observation,
      durationMs: Date.now() - startedAt,
      sessionLost,
    }
  }

  /**
   * Ends a shared Browser Rendering session.
   *
   * A suite's members all leave their session running, so something has to end
   * it once they are done — and that something cannot be the host Worker, which
   * has no Playwright and no CDP. It is this: a throwaway isolate whose only
   * job is to connect and say goodbye.
   *
   * Best effort by construction. A session that cannot be reached is already as
   * closed as it needs to be, and one that refuses to close still expires on
   * its own keep-alive.
   */
  async release(sessionId: string): Promise<{ released: boolean; message?: string }> {
    return releaseSession(this.env.BROWSER, sessionId)
  }
}
