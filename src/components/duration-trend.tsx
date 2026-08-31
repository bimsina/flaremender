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
    <div className="grid min-w-0 grid-cols-1 gap-3 rounded-lg bg-kumo-base px-5 py-4 ring ring-kumo-hairline">
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
