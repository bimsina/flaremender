/**
 * Secret redaction.
 *
 * Environment-variable values reach the script in plaintext, so anything the
 * script echoes — a log line, an assertion message, a Playwright error quoting
 * the value it just typed — can carry one back out. Every string that is about
 * to be persisted, returned or logged goes through here first.
 *
 * Three encodings are covered because those are the three a value realistically
 * survives in: raw, percent-encoded (it ended up in a URL) and base64 (it ended
 * up in a header). Screenshots and traces are *not* covered — they can show a
 * secret visually, which is a documented caveat rather than something a string
 * replace can fix.
 */

export const REDACTED = '***'

/** Shortest value worth hiding: below this the noise would swamp the text. */
const MIN_LENGTH = 4

function base64(value: string): string | null {
  try {
    const bytes = new TextEncoder().encode(value)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  } catch {
    return null
  }
}

/**
 * Every spelling of every secret, longest first — so a value that contains
 * another value is replaced whole rather than leaving a fragment behind.
 */
export function scrubPatterns(values: Iterable<string>): Array<string> {
  const patterns = new Set<string>()

  for (const value of values) {
    if (typeof value !== 'string' || value.length < MIN_LENGTH) continue

    patterns.add(value)

    const encoded = encodeURIComponent(value)
    if (encoded !== value) patterns.add(encoded)

    const encoded64 = base64(value)
    if (encoded64) patterns.add(encoded64)
  }

  return [...patterns].sort((a, b) => b.length - a.length)
}

/** Replaces every occurrence of every pattern. Cheap enough to call per line. */
export function scrubWith(text: string, patterns: Array<string>): string {
  let output = text
  for (const pattern of patterns) {
    if (output.includes(pattern)) output = output.replaceAll(pattern, REDACTED)
  }
  return output
}

/** Convenience for one-off strings. */
export function scrub(text: string, values: Iterable<string>): string {
  return scrubWith(text, scrubPatterns(values))
}

/**
 * A reusable scrubber. Built once per run and threaded through the places that
 * write text, so the pattern list is computed a single time.
 */
export function createScrubber(values: Iterable<string>) {
  const patterns = scrubPatterns(values)

  return {
    text: (value: string) => scrubWith(value, patterns),
    /** Null passes through, so `errorMessage` can stay nullable end to end. */
    nullable: (value: string | null) => (value === null ? null : scrubWith(value, patterns)),
    lines: (values_: Array<string>) => values_.map((line) => scrubWith(line, patterns)),
  }
}

export type Scrubber = ReturnType<typeof createScrubber>
