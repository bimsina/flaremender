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

const TRACE_PATH = '/tmp/flaremender-trace.zip'

const MAX_LOG_LINES = 500
const MAX_LOG_LINE_LENGTH = 2000

interface HarnessEnv {
  BROWSER: BrowserWorker
  CREDS: Record<string, string>
  BASE_URL: string
  RUN_ID: string
  CHANNEL?: RunChannelSink | null
}

function createEmitter(channel: RunChannelSink | null | undefined) {
  if (!channel) return { emit: (_event: RunEvent) => {}, drain: async () => {} }

  let tail: Promise<void> = Promise.resolve()

  return {
    emit(event: RunEvent): void {
      tail = tail.then(() => channel.push(event)).catch(() => {})
    },
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

/** Do not forward to the platform console; it would bypass secret redaction. */
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

function classify(error: unknown): RunOutcome {
  if (!(error instanceof Error)) return 'error'
  if ('matcherResult' in error && error.matcherResult) return 'failed'
  if (error.name === 'TimeoutError') return 'failed'
  return /^(?:locator|expect|page|frame|element)[\w.]*:\s*Timeout/i.test(error.message)
    ? 'failed'
    : 'error'
}

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

const SNAPSHOT_TIMEOUT_MS = 15_000

const FRAME_QUALITY = 40
const FRAME_MIN_INTERVAL_MS = 900

/**
 * A small JPEG of what the browser is showing, for the live view. Never throws: a
 * page mid-navigation just yields no frame this time.
 */
async function captureFrame(
  page: Page,
): Promise<{ jpeg: string; width: number; height: number } | null> {
  try {
    const bytes = await page.screenshot({
      type: 'jpeg',
      quality: FRAME_QUALITY,
      fullPage: false,
      timeout: 4_000,
      animations: 'disabled',
    })
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 }
    return { jpeg: bytes.toString('base64'), width: viewport.width, height: viewport.height }
  } catch {
    return null
  }
}

function frameEmitter(
  channel: ReturnType<typeof createEmitter>,
  runId: string,
): (page: Page) => Promise<void> {
  let last = 0
  let busy = false
  return async (page) => {
    if (busy || Date.now() - last < FRAME_MIN_INTERVAL_MS) return
    busy = true
    try {
      const frame = await captureFrame(page)
      if (frame) {
        last = Date.now()
        channel.emit({ type: 'screenshot', runId, ...frame, at: last })
      }
    } finally {
      busy = false
    }
  }
}

const SNAPSHOT_VERBATIM_SHARE = 0.6

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

async function observePage(
  page: Page,
  limit: number,
  scrubber: Scrubber,
): Promise<PageObservation> {
  let url = ''
  let title = ''

  try {
    url = page.url()
  } catch {}

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

/** The persistent default context cannot accept baseURL, so resolve relative navigation here. */
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
        return (value as (...args: Array<unknown>) => unknown).apply(target, [
          resolve(first),
          ...rest,
        ])
      }
    },
  }) as Page
}

export default class Harness extends WorkerEntrypoint<HarnessEnv> {
  async execute(request: HarnessRequest): Promise<HarnessResponse> {
    const startedAt = Date.now()
    const creds = this.env.CREDS ?? {}
    const scrubber = createScrubber(Object.values(creds))

    const logs: Array<string> = []
    // Redact before truncating: a clipped secret no longer matches the scrubber.
    const push = (line: string) => {
      if (logs.length >= MAX_LOG_LINES) return
      const safe = scrubber.text(line)
      logs.push(safe.length > MAX_LOG_LINE_LENGTH ? `${safe.slice(0, MAX_LOG_LINE_LENGTH)}…` : safe)
    }

    const runId = this.env.RUN_ID ?? ''
    const channel = createEmitter(this.env.CHANNEL)

    let session: BrowserSession | undefined
    const frame = frameEmitter(channel, runId)

    const instrumentation = createInstrumentation({
      redact: scrubber.text,
      onStepStarted: (index, label) =>
        channel.emit({ type: 'step.started', runId, index, label, at: Date.now() }),
      onStep: (index, step) => {
        channel.emit({ type: 'step.finished', runId, index, step, at: Date.now() })
        if (session && this.env.CHANNEL) void frame(session.page)
      },
    })

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
          await session.context.tracing.start({ screenshots: true, snapshots: true })
          tracing = true
        } catch (error) {
          artifactWarnings.push(`Tracing could not start: ${messageOf(error)}`)
        }
      }

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

      if (session && this.env.CHANNEL) {
        const final = await captureFrame(session.page)
        if (final) channel.emit({ type: 'screenshot', runId, ...final, at: Date.now() })
      }

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

      // Always close the context to isolate suite members; only the shared browser session survives.
      if (session) {
        await teardownBrowser(session.browser, {
          keepSessionAlive: request.keepSessionAlive === true,
          connected: session.connected,
          context: session.context,
        })
      }

      // Flush queued events before the RPC response allows this isolate to be torn down.
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
      if (this.env.CHANNEL) {
        const channel = createEmitter(this.env.CHANNEL)
        const frame = await captureFrame(session.page)
        if (frame) {
          channel.emit({
            type: 'screenshot',
            runId: this.env.RUN_ID ?? '',
            ...frame,
            at: Date.now(),
          })
        }
        await channel.drain()
      }
      return { sessionId: session.sessionId, observation, errorMessage: null }
    } catch (error) {
      return {
        // Return acquired sessions even on navigation failure so the workflow can release them.
        sessionId: session?.sessionId ?? null,
        observation: null,
        errorMessage: scrubber.text(messageOf(error)),
      }
    } finally {
      await disconnectBrowser(session?.browser)
    }
  }

  async observe(request: AttachRequest): Promise<ObserveResponse> {
    const scrubber = createScrubber(Object.values(this.env.CREDS ?? {}))

    let session: AttachedSession | undefined
    try {
      session = await attachGenerationSession(this.env.BROWSER, request.sessionId, {
        actionTimeoutMs: request.actionTimeoutMs,
      })

      const observation = await observePage(session.page, request.snapshotLimit, scrubber)
      if (this.env.CHANNEL) {
        const channel = createEmitter(this.env.CHANNEL)
        const frame = await captureFrame(session.page)
        if (frame) {
          channel.emit({
            type: 'screenshot',
            runId: this.env.RUN_ID ?? '',
            ...frame,
            at: Date.now(),
          })
        }
        await channel.drain()
      }
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

  async act(request: AttachRequest): Promise<ActResponse> {
    const startedAt = Date.now()
    const creds = this.env.CREDS ?? {}
    const scrubber = createScrubber(Object.values(creds))
    const runId = this.env.RUN_ID ?? ''
    const channel = createEmitter(this.env.CHANNEL)

    const logs: Array<string> = []
    // Redact before truncating: a clipped secret no longer matches the scrubber.
    const push = (line: string) => {
      if (logs.length >= MAX_LOG_LINES) return
      const safe = scrubber.text(line)
      logs.push(safe.length > MAX_LOG_LINE_LENGTH ? `${safe.slice(0, MAX_LOG_LINE_LENGTH)}…` : safe)
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

      if (session) {
        try {
          observation = await observePage(session.page, request.snapshotLimit, scrubber)
        } catch {
          observation = null
        }
        if (this.env.CHANNEL) {
          const frame = await captureFrame(session.page)
          if (frame) channel.emit({ type: 'screenshot', runId, ...frame, at: Date.now() })
        }
      }

      // Disconnect only: later generation turns must retain this page and session.
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

  async release(sessionId: string): Promise<{ released: boolean; message?: string }> {
    return releaseSession(this.env.BROWSER, sessionId)
  }
}
