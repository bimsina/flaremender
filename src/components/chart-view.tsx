import {
  Chart,
  ChartLegend,
  ChartPalette,
  type KumoChartOption,
  TimeseriesChart,
} from '@cloudflare/kumo/components/chart'
import { BarChart } from 'echarts/charts'
import {
  AriaComponent,
  BrushComponent,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useMemo, useRef } from 'react'

import {
  type DurationTrendPoint,
  RUN_OUTCOMES,
  type RunOutcome,
  type RunTrendSeries,
  type RunTrendSeriesKey,
  durationTrendTotals,
} from '#/lib/chart-data.ts'
import { formatDuration } from '#/lib/format.ts'

echarts.use([
  BarChart,
  GridComponent,
  TooltipComponent,
  BrushComponent,
  ToolboxComponent,
  AriaComponent,
  CanvasRenderer,
])

function runTrendColor(key: RunTrendSeriesKey, isDarkMode: boolean): string {
  switch (key) {
    case 'passed':
      return ChartPalette.semantic('Success', isDarkMode)
    case 'failed':
      return ChartPalette.semantic('Attention', isDarkMode)
    case 'error':
      return ChartPalette.semantic('Warning', isDarkMode)
    case 'running':
      return ChartPalette.semantic('Disabled', isDarkMode)
  }
}

function outcomeColor(key: RunOutcome, isDarkMode: boolean): string {
  switch (key) {
    case 'passed':
      return ChartPalette.semantic('Success', isDarkMode)
    case 'failed':
      return ChartPalette.semantic('Attention', isDarkMode)
  }
}

const DAY_TICK = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

function formatDayTick(value: number): string {
  return DAY_TICK.format(new Date(value))
}

function formatCountTick(value: number): string {
  return Number.isInteger(value) ? String(value) : ''
}

function formatRunCount(value: number): string {
  return `${value} run${value === 1 ? '' : 's'}`
}

function Legend({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{children}</div>
}

/** Kumo skips the first resize callback; observe it here to correct measurements taken before layout settles. */
function useFitToWidth() {
  const chart = useRef<echarts.ECharts | null>(null)
  const host = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return

    const observer = new ResizeObserver(() => chart.current?.resize())
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return { chart, host }
}

export function RunTrendChart({
  series,
  height,
  isDarkMode,
}: {
  series: Array<RunTrendSeries>
  height: number
  isDarkMode: boolean
}) {
  const data = useMemo(
    () =>
      series
        .filter((entry) => entry.total > 0)
        .map((entry) => ({
          name: entry.name,
          data: entry.points,
          color: runTrendColor(entry.key, isDarkMode),
        })),
    [series, isDarkMode],
  )

  const legend = series.filter((entry) => entry.key !== 'running' || entry.total > 0)
  const { chart, host } = useFitToWidth()

  return (
    <div className="grid min-w-0 grid-cols-1 gap-2">
      <div ref={host} className="min-w-0 overflow-hidden">
        <TimeseriesChart
          ref={chart}
          echarts={echarts}
          type="bar"
          data={data}
          height={height}
          isDarkMode={isDarkMode}
          xAxisTickCount={7}
          xAxisTickFormat={formatDayTick}
          yAxisTickFormat={formatCountTick}
          tooltipValueFormat={formatRunCount}
          tooltipFollowCursor="x"
          ariaDescription="Runs per day for the last fourteen days, stacked by status."
        />
      </div>
      <Legend>
        {legend.map((entry) => (
          <ChartLegend.SmallItem
            key={entry.key}
            name={entry.name}
            color={runTrendColor(entry.key, isDarkMode)}
            value={String(entry.total)}
            inactive={entry.total === 0}
          />
        ))}
      </Legend>
    </div>
  )
}

export function DurationTrendChart({
  points,
  height,
  isDarkMode,
}: {
  points: Array<DurationTrendPoint>
  height: number
  isDarkMode: boolean
}) {
  const totals = durationTrendTotals(points)
  const axisText = ChartPalette.text('primary', isDarkMode)
  const { chart, host } = useFitToWidth()

  const options = useMemo(
    (): KumoChartOption => ({
      grid: { left: 56, right: 16, top: 16, bottom: 24 },
      tooltip: {
        trigger: 'item',
        valueFormatter: (value) => formatDuration(Number(value)),
      },
      xAxis: {
        type: 'category',
        data: points.map((point) => point.label),
        axisTick: { show: false },
        axisLabel: { color: axisText, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: axisText, margin: 12, formatter: formatDuration },
        splitLine: { lineStyle: { type: 'dashed' } },
      },
      series: RUN_OUTCOMES.map((outcome) => ({
        type: 'bar',
        name: outcome.name,
        stack: 'run',
        barMaxWidth: 16,
        itemStyle: { color: outcomeColor(outcome.key, isDarkMode) },
        data: points.map((point) => (point.outcome === outcome.key ? point.durationMs : null)),
      })),
    }),
    [points, isDarkMode, axisText],
  )

  return (
    <div className="grid min-w-0 grid-cols-1 gap-2">
      <div ref={host} className="min-w-0 overflow-hidden">
        <Chart
          ref={chart}
          echarts={echarts}
          options={options}
          height={height}
          isDarkMode={isDarkMode}
        />
      </div>
      <Legend>
        {RUN_OUTCOMES.map((outcome) => (
          <ChartLegend.SmallItem
            key={outcome.key}
            name={outcome.name}
            color={outcomeColor(outcome.key, isDarkMode)}
            value={String(totals[outcome.key])}
            inactive={totals[outcome.key] === 0}
          />
        ))}
      </Legend>
    </div>
  )
}
