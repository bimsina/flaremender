import { Text } from '@cloudflare/kumo'
import { Fragment } from 'react'

import { durationParts } from '#/lib/format.ts'

/**
 * A duration with its units muted: `13 s 34 ms` reads as a number first and a
 * unit second, which is what makes a column of them scannable.
 */
export function Duration({ ms }: { ms: number | null | undefined }) {
  const parts = durationParts(ms)

  if (parts.length === 0) {
    return (
      <Text as="span" variant="secondary">
        —
      </Text>
    )
  }

  return (
    <span className="inline-flex items-baseline gap-1 tabular-nums">
      {parts.map((part) => (
        <Fragment key={part.unit}>
          <span>{part.value}</span>
          <span className="text-kumo-subtle">{part.unit}</span>
        </Fragment>
      ))}
    </span>
  )
}
