/**
 * A fortnight of runs, as one stacked bar per day.
 *
 * Every day in the window gets a column, including the ones nothing ran on: a
 * gap in a trend is information, and dropping empty days would silently
 * compress a quiet week into a busy one. The server fills those in, so this
 * component never does calendar arithmetic.
 *
 * The chart itself is drawn by the client-only half — ECharts is far too large
 * to ship in the Worker — so what renders on the server, and for the moment
 * before the chunk lands, is a box of exactly the right height inside exactly
 * the same card.
 */
import { Text } from '@cloudflare/kumo'
import { useMemo } from 'react'

import { ChartPlaceholder, useChartView } from '#/components/chart.tsx'
import { InlineEmpty } from '#/components/list.tsx'
import { type RunTrendDay, runTrendSeries, runTrendTotal } from '#/lib/chart-data.ts'
import { useTheme } from '#/lib/theme.tsx'

export type { RunTrendDay }

/** Tall enough on the dashboard to read a shape; short enough in a tab to skim. */
const FULL_PX = 180
const COMPACT_PX = 132

export function RunTrend({
  days,
  /** The tab version: same chart, half the height, no caption competing with it. */
  compact = false,
}: {
  days: Array<RunTrendDay>
  compact?: boolean
}) {
  const { resolved } = useTheme()
  const view = useChartView()

  const series = useMemo(() => runTrendSeries(days), [days])
  const total = runTrendTotal(days)
  const height = compact ? COMPACT_PX : FULL_PX

  return (
    <div className="grid gap-3 rounded-lg bg-kumo-base px-5 py-4 ring ring-kumo-hairline">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Text as="h3" variant="heading">
          Last 14 days
        </Text>
        {total > 0 ? (
          <Text as="span" variant="secondary" size="base">
            {total} run{total === 1 ? '' : 's'}
          </Text>
        ) : null}
      </div>

      {total === 0 ? (
        <InlineEmpty message="Nothing has run in the last two weeks." />
      ) : view ? (
        <view.RunTrendChart series={series} height={height} isDarkMode={resolved === 'dark'} />
      ) : (
        <ChartPlaceholder height={height} />
      )}
    </div>
  )
}
