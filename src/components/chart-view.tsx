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

/**
 * Every ECharts import in the app lives here, and nothing imports this module
 * statically — `chart.tsx` pulls it in from an effect, so ECharts is a
 * client-only chunk and never reaches the Worker bundle. Same arrangement as
 * `code-editor-view.ts`, and for the same reason: it is about a megabyte.
 *
 * Kumo's chart components take the ECharts instance as a prop rather than
 * importing it, which is what makes that possible — and what makes registering
 * the pieces this app actually draws our job.
 */
echarts.use([
  BarChart,
  GridComponent,
  TooltipComponent,
  // `TimeseriesChart` writes `brush`, `toolbox` and `aria` into every option it
  // builds, whether or not the caller asked for them, so all three have to be
  // registered or ECharts logs a missing-component warning on first paint.
  BrushComponent,
  ToolboxComponent,
  AriaComponent,
  CanvasRenderer,
])

/**
 * Verdicts are meaning, not identity, so they come from the semantic palette
 * rather than the categorical one — except healed, which has no semantic name
 * and takes the first categorical colour (blue), matching the `bg-kumo-info`
 * dot the status strips already use for it.
 */
function runTrendColor(key: RunTrendSeriesKey, isDarkMode: boolean): string {
  switch (key) {
    case 'passed':
      return ChartPalette.semantic('Success', isDarkMode)
    case 'healed':
      return ChartPalette.categorical(0, isDarkMode)
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
    case 'healed':
      return ChartPalette.categorical(0, isDarkMode)
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

/**
 * Runs are counted, so half a run is not a tick. ECharts picks the divisions
 * and a window whose busiest day saw one run would otherwise be ruled at 0.25.
 */
function formatCountTick(value: number): string {
  return Number.isInteger(value) ? String(value) : ''
}

function formatRunCount(value: number): string {
  return `${value} run${value === 1 ? '' : 's'}`
}

/** A legend row rather than a chart legend: no click targets, no box, no title. */
function Legend({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{children}</div>
}

/**
 * Keeps the canvas the width of the box it is in.
 *
 * ECharts sizes its canvas once, from the container as it stood when `init`
 * ran, and Kumo's `Chart` deliberately ignores the first callback from its own
 * ResizeObserver to avoid a redundant resize at mount. When the surrounding
 * grid has not settled by the time `init` measures it — which is a race, and
 * one this app loses often enough to notice — that ignored callback is exactly
 * the one that would have corrected it, and the chart stays a few hundred
 * pixels wide inside a full-width card forever.
 *
 * Observing the wrapper ourselves and resizing on every callback, first one
 * included, makes the width a fact rather than a timing outcome.
 */
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

/**
 * A fortnight of runs as one stacked bar per day.
 *
 * Only the statuses that actually occurred are handed to the chart — a series
 * of fourteen zeroes is a row of nothing in the tooltip and a colour in the
 * legend that never appears — but the legend still names the empty ones,
 * dimmed, because "no failures" is a fact people come here to read and it
 * cannot be read off an absent segment.
 */
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

  // "Running 0" is noise — nothing is in flight almost all of the time — where
  // "Failed 0" is the headline. So the unfinished bucket is named only when
  // there is something in it.
  const legend = series.filter((entry) => entry.key !== 'running' || entry.total > 0)
  const { chart, host } = useFitToWidth()

  return (
    <div className="grid gap-2">
      <div ref={host}>
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

/**
 * How long each of the recent runs took, one bar each, coloured by verdict.
 *
 * The low-level `Chart` rather than `TimeseriesChart` because the x-axis here
 * is a sequence, not a clock: runs cluster — a suite fires seven of them inside
 * a minute — and on a real time axis those seven collapse into a hairline while
 * a quiet week stretches out beside them. Evenly spaced bars answer the
 * question actually being asked, which is whether this intent is getting slower
 * or flakier, and the label under each bar still says when it ran.
 *
 * One series per verdict, each holding nulls everywhere it does not apply, so
 * hovering a bar names its outcome without a per-point tooltip formatter. They
 * share a stack so that each still occupies its category's full width.
 */
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
    <div className="grid gap-2">
      <div ref={host}>
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
