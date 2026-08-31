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
