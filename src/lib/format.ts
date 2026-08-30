export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
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
