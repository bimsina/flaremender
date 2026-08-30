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
import type { BrowserWorker } from '@cloudflare/playwright'
import { expect as playwrightExpect } from '@cloudflare/playwright/test'
import { WorkerEntrypoint } from 'cloudflare:workers'

import type {
  HarnessRequest,
  HarnessResponse,
  RunErrorKind,
  RunOutcome,
  RunResult,
} from '#/engine/contract.ts'
import {
  type BrowserSession,
  BrowserLaunchError,
  closeBrowser,
  openBrowser,
} from '#/engine/runner/browser.ts'
import { createScrubber } from '#/engine/runner/scrub.ts'
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

    const instrumentation = createInstrumentation({ redact: scrubber.text })

    let session: BrowserSession | undefined
    let outcome: RunOutcome = 'passed'
    let errorKind: RunErrorKind | null = null
    let errorMessage: string | null = null
    let screenshot: ArrayBuffer | null = null
    let trace: ArrayBuffer | null = null
    let tracing = false

    const restoreConsole = captureConsole(push)

    try {
      session = await openBrowser(this.env.BROWSER, {
        baseUrl: this.env.BASE_URL,
        actionTimeoutMs: request.actionTimeoutMs,
      })

      if (request.trace) {
        try {
          await session.context.tracing.start({ screenshots: true, snapshots: true })
          tracing = true
        } catch (error) {
          push(`[harness] tracing unavailable: ${messageOf(error)}`)
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
          push(`[harness] failure screenshot unavailable: ${messageOf(screenshotError)}`)
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
          push(`[harness] trace unavailable: ${messageOf(error)}`)
        }
      }

      await closeBrowser(session?.browser)
    }

    const result: RunResult = {
      outcome,
      steps: instrumentation.steps,
      errorMessage: scrubber.nullable(errorMessage),
      logs: scrubber.lines(logs),
      durationMs: Date.now() - startedAt,
    }

    return { result, errorKind, screenshot, trace }
  }
}
