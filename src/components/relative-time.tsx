import { formatRelative } from '#/lib/format.ts'

export function RelativeTime({ value }: { value: Date | string | number | null | undefined }) {
  return <span suppressHydrationWarning>{formatRelative(value)}</span>
}
