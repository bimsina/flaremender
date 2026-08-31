export function hasSupportedAssertions(code: string): boolean {
  const source = code.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    ' ',
  )
  return /\bexpect(?:\s*\.\s*(?:soft|poll))?\s*\([\s\S]*?\)\s*\.(?:\s*(?:not|resolves|rejects)\s*\.)?\s*to(?:Be|Have|Contain|Match|Equal|Throw|Pass)[A-Za-z]*\s*\(/.test(
    source,
  )
}
