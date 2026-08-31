import { hasSupportedAssertions } from '#/lib/assertions.ts'
import { DEFAULT_SCRIPT_TEMPLATE } from '#/lib/script-template.ts'

const OPEN = 'export default async function ({ page, expect, secret }) {'
const CLOSE = '}'
const INDENT = '  '

function reindent(fragment: string): Array<string> {
  const lines = fragment.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n')

  const common = lines
    .filter((line) => line.trim().length > 0)
    .reduce((least, line) => Math.min(least, line.length - line.trimStart().length), Infinity)

  const strip = Number.isFinite(common) ? common : 0

  return lines
    .map((line) => (line.trim().length === 0 ? '' : `${INDENT}${line.slice(strip)}`))
    .filter((line, index, all) => !(line === '' && (index === 0 || index === all.length - 1)))
}

export function wrapFragment(fragment: string): string {
  return `${OPEN}\n${reindent(fragment).join('\n')}\n${CLOSE}\n`
}

export function assembleScript(fragments: Array<string>): string {
  const bodies = fragments
    .map((fragment) => reindent(fragment).join('\n'))
    .filter((body) => body.trim().length > 0)

  if (bodies.length === 0) return DEFAULT_SCRIPT_TEMPLATE

  return `${OPEN}\n${bodies.join('\n\n')}\n${CLOSE}\n`
}

export function statementsOf(fragment: string): Array<string> {
  return fragment
    .split(/[\n;]+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
}

export function hasAssertions(code: string): boolean {
  return hasSupportedAssertions(code)
}

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

export function rejectUnsafeInteraction(fragment: string): string | null {
  for (const { pattern, complaint } of UNSAFE_INTERACTIONS) {
    if (pattern.test(fragment)) {
      return `${complaint}\n\nIf the element genuinely will not respond to an ordinary click, that is the page telling you something: you are probably not where you think you are. Observe, work out which page the flow is actually on, and act from there.`
    }
  }

  return null
}

const NAVIGATION = /\bpage\s*\.\s*(goto|reload|goBack|goForward)\s*\(/
const GOTO_TARGET = /\bpage\s*\.\s*goto\s*\(\s*['"`]([^'"`]*)['"`]/g

export function detectNavigationChurn(fragment: string, verified: Array<string>): string | null {
  const statements = statementsOf(fragment)
  if (statements.length === 0) return null

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
