import type { RunStep } from '#/engine/contract.ts'

const RAW = Symbol('flaremender.raw')
const PATH = Symbol('flaremender.path')

const MAX_ARG_LENGTH = 60
const MAX_LABEL_LENGTH = 240

/** Use property access: these proxies implement get but not has. */
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

/** The Playwright fork does not export Locator’s class identity. */
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
  watch: <T extends object>(target: T, path: string) => T
  watchExpect: <T extends object>(target: T) => T
  steps: Array<RunStep>
  nextIndex: () => number
}

export function createInstrumentation(options: {
  redact: (text: string) => string
  onStepStarted?: (index: number, label: string) => void
  onStep?: (index: number, step: RunStep) => void
  startIndex?: number
}): Instrumentation {
  const steps: Array<RunStep> = []
  const completed = new Map<number, RunStep>()

  /** Reserve indices at call start so concurrent completions retain the same step IDs. */
  let nextIndex = options.startIndex ?? 0

  function record(index: number, label: string, started: number, error: unknown): void {
    const step: RunStep = {
      label,
      ok: error === undefined,
      durationMs: Date.now() - started,
      ...(error === undefined
        ? {}
        : { error: options.redact(error instanceof Error ? error.message : String(error)) }),
    }

    completed.set(index, step)
    steps.splice(
      0,
      steps.length,
      ...[...completed].sort(([a], [b]) => a - b).map(([, value]) => value),
    )
    options.onStep?.(index, step)
  }

  async function settle(rawLabel: string, promise: Promise<unknown>): Promise<unknown> {
    const started = Date.now()
    const index = nextIndex++
    const label = options.redact(clip(rawLabel))

    options.onStepStarted?.(index, label)

    try {
      const value = await promise
      record(index, label, started, undefined)
      return value
    } catch (error) {
      record(index, label, started, error)
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
          // Playwright private fields require the real object as the receiver.
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

  return { watch, watchExpect, steps, nextIndex: () => nextIndex }
}
