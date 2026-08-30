/**
 * Turning fragments into a script.
 *
 * The model never writes a file. It writes *statements* — two or three lines
 * that do one thing and check it worked — and each of those is executed against
 * the live page before it is allowed to become part of anything. This module is
 * the only place that knows how a fragment becomes runnable code, and it is
 * deliberately the same knowledge in both directions:
 *
 * - `wrapFragment` builds the throwaway module one candidate fragment runs as;
 * - `assembleScript` builds the file the verified fragments are saved as.
 *
 * Because both wrap the same body in the same `{ page, expect, secret }`
 * signature, a fragment that worked during generation is a fragment that works
 * in the saved script. If these two ever disagreed, generation would be
 * verifying something other than what it saves.
 */
import { DEFAULT_SCRIPT_TEMPLATE } from '#/lib/script-template.ts'

const OPEN = 'export default async function ({ page, expect, secret }) {'
const CLOSE = '}'
const INDENT = '  '

/**
 * Re-indents a fragment to sit inside the wrapper.
 *
 * Models indent inconsistently — sometimes for the enclosing function they
 * cannot see, sometimes not at all — so whatever common indentation a fragment
 * arrived with is stripped and one level is added back. Blank lines stay blank
 * rather than becoming trailing whitespace.
 */
function reindent(fragment: string): Array<string> {
  const lines = fragment.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n')

  const common = lines
    .filter((line) => line.trim().length > 0)
    .reduce((least, line) => Math.min(least, line.length - line.trimStart().length), Infinity)

  const strip = Number.isFinite(common) ? common : 0

  return (
    lines
      .map((line) => (line.trim().length === 0 ? '' : `${INDENT}${line.slice(strip)}`))
      // A fragment that opens with blank lines would push the wrapper apart.
      .filter((line, index, all) => !(line === '' && (index === 0 || index === all.length - 1)))
  )
}

/** The module one candidate fragment executes as. */
export function wrapFragment(fragment: string): string {
  return `${OPEN}\n${reindent(fragment).join('\n')}\n${CLOSE}\n`
}

/**
 * The finished script.
 *
 * Fragments are separated by a blank line, which is the only formatting
 * decision made here: they arrived as coherent little groups of statements and
 * reading them back as paragraphs is how the person who inherits this file will
 * see the flow the model built.
 */
export function assembleScript(fragments: Array<string>): string {
  const bodies = fragments
    .map((fragment) => reindent(fragment).join('\n'))
    .filter((body) => body.trim().length > 0)

  if (bodies.length === 0) return DEFAULT_SCRIPT_TEMPLATE

  return `${OPEN}\n${bodies.join('\n\n')}\n${CLOSE}\n`
}

/**
 * The statements of a fragment, flattened and normalised.
 *
 * For comparison and for showing the model what it has already done — never for
 * generating code, which is why collapsing whitespace and dropping the
 * separators is safe here and would not be anywhere else.
 */
export function statementsOf(fragment: string): Array<string> {
  return fragment
    .split(/[\n;]+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
}

/**
 * Whether a script checks anything at all.
 *
 * The one property verification cannot establish on its own, and the reason it
 * has to be asked here. A run proves that a script did not throw — so a script
 * that navigates, signs in and stops passes, and goes on passing for ever, no
 * matter what the site does. It is the most dangerous thing generation can
 * produce, because every signal around it says green.
 *
 * Crude by design: whether the assertions are *good* is a judgement, and this is
 * only the floor beneath it.
 */
export function hasAssertions(code: string): boolean {
  return /\bexpect\s*\(/.test(code)
}

/**
 * Catches the one failure mode the prompt cannot reliably talk a model out of:
 * resending the whole flow every turn instead of the next step of it.
 *
 * It is a *plausible* mistake rather than a stupid one — a model that cannot
 * see the file being assembled hedges by restating everything — and it costs
 * nothing at execution time, because replaying a sign-in against a browser that
 * is already signed in usually still passes. So it survives all the way into
 * the saved script, where it reads as six navigations and three sign-ins for a
 * flow that needed one of each.
 *
 * Detected on statements rather than on text, so reformatting does not evade
 * it, and deliberately tolerant of a single repeat: going back to a page that
 * has already been visited is a real thing a test does. Two or more repeats
 * that make up most of the fragment is not.
 */
export function detectReplay(fragment: string, verified: Array<string>): string | null {
  const already = verified.flatMap(statementsOf)
  if (already.length === 0) return null

  const seen = new Set(already)
  const statements = statementsOf(fragment)

  const repeats = statements.filter((statement) => seen.has(statement))
  if (repeats.length < 2) return null
  if (repeats.length < statements.length - 1 && repeats.length < 3) return null

  return `${repeats.length} of those ${statements.length} statements are already in the script and have already run — the browser is still in the state they left it in, so running them again is at best wasted and at worst starts the flow over. Send only what comes next. The script already contains:\n${already
    .map((statement, index) => `${index + 1}. ${statement}`)
    .join('\n')}`
}

/**
 * Rejects a fragment before it costs a browser round trip.
 *
 * Only the two shapes that cannot possibly work are refused: a module wrapper
 * (the model was asked for statements and wrote a file) and imports (the
 * harness supplies everything, and an import inside a function body is a syntax
 * error). Everything else — including code that will throw — is the browser's
 * business to find out, which is the point of running it.
 *
 * Returns the complaint to send back to the model, or null when the fragment is
 * worth executing.
 */
export function rejectFragment(fragment: string, maxLength: number): string | null {
  const trimmed = fragment.trim()

  if (trimmed.length === 0) return 'The fragment was empty.'
  if (trimmed.length > maxLength) {
    return `That fragment is ${trimmed.length} characters; keep each one under ${maxLength}. Split it into smaller steps.`
  }
  if (/^\s*import\s/m.test(trimmed)) {
    return 'Do not write imports — `page`, `expect` and `secret` are already in scope. Send only the statements.'
  }
  if (/export\s+default/.test(trimmed)) {
    return 'Do not write the function wrapper — send only the statements that go inside it.'
  }

  return null
}
