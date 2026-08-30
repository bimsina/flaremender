import { formatRelative } from '#/lib/format.ts'

/**
 * Relative times are computed from the current clock, so the server and the
 * browser can disagree by a second. Suppress that rather than freezing the
 * value or deferring the whole render.
 */
export function RelativeTime({ value }: { value: Date | string | number | null | undefined }) {
  return <span suppressHydrationWarning>{formatRelative(value)}</span>
}
