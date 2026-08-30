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
 * Ways of touching the page that a real user has no access to.
 *
 * Each of these makes a fragment *more* likely to be kept and *less* likely to
 * survive, which is the worst possible combination for a loop whose whole
 * premise is "keep only what worked":
 *
 * - `dispatchEvent('click')` fires the event straight at the node, skipping
 *   Playwright's actionability checks — visible, stable, enabled, unobscured.
 *   So it succeeds against a button that is covered, disabled or on a page the
 *   flow has already left, the fragment is appended, and the honest `.click()`
 *   in the replayed script then times out on exactly that element.
 * - `evaluate` does the same thing with more room: `el => el.click()` inside
 *   the page bypasses every check there is.
 * - `force: true` is the option that says "skip the checks" out loud.
 *
 * The important part is not that these are unusual — it is that a failure to
 * click is *information*. An element a user could not interact with means the
 * flow is on the wrong page or in the wrong state, and the right response is to
 * look, not to reach past the check and carry on building on a lie.
 *
 * Read-only uses of `evaluate` are collateral damage. They are rare in an
 * end-to-end test, a locator assertion says the same thing better, and the
 * refusal explains itself — which is much cheaper than the class of silent
 * failure it prevents.
 */
const UNSAFE_INTERACTIONS: Array<{ pattern: RegExp; complaint: string }> = [
  {
    pattern: /\.dispatchEvent\s*\(/,
    complaint:
      '`dispatchEvent` fires the event directly at the element and skips every actionability check, so it can "work" here against something a real user could not click — and the plain `.click()` in the saved script will then time out on it. Use `.click()`, `.fill()`, `.check()` and friends.',
  },
  {
    pattern: /\.evaluate(?:Handle)?\s*\(/,
    complaint:
      'Do not drive the page through `evaluate` — code running inside the page bypasses the actionability checks that make a test meaningful. Interact through locators (`.click()`, `.fill()`, `.selectOption()`) and assert through `expect(locator)`.',
  },
  {
    pattern: /force\s*:\s*true/,
    complaint:
      '`force: true` disables the actionability checks. If an element needs forcing, a real user could not have used it, and the test would not have caught the bug you are writing it for.',
  },
  {
    pattern: /^\s*(if|try)\s*[({]/m,
    complaint:
      'No `if` or `try` in a test. Branching on what happens to be on the page means the test passes either way, which is the same as not testing it — and it is a sign you are unsure where the flow is rather than a property of the flow. Find out with `observe`, then write the step for the page that is actually there.',
  },
]

/**
 * Refuses the shortcuts that make a fragment pass here and fail on replay.
 *
 * Separate from `rejectFragment` because the reasoning is different: those are
 * fragments that cannot run at all, these are fragments that run *too easily*.
 */
export function rejectUnsafeInteraction(fragment: string): string | null {
  for (const { pattern, complaint } of UNSAFE_INTERACTIONS) {
    if (pattern.test(fragment)) {
      return `${complaint}\n\nIf the element genuinely will not respond to an ordinary click, that is the page telling you something: you are probably not where you think you are. Observe, work out which page the flow is actually on, and act from there.`
    }
  }

  return null
}

/** `page.goto('…')` / `page.reload()` / `page.goBack()` and friends. */
const NAVIGATION = /\bpage\s*\.\s*(goto|reload|goBack|goForward)\s*\(/
const GOTO_TARGET = /\bpage\s*\.\s*goto\s*\(\s*['"`]([^'"`]*)['"`]/g

/**
 * Stops the loop from browsing around inside the script it is writing.
 *
 * The asymmetry that causes this is real and worth naming: `observe` cannot
 * move the page, so the *only* way for the model to go and look at somewhere
 * else is `act` — and every successful `act` is appended for ever. A model that
 * is unsure where the cart is will therefore go and find out, and the finished
 * script carries its entire search: `/` → `/inventory.html` → `/cart.html` →
 * `/inventory.html`, none of which a user would ever do, all of which passed
 * when they ran, and which together leave the flow somewhere the next fragment
 * was not written for.
 *
 * So a fragment that *only* navigates is held to a much stricter rule than one
 * that does something: it may go somewhere new, but it may not go back
 * anywhere, and it may not reload. A test gets in through one navigation and
 * then moves the way a person does — by clicking the thing that takes them
 * there. That is also a better test, because the navigation itself is part of
 * what the flow is supposed to prove.
 *
 * Fragments that navigate *and* then do or check something are left alone: that
 * is a coherent step, not a search.
 */
export function detectNavigationChurn(fragment: string, verified: Array<string>): string | null {
  const statements = statementsOf(fragment)
  if (statements.length === 0) return null

  // Only pure movement is suspect. A navigation that comes with work attached
  // is the model going somewhere on purpose.
  if (!statements.every((statement) => NAVIGATION.test(statement))) return null

  if (/\bpage\s*\.\s*(reload|goBack|goForward)\s*\(/.test(fragment)) {
    return 'Do not reload or go back to get your bearings — it throws away the state the flow has built up, and it lands in the saved script as a step no user would take. If you need to see where you are, `observe`. If the flow genuinely needs to be somewhere else, click the link that takes a person there.'
  }

  const visited = new Set(
    verified.flatMap((entry) => [...entry.matchAll(GOTO_TARGET)].map((match) => match[1])),
  )

  const revisits = [...fragment.matchAll(GOTO_TARGET)]
    .map((match) => match[1])
    .filter((target) => visited.has(target!))

  if (revisits.length === 0) return null

  return `The script has already navigated to ${revisits
    .map((target) => `\`${target}\``)
    .join(
      ', ',
    )}, so going back there is not a step in the journey — it is the flow starting over, and it will leave the browser somewhere the steps after it are not written for. Move the way a user would: click the link or button that goes there. Use \`observe\` if you only want to see where you are.`
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
