/**
 * The pure half of the charts: run history in, plot-ready series out.
 *
 * Kept apart from the components that draw them for two reasons. It is
 * arithmetic over numbers the server already grouped, so it is worth testing
 * without a canvas; and it must stay importable from the server render, which
 * the ECharts half deliberately is not.
 */
import type { RunStatus } from '#/db/schema/app.ts'

export interface RunTrendDay {
  /** `YYYY-MM-DD`, UTC — the day the run started, as the server grouped it. */
  day: string
  passed: number
  healed: number
  failed: number
  error: number
  running: number
  total: number
}

/**
 * The order the segments stack in, bottom to top: the greens first, then the
 * reds, then whatever has not finished. A day's bar is therefore read the same
 * way every time regardless of which statuses it happens to contain.
 */
export const RUN_TREND_SERIES = [
  { key: 'passed', name: 'Passed' },
  { key: 'healed', name: 'Healed' },
  { key: 'failed', name: 'Failed' },
  { key: 'error', name: 'Errored' },
  { key: 'running', name: 'Running' },
] as const

export type RunTrendSeriesKey = (typeof RUN_TREND_SERIES)[number]['key']

export interface RunTrendSeries {
  key: RunTrendSeriesKey
  name: string
  /** `[timestamp, count]` for every day in the window, zeroes included. */
  points: Array<[number, number]>
  /** How many runs this series accounts for across the whole window. */
  total: number
}

/**
 * Midday rather than midnight, in milliseconds.
 *
 * The bucket is a whole UTC day, so any instant inside it would do — but the
 * chart's tooltip formats the timestamp in the reader's own time zone, and
 * midnight UTC lands on the previous date for everyone west of Greenwich.
 * Noon survives every offset a person actually lives at.
 */
export function dayTimestamp(day: string): number {
  return Date.parse(`${day}T12:00:00.000Z`)
}

/**
 * A day-by-status table turned into one series per status.
 *
 * Every series carries a point for every day, including the days it was zero
 * on: the chart finds a tooltip row by looking for the nearest point it has,
 * so a series that skipped its empty days would answer for them with a
 * neighbour's number.
 */
export function runTrendSeries(days: Array<RunTrendDay>): Array<RunTrendSeries> {
  return RUN_TREND_SERIES.map((series) => {
    const points = days.map((entry): [number, number] => [
      dayTimestamp(entry.day),
      entry[series.key],
    ])
    return {
      key: series.key,
      name: series.name,
      points,
      total: points.reduce((sum, [, count]) => sum + count, 0),
    }
  })
}

/** How many runs the whole window holds — zero means "draw nothing". */
export function runTrendTotal(days: Array<RunTrendDay>): number {
  return days.reduce((sum, entry) => sum + entry.total, 0)
}

/* ------------------------------------------------------- Duration per run */

/** Three buckets, because three is what a duration bar can be coloured by. */
export const RUN_OUTCOMES = [
  { key: 'passed', name: 'Passed' },
  { key: 'healed', name: 'Healed' },
  { key: 'failed', name: 'Failed or errored' },
] as const

export type RunOutcome = (typeof RUN_OUTCOMES)[number]['key']

export interface DurationTrendRun {
  id: string
  status: RunStatus
  durationMs: number | null
  startedAt: Date
}

export interface DurationTrendPoint {
  id: string
  /** The category-axis label: when it ran, in UTC, like every other date here. */
  label: string
  outcome: RunOutcome
  durationMs: number
}

function outcomeOf(status: RunStatus): RunOutcome | null {
  if (status === 'passed') return 'passed'
  if (status === 'healed') return 'healed'
  if (status === 'failed' || status === 'error') return 'failed'
  // Queued and running have no verdict yet, and no duration to plot either.
  return null
}

/**
 * Fixed locale and time zone, as everywhere else here: the label is derived on
 * whichever side renders first and must not change when the other one reads it.
 *
 * Down to the second, because a suite starts its members inside the same minute
 * and two bars labelled identically are two bars nobody can tell apart.
 */
const RUN_LABEL = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'UTC',
})

/**
 * The runs already on screen, oldest first, as one bar each.
 *
 * Runs still in flight are dropped rather than drawn at zero — a bar of no
 * height reads as "instant", which is the opposite of what a queued run means.
 * The input arrives newest-first, the way every table here lists it; a trend
 * has to run the other way.
 */
export function durationTrendPoints(runs: Array<DurationTrendRun>): Array<DurationTrendPoint> {
  const points: Array<DurationTrendPoint> = []

  for (const row of runs) {
    const outcome = outcomeOf(row.status)
    if (outcome === null || row.durationMs === null) continue
    points.push({
      id: row.id,
      label: RUN_LABEL.format(new Date(row.startedAt)),
      outcome,
      durationMs: row.durationMs,
    })
  }

  return points.reverse()
}

/** How many of the plotted runs landed in each bucket, for the legend. */
export function durationTrendTotals(points: Array<DurationTrendPoint>): Record<RunOutcome, number> {
  const totals: Record<RunOutcome, number> = { passed: 0, healed: 0, failed: 0 }
  for (const point of points) totals[point.outcome] += 1
  return totals
}
