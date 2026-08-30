/** Tiny hand-rolled validators — the app has no schema library as a dependency. */
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

export function url(data: unknown, key: string): string {
  const value = str(data, key, { max: 2000 })
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`
  try {
    return new URL(withProtocol).toString().replace(/\/$/, '')
  } catch {
    throw new ValidationError(`"${key}" must be a valid URL.`)
  }
}
