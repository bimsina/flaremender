/**
 * Splitting a saved script back into the statements it was assembled from, so a
 * repair can replay them one at a time and keep only the ones that still pass.
 */
const OPEN = /^\s*export\s+default\s+async\s+function\s*\([^)]*\)\s*\{\s*$/
const CLOSE = /^\s*\}\s*$/

/** The lines between the function's braces, or the whole text if it is not wrapped. */
export function bodyOf(code: string): string {
  const lines = code.replace(/\r\n?/g, '\n').split('\n')
  const first = lines.findIndex((line) => OPEN.test(line))
  if (first === -1) return code

  let last = lines.length - 1
  while (last > first && !CLOSE.test(lines[last]!)) last -= 1
  return lines.slice(first + 1, last).join('\n')
}

function depthDelta(line: string): number {
  // Strings and comments are stripped first so a bracket inside a locator name does not count.
  const bare = line.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    '',
  )
  let depth = 0
  for (const char of bare) {
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
  }
  return depth
}

/**
 * One statement per entry. A statement spans several lines when its brackets are
 * still open at a line break or the line ends in a `.` or `,`; comments and blank
 * lines are dropped. Indentation is removed so the pieces can be re-wrapped.
 */
export function splitStatements(code: string): Array<string> {
  const statements: Array<string> = []
  let current: Array<string> = []
  let depth = 0

  const lines = bodyOf(code).split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line.length === 0 && current.length === 0) continue
    if (line.startsWith('//') && current.length === 0) continue

    current.push(line)
    depth += depthDelta(line)

    // A chained call split across lines starts the next line with a dot.
    const nextStartsChain = lines[index + 1]?.trim().startsWith('.') ?? false
    const continues = depth > 0 || /[.,]$/.test(line) || nextStartsChain
    if (!continues) {
      statements.push(current.join('\n'))
      current = []
      depth = 0
    }
  }

  if (current.length > 0) statements.push(current.join('\n'))
  return statements
}
