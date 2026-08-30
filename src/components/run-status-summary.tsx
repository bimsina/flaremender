/**
 * The roll-up above a table of runs: how the window in front of you broke down.
 *
 * Deliberately computed from the rows that were loaded rather than from a
 * separate `count(*)` — the strip and the table then always agree, and a strip
 * that disagrees with the list under it is worse than no strip.
 *
 * A count of zero is shown, dimmed, rather than hidden: "no failures" is the
 * fact people come here for, and it cannot be read off an absent segment.
 */
import { Text } from '@cloudflare/kumo'
import { useMemo } from 'react'

import { SummaryStrip } from '#/components/summary-strip.tsx'
import type { RunStatus } from '#/db/schema/app.ts'

const ENTRIES = [
  { key: 'passed', label: 'Passed', dot: 'bg-kumo-success' },
  { key: 'healed', label: 'Healed', dot: 'bg-kumo-info' },
  { key: 'failed', label: 'Failed', dot: 'bg-kumo-danger' },
  { key: 'error', label: 'Error', dot: 'bg-kumo-warning' },
  { key: 'active', label: 'Running', dot: 'bg-kumo-interact' },
] as const

function bucket(status: RunStatus): (typeof ENTRIES)[number]['key'] {
  return status === 'queued' || status === 'running' ? 'active' : status
}

export function RunStatusSummary({ runs }: { runs: Array<{ status: RunStatus }> }) {
  const items = useMemo(
    () =>
      ENTRIES.map((entry) => {
        const count = runs.filter((row) => bucket(row.status) === entry.key).length
        return {
          key: entry.key,
          dim: count === 0,
          label: (
            <>
              <span className={`size-2 rounded-full ${entry.dot}`} />
              {entry.label}
            </>
          ),
          value: (
            <Text as="span" variant="heading">
              {count}
            </Text>
          ),
        }
      }),
    [runs],
  )

  return <SummaryStrip items={items} />
}
