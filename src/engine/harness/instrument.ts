/**
 * Step capture, without a step API.
 *
 * A script written against real Playwright has no notion of "steps" — it is a
 * flat sequence of awaits. Rather than make authors annotate their code, `page`
 * and `expect` are handed over behind proxies that watch calls go past: every
 * call that returns a promise becomes one step, labelled with the chain that
 * produced it (`page.getByRole('button', { name: 'Sign in' }).click()`).
 *
 * The proxies are deliberately non-invasive. Methods are invoked with the *real*
 * object as `this`, arguments are unwrapped back to real objects before they are
 * passed on, and anything that is not a promise or a locator is returned
 * untouched. Playwright never sees a proxy, so nothing about its behaviour
 * changes — including the parts of its API this file has never heard of.
 */
import type { RunStep } from '#/engine/contract.ts'

/** Reaches the real object behind a proxy. */
const RAW = Symbol('flaremender.raw')
/** The call chain that produced a proxy, used to label its steps. */
const PATH = Symbol('flaremender.path')

const MAX_ARG_LENGTH = 60
const MAX_LABEL_LENGTH = 240

/**
 * Reads a symbol the proxies answer for. `in` would not do: the traps below
 * define no `has`, so membership tests fall through to the real object.
 */
function readMarker(value: unknown, marker: symbol): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined
  }
  return (value as Record<symbol, unknown>)[marker]
}

function pathOf(value: unknown): string | undefined {
  const path = readMarker(value, PATH)
  return typeof path === 'string' ? path : undefined
}

/** Arguments cross back into Playwright as the objects it gave us. */
function unwrap(value: unknown): unknown {
  return readMarker(value, RAW) ?? value
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Locators are the only synchronous results worth following, because they are
 * where the next action will happen. Duck-typed rather than `instanceof`: the
 * fork's class identity is not exported.
 */
function isLocatorLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.click === 'function' && typeof candidate.first === 'function'
}

function describeArg(value: unknown): string {
  if (typeof value === 'string') {
    const clipped = value.length > MAX_ARG_LENGTH ? `${value.slice(0, MAX_ARG_LENGTH)}…` : value
    return `'${clipped}'`
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value)
  }
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return 'fn'

  const path = pathOf(value)
  if (path !== undefined) return path

  if (Array.isArray(value)) return `[${value.map(describeArg).join(', ')}]`

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 4)
      .map(([key, item]) => `${key}: ${describeArg(item)}`)
    return `{ ${entries.join(', ')} }`
  }

  return String(value)
}

function describeArgs(args: Array<unknown>): string {
  return args.map(describeArg).join(', ')
}

function clip(label: string): string {
  return label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH)}…` : label
}

export interface Instrumentation {
  /** Wraps a Playwright object so its calls are recorded. */
  watch: <T extends object>(target: T, path: string) => T
  /** Wraps `expect` so assertions are recorded with the locator they ran against. */
  watchExpect: <T extends object>(target: T) => T
  steps: Array<RunStep>
}

export function createInstrumentation(options: {
  /** Applied to every label and error before it is recorded. */
  redact: (text: string) => string
  /** Fires as each step settles, so a future live channel can forward it. */
  onStep?: (step: RunStep) => void
}): Instrumentation {
  const steps: Array<RunStep> = []

  function record(label: string, started: number, error: unknown): void {
    const step: RunStep = {
      label: options.redact(clip(label)),
      ok: error === undefined,
      durationMs: Date.now() - started,
      ...(error === undefined
        ? {}
        : { error: options.redact(error instanceof Error ? error.message : String(error)) }),
    }

    steps.push(step)
    options.onStep?.(step)
  }

  /** Runs a promise-returning call as one step. */
  async function settle(label: string, promise: Promise<unknown>): Promise<unknown> {
    const started = Date.now()
    try {
      const value = await promise
      record(label, started, undefined)
      return value
    } catch (error) {
      record(label, started, error)
      throw error
    }
  }

  function watch<T extends object>(target: T, path: string): T {
    return new Proxy(target, {
      get(object, property, receiver) {
        if (property === RAW) return object
        if (property === PATH) return path

        const value = Reflect.get(object, property, receiver)
        if (typeof value !== 'function' || typeof property === 'symbol') return value

        const name = String(property)

        return function instrumented(this: unknown, ...args: Array<unknown>) {
          const label = `${path}.${name}(${describeArgs(args)})`
          // `this` is the real object: Playwright's internals rely on private
          // fields, which a proxy receiver would not satisfy.
          const result = (value as (...rest: Array<unknown>) => unknown).apply(
            object,
            args.map(unwrap),
          )

          if (isThenable(result)) return settle(label, result)
          if (isLocatorLike(result)) return watch(result as object, label)
          return result
        }
      },
    }) as T
  }

  /**
   * `expect(locator).toBeVisible()` is two calls, and only the second one runs.
   * The apply trap remembers what was asserted about; the returned matcher
   * object records the assertion itself.
   */
  function watchExpect<T extends object>(target: T): T {
    return new Proxy(target, {
      apply(object, thisArg, args: Array<unknown>) {
        const label = `expect(${describeArg(args[0])})`
        const matchers = Reflect.apply(
          object as unknown as (...rest: Array<unknown>) => unknown,
          thisArg,
          args.map(unwrap),
        )

        return typeof matchers === 'object' && matchers !== null
          ? watchMatchers(matchers as object, label)
          : matchers
      },
    }) as T
  }

  /** `.not`, `.resolves` and friends are chained getters, not calls. */
  function watchMatchers<T extends object>(target: T, path: string): T {
    return new Proxy(target, {
      get(object, property, receiver) {
        if (property === RAW) return object
        if (property === PATH) return path
        if (typeof property === 'symbol') return Reflect.get(object, property, receiver)

        const value = Reflect.get(object, property, receiver)
        const name = String(property)

        if (typeof value === 'object' && value !== null) {
          return watchMatchers(value, `${path}.${name}`)
        }
        if (typeof value !== 'function') return value

        return function instrumented(this: unknown, ...args: Array<unknown>) {
          const label = `${path}.${name}(${describeArgs(args)})`
          const result = (value as (...rest: Array<unknown>) => unknown).apply(
            object,
            args.map(unwrap),
          )

          return isThenable(result) ? settle(label, result) : result
        }
      },
    }) as T
  }

  return { watch, watchExpect, steps }
}
