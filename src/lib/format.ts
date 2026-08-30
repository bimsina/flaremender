export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** One magnitude of a duration: `13` and `s`, then `34` and `ms`. */
export interface DurationPart {
  value: number
  unit: 'ms' | 's' | 'm' | 'h'
}

/**
 * A duration split into at most two magnitudes, so the number and its unit can
 * be styled apart — the unit muted, the number not. Truncated rather than
 * rounded: a step that took 13.9s took thirteen seconds and some, and rounding
 * it up to 14 would disagree with the sum of its parts.
 */
export function durationParts(ms: number | null | undefined): Array<DurationPart> {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return []
  if (ms < 1000) return [{ value: Math.round(ms), unit: 'ms' }]

  const totalSeconds = Math.floor(ms / 1000)
  const rest = Math.round(ms % 1000)

  if (totalSeconds < 60) {
    const parts: Array<DurationPart> = [{ value: totalSeconds, unit: 's' }]
    if (rest > 0) parts.push({ value: rest, unit: 'ms' })
    return parts
  }

  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) {
    const parts: Array<DurationPart> = [{ value: totalMinutes, unit: 'm' }]
    const seconds = totalSeconds % 60
    if (seconds > 0) parts.push({ value: seconds, unit: 's' })
    return parts
  }

  const parts: Array<DurationPart> = [{ value: Math.floor(totalMinutes / 60), unit: 'h' }]
  const minutes = totalMinutes % 60
  if (minutes > 0) parts.push({ value: minutes, unit: 'm' })
  return parts
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
]

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Depends on the current clock, so only render this after hydration. */
export function formatRelative(value: Date | string | number | null | undefined): string {
  const date = toDate(value)
  if (!date) return '—'

  const diff = date.getTime() - Date.now()
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return RELATIVE.format(Math.round(diff / size), unit)
  }
  return 'just now'
}

/**
 * Fixed locale and time zone: the server and the browser must agree on the
 * output or hydration reports a mismatch.
 */
export function formatDate(value: Date | string | number | null | undefined): string {
  const date = toDate(value)
  if (!date) return '—'
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}
