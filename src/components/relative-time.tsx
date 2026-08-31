import { formatRelative } from '#/lib/format.ts'

export function RelativeTime({ value }: { value: Date | string | number | null | undefined }) {
  const date = value == null ? null : new Date(value)
  const valid = date !== null && !Number.isNaN(date.getTime())
  return (
    <time
      dateTime={valid ? date.toISOString() : undefined}
      title={valid ? date.toUTCString() : undefined}
      suppressHydrationWarning
    >
      {formatRelative(value)}
    </time>
  )
}
