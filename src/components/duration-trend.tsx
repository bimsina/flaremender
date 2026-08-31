/**
 * How long a test's recent runs took, one bar each, coloured by verdict.
 *
 * Drawn from the rows already on screen rather than from a query of its own, so
 * the chart and the table under it can never disagree about what happened. A
 * regression shows up as a step in the heights and flakiness as a red bar in a
 * green stretch — both of which a table of durations makes you read for.
 *
 * Nothing is drawn when there is nothing to draw: a test whose runs are all
 * still queued has a table that already says so, and a dashed empty box above
 * it would only be one more thing to look at.
 */
import { Text } from '@cloudflare/kumo'
import { useMemo } from 'react'

import { ChartPlaceholder, useChartView } from '#/components/chart.tsx'
import { type DurationTrendRun, durationTrendPoints } from '#/lib/chart-data.ts'
import { useTheme } from '#/lib/theme.tsx'

export type { DurationTrendRun }

const HEIGHT_PX = 148

export function DurationTrend({ runs }: { runs: Array<DurationTrendRun> }) {
  const { resolved } = useTheme()
  const view = useChartView()

  const points = useMemo(() => durationTrendPoints(runs), [runs])
  if (points.length === 0) return null

  return (
    <div className="grid gap-3 rounded-lg bg-kumo-base px-5 py-4 ring ring-kumo-hairline">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Text as="h3" variant="heading">
          Duration
        </Text>
        <Text as="span" variant="secondary" size="base">
          {points.length} completed run{points.length === 1 ? '' : 's'}, oldest first
        </Text>
      </div>

      {view ? (
        <view.DurationTrendChart
          points={points}
          height={HEIGHT_PX}
          isDarkMode={resolved === 'dark'}
        />
      ) : (
        <ChartPlaceholder height={HEIGHT_PX} />
      )}
    </div>
  )
}
