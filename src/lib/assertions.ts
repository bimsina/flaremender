/** A conservative authoring hint, not proof that an assertion executes or covers the brief. */
export function hasSupportedAssertions(code: string): boolean {
  // Ignore commented examples and string contents, including quoted URLs.
  const source = code.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    ' ',
  )
  return /\bexpect(?:\s*\.\s*(?:soft|poll))?\s*\([\s\S]*?\)\s*\.(?:\s*(?:not|resolves|rejects)\s*\.)?\s*to(?:Be|Have|Contain|Match|Equal|Throw|Pass)[A-Za-z]*\s*\(/.test(
    source,
  )
}
