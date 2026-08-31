/** String redaction cannot remove credentials visible in screenshots or trace artifacts. */

export const REDACTED = '***'

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

/** Replace longer secrets first so overlapping values do not leave fragments behind. */
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

export function scrubWith(text: string, patterns: Array<string>): string {
  let output = text
  for (const pattern of patterns) {
    if (output.includes(pattern)) output = output.replaceAll(pattern, REDACTED)
  }
  return output
}

export function scrub(text: string, values: Iterable<string>): string {
  return scrubWith(text, scrubPatterns(values))
}

export function createScrubber(values: Iterable<string>) {
  const patterns = scrubPatterns(values)

  return {
    text: (value: string) => scrubWith(value, patterns),
    nullable: (value: string | null) => (value === null ? null : scrubWith(value, patterns)),
    lines: (values_: Array<string>) => values_.map((line) => scrubWith(line, patterns)),
  }
}

export type Scrubber = ReturnType<typeof createScrubber>
