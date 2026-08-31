import type { RunStatus } from '#/db/schema/app.ts'

export interface RunTrendDay {
  day: string
  passed: number
  healed: number
  failed: number
  error: number
  running: number
  total: number
}

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
  points: Array<[number, number]>
  total: number
}

export function dayTimestamp(day: string): number {
  return Date.parse(`${day}T12:00:00.000Z`)
}

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

export function runTrendTotal(days: Array<RunTrendDay>): number {
  return days.reduce((sum, entry) => sum + entry.total, 0)
}

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
  label: string
  outcome: RunOutcome
  durationMs: number
}

function outcomeOf(status: RunStatus): RunOutcome | null {
  if (status === 'passed') return 'passed'
  if (status === 'healed') return 'healed'
  if (status === 'failed' || status === 'error') return 'failed'
  return null
}

const RUN_LABEL = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'UTC',
})

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

export function durationTrendTotals(points: Array<DurationTrendPoint>): Record<RunOutcome, number> {
  const totals: Record<RunOutcome, number> = { passed: 0, healed: 0, failed: 0 }
  for (const point of points) totals[point.outcome] += 1
  return totals
}
