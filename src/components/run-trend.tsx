/**
 * A fortnight of runs, as a row of small stacked bars.
 *
 * Deliberately not a chart library: fourteen numbers do not need one, and the
 * thing being asked of this strip — "did something start going red, and when?"
 * — is answered by relative heights and two colours. Divs and Kumo tokens keep
 * it theme-aware for free and add nothing to the bundle.
 *
 * Every day in the window gets a column, including the ones nothing ran on: a
 * gap in a trend is information, and dropping empty days would silently
 * compress a quiet week into a busy one.
 */
import { Text } from '@cloudflare/kumo'

export interface RunTrendDay {
  /** `YYYY-MM-DD`, UTC — the day the run started, as the server grouped it. */
  day: string
  passed: number
  healed: number
  failed: number
  total: number
}

/** The tallest a bar can be, in pixels; every other day is scaled against it. */
const TRACK_PX = 48

/** A day with one run still has to be visible next to a day with fifty. */
const MIN_BAR_PX = 3

/**
 * Fixed locale and time zone: the server and the browser must agree on the
 * output or hydration reports a mismatch.
 */
function label(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function dayOfMonth(day: string): string {
  return String(Number(day.slice(-2)))
}

function describe(entry: RunTrendDay): string {
  if (entry.total === 0) return `${label(entry.day)} · nothing ran`

  const green = entry.passed + entry.healed
  const healed = entry.healed > 0 ? ` (${entry.healed} healed)` : ''
  return `${label(entry.day)} · ${green} passed${healed} · ${entry.failed} failed`
}

export function RunTrend({ days }: { days: Array<RunTrendDay> }) {
  const busiest = days.reduce((most, entry) => Math.max(most, entry.total), 0)

  const green = days.reduce((total, entry) => total + entry.passed + entry.healed, 0)
  const red = days.reduce((total, entry) => total + entry.failed, 0)

  function height(count: number): number {
    if (count === 0) return 0
    return Math.max(MIN_BAR_PX, Math.round((count / busiest) * TRACK_PX))
  }

  return (
    <div className="grid gap-3 rounded-lg bg-kumo-base px-5 py-4 ring ring-kumo-hairline">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Text as="h3" variant="heading">
          Last 14 days
        </Text>
        <Text as="span" variant="secondary" size="xs">
          {busiest === 0
            ? 'Nothing has run in the last two weeks'
            : `${green} passed · ${red} failed`}
        </Text>
      </div>

      <ol className="flex items-end gap-1.5">
        {days.map((entry) => (
          <li key={entry.day} className="grid flex-1 justify-items-center gap-1.5">
            <span
              className="flex w-full flex-col-reverse items-stretch gap-px"
              style={{ height: `${TRACK_PX}px` }}
              title={describe(entry)}
            >
              {entry.total === 0 ? (
                // A day nothing ran still holds its place, quietly.
                <span className="h-px w-full rounded-full bg-kumo-hairline" />
              ) : (
                <>
                  {entry.passed + entry.healed > 0 ? (
                    <span
                      className="w-full rounded-b-sm bg-kumo-success"
                      style={{ height: `${height(entry.passed + entry.healed)}px` }}
                    />
                  ) : null}
                  {entry.failed > 0 ? (
                    <span
                      className="w-full rounded-t-sm bg-kumo-danger"
                      style={{ height: `${height(entry.failed)}px` }}
                    />
                  ) : null}
                  {/* Whatever has not reached a verdict yet — a run still in
                      flight is neither green nor red, and pretending otherwise
                      would move the bar twice. */}
                  {entry.total - entry.passed - entry.healed - entry.failed > 0 ? (
                    <span
                      className="w-full rounded-t-sm bg-kumo-interact"
                      style={{
                        height: `${height(entry.total - entry.passed - entry.healed - entry.failed)}px`,
                      }}
                    />
                  ) : null}
                </>
              )}
            </span>
            <Text as="span" variant="secondary" size="xs">
              {dayOfMonth(entry.day)}
            </Text>
          </li>
        ))}
      </ol>
    </div>
  )
}
