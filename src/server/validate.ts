/** Tiny hand-rolled validators — the app has no schema library as a dependency. */
import { parseCron } from '#/lib/cron.ts'

/** Thrown by every validator here; server functions surface the message as-is. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

function record(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null) throw new ValidationError('Expected an object.')
  return data as Record<string, unknown>
}

export function str(data: unknown, key: string, opts: { min?: number; max?: number } = {}): string {
  const value = record(data)[key]
  if (typeof value !== 'string') throw new ValidationError(`"${key}" is required.`)
  const trimmed = value.trim()
  const { min = 1, max = 5000 } = opts
  if (trimmed.length < min)
    throw new ValidationError(`"${key}" must be at least ${min} characters.`)
  if (trimmed.length > max) throw new ValidationError(`"${key}" must be at most ${max} characters.`)
  return trimmed
}

export function optionalStr(data: unknown, key: string, max = 5000): string | null {
  const value = record(data)[key]
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new ValidationError(`"${key}" must be text.`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new ValidationError(`"${key}" must be at most ${max} characters.`)
  return trimmed || null
}

/**
 * Whether a patch actually mentions a field. Lets partial updates tell "leave
 * this alone" (key absent) apart from "clear this" (key present, null).
 */
export function has(data: unknown, key: string): boolean {
  return record(data)[key] !== undefined
}

export function bool(data: unknown, key: string): boolean {
  const value = record(data)[key]
  if (typeof value === 'boolean') return value
  // Form posts arrive as strings, so accept the two spellings that mean it.
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ValidationError(`"${key}" must be true or false.`)
}

/** Narrows to the union the caller passed, so handlers keep their literal types. */
export function oneOf<T extends readonly [string, ...Array<string>]>(
  data: unknown,
  key: string,
  values: T,
): T[number] {
  const value = record(data)[key]
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new ValidationError(`"${key}" must be one of: ${values.join(', ')}.`)
  }
  return value as T[number]
}

/**
 * A five-field UTC cron expression, checked by the parser that will actually
 * run it.
 *
 * Deliberately not a looser check than the matcher: an expression this accepts
 * but `matchesCron` cannot read would be a schedule that silently never fires,
 * which is the worst possible outcome for a scheduling feature. The grammar is
 * documented on `src/lib/cron.ts`.
 */
export function cron(data: unknown, key: string): string | null {
  const value = optionalStr(data, key, 200)
  if (value === null) return null

  const parsed = parseCron(value)
  if (!parsed) {
    throw new ValidationError(
      `"${key}" is not a schedule we can run. Five fields — minute hour day month weekday — using numbers, "*", lists, ranges and steps.`,
    )
  }

  return parsed.expression
}

export function url(data: unknown, key: string): string {
  const value = str(data, key, { max: 2000 })
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`
  try {
    return new URL(withProtocol).toString().replace(/\/$/, '')
  } catch {
    throw new ValidationError(`"${key}" must be a valid URL.`)
  }
}
