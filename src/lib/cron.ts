/**
 * A five-field cron expression, parsed and matched in UTC.
 *
 * Hand-rolled rather than taken from npm, for two reasons. The obvious one is
 * that this runs in a Worker on every minute tick and a dependency would be a
 * dependency. The less obvious one is that *the same grammar has to be true in
 * three places* — the field that accepts a schedule, the badge that describes
 * it, and the dispatcher that decides a minute is the one — and the only way to
 * keep them honest is for all three to call the same parser.
 *
 * ## Grammar
 *
 * ```
 * minute hour day-of-month month day-of-week
 *   0-59  0-23      1-31     1-12         0-7
 * ```
 *
 * Each field is a comma-separated list of terms, each of which is one of:
 *
 * | Term    | Meaning                                              |
 * | ------- | ---------------------------------------------------- |
 * | `*`     | every value in the field's range                     |
 * | `* /n`  | every value, stepping by `n` (written without the space) |
 * | `a`     | exactly `a`                                          |
 * | `a-b`   | `a` through `b`, inclusive                           |
 * | `a-b/n` | `a` through `b`, stepping by `n`                     |
 * | `a/n`   | `a` through the field's maximum, stepping by `n`     |
 *
 * Day-of-week takes `0-7` with both `0` and `7` meaning Sunday. Names — `MON`,
 * `JAN` — are deliberately *not* accepted: half-supporting them (matching `MON`
 * but not `MON-FRI`) would be worse than rejecting them with a message that
 * says to use a number.
 *
 * ## Day-of-month and day-of-week together
 *
 * POSIX, and every cron since Vixie's, treats the two day fields as an **OR**
 * once both are restricted: `0 6 1 * 1` fires on the first of the month *and*
 * on every Monday, not on Mondays that fall on the first. When either field is
 * unrestricted the two are ANDed, which is the ordinary reading.
 *
 * "Restricted" here means the field does not begin with `*` — the same test
 * Vixie cron makes, so a stepped star in day-of-month keeps the AND behaviour
 * even though it does not match every day.
 */

interface FieldSpec {
  name: string
  min: number
  max: number
}

const FIELD_SPECS: Array<FieldSpec> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  // 7 is accepted and folded onto 0; both spell Sunday.
  { name: 'day of week', min: 0, max: 7 },
]

interface ParsedField {
  /** Every value the field matches. Day-of-week has 7 folded onto 0. */
  values: Set<number>
  /** False when the field begins with `*` — the flag the day rule turns on. */
  restricted: boolean
  /** The field exactly as written, for `describeCron`. */
  raw: string
}

export interface ParsedCron {
  minute: ParsedField
  hour: ParsedField
  dayOfMonth: ParsedField
  month: ParsedField
  dayOfWeek: ParsedField
  /** The expression with its whitespace normalised to single spaces. */
  expression: string
}

function parseNumber(text: string, spec: FieldSpec): number | null {
  if (!/^\d{1,2}$/.test(text)) return null
  const value = Number(text)
  if (value < spec.min || value > spec.max) return null
  return value
}

/** One comma-separated term, expanded into the values it covers. */
function parseTerm(term: string, spec: FieldSpec, into: Set<number>): boolean {
  const [range, step] = term.split('/')
  if (range === undefined || term.split('/').length > 2) return false

  let stride = 1
  if (step !== undefined) {
    if (!/^\d{1,2}$/.test(step)) return false
    stride = Number(step)
    if (stride < 1) return false
  }

  let from: number
  let to: number

  if (range === '*') {
    from = spec.min
    to = spec.max
  } else if (range.includes('-')) {
    const [left, right] = range.split('-')
    if (left === undefined || right === undefined || range.split('-').length !== 2) return false
    const start = parseNumber(left, spec)
    const end = parseNumber(right, spec)
    if (start === null || end === null || start > end) return false
    from = start
    to = end
  } else {
    const single = parseNumber(range, spec)
    if (single === null) return false
    from = single
    // `a` on its own is one value; `a/n` runs from there to the top of the
    // field, which is how Vixie cron reads it.
    to = step === undefined ? single : spec.max
  }

  for (let value = from; value <= to; value += stride) into.add(value)
  return true
}

function parseField(raw: string, spec: FieldSpec): ParsedField | null {
  const values = new Set<number>()
  const terms = raw.split(',')
  if (terms.some((term) => term.length === 0)) return null

  for (const term of terms) {
    if (!parseTerm(term, spec, values)) return null
  }
  if (values.size === 0) return null

  // Sunday is both 0 and 7 on the wire and exactly 0 once parsed, so a match
  // never has to remember which spelling it was given.
  if (spec.name === 'day of week' && values.delete(7)) values.add(0)

  return { values, restricted: !raw.startsWith('*'), raw }
}

/** The parsed expression, or null if it is not one we can run. */
export function parseCron(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null

  const parsed = fields.map((field, index) => parseField(field, FIELD_SPECS[index]!))
  if (parsed.some((field) => field === null)) return null

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed as Array<ParsedField>
  return {
    minute: minute!,
    hour: hour!,
    dayOfMonth: dayOfMonth!,
    month: month!,
    dayOfWeek: dayOfWeek!,
    expression: fields.join(' '),
  }
}

export function isValidCron(expression: string): boolean {
  return parseCron(expression) !== null
}

/**
 * Whether a schedule is due at a given instant, read in UTC.
 *
 * Seconds and milliseconds are ignored: a cron expression names a minute, and
 * the caller is expected to have aligned its tick to one.
 */
export function matchesCron(expression: string, date: Date): boolean {
  const parsed = parseCron(expression)
  if (!parsed) return false

  if (!parsed.minute.values.has(date.getUTCMinutes())) return false
  if (!parsed.hour.values.has(date.getUTCHours())) return false
  if (!parsed.month.values.has(date.getUTCMonth() + 1)) return false

  const domMatch = parsed.dayOfMonth.values.has(date.getUTCDate())
  const dowMatch = parsed.dayOfWeek.values.has(date.getUTCDay())

  // The POSIX day rule: OR once both fields are restricted, AND otherwise.
  return parsed.dayOfMonth.restricted && parsed.dayOfWeek.restricted
    ? domMatch || dowMatch
    : domMatch && dowMatch
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function ordinal(value: number): string {
  const tens = value % 100
  if (tens >= 11 && tens <= 13) return `${value}th`
  switch (value % 10) {
    case 1:
      return `${value}st`
    case 2:
      return `${value}nd`
    case 3:
      return `${value}rd`
    default:
      return `${value}th`
  }
}

/** A single number, or null when the field is anything more interesting. */
function single(field: ParsedField): number | null {
  return /^\d{1,2}$/.test(field.raw) ? [...field.values][0]! : null
}

/** The `n` of a bare stepped star, or null. */
function everyStep(field: ParsedField): number | null {
  const match = /^\*\/(\d{1,2})$/.exec(field.raw)
  return match ? Number(match[1]) : null
}

function days(field: ParsedField): string | null {
  if (!/^\d(,\d)*$/.test(field.raw)) return null
  const names = [...field.values].sort((a, b) => a - b).map((day) => DAY_NAMES[day]!)
  if (names.length === 1) return `${names[0]}s`
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * A human sentence for a schedule, or the raw expression when the shape is not
 * one of the handful worth naming.
 *
 * Best-effort by design: this feeds a badge, and a badge that occasionally
 * shows a raw expression is better than one that lies about what it means.
 * Every string it produces is UTC, which the caller is expected to say.
 */
export function describeCron(expression: string): string {
  const parsed = parseCron(expression)
  if (!parsed) return expression.trim()

  const { minute, hour, dayOfMonth, month, dayOfWeek } = parsed
  const raw = parsed.expression

  // Anything that only fires in certain months is rare enough not to be worth
  // a phrase of its own.
  if (month.raw !== '*') return raw

  const everyDay = dayOfMonth.raw === '*' && dayOfWeek.raw === '*'

  if (everyDay && hour.raw === '*') {
    if (minute.raw === '*') return 'Every minute'
    const step = everyStep(minute)
    if (step !== null) return `Every ${step} minutes`
    const at = single(minute)
    if (at !== null) return `Hourly at :${pad(at)}`
    return raw
  }

  const at = single(minute)
  if (at === null) return raw

  const hourStep = everyStep(hour)
  if (everyDay && hourStep !== null) return `Every ${hourStep} hours at :${pad(at)}`

  const onHour = single(hour)
  if (onHour === null) return raw
  const time = `${pad(onHour)}:${pad(at)}`

  if (everyDay) return `Daily at ${time}`

  if (dayOfMonth.raw === '*') {
    const named = days(dayOfWeek)
    return named === null ? raw : `${named} at ${time}`
  }

  if (dayOfWeek.raw === '*') {
    const day = single(dayOfMonth)
    return day === null ? raw : `Monthly on the ${ordinal(day)} at ${time}`
  }

  return raw
}
