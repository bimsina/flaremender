const MAX_BYTES = 200_000

const MAX_CHARS = 20_000

const SUSPICIOUSLY_SHORT = 200

const DROPPED = /<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi

const BREAKS = /<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|nav|ul|ol|table)\b[^>]*>/gi

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

export interface DocsResult {
  url: string
  title: string | null
  text: string
  truncated: boolean
  errorMessage: string | null
}

export function htmlToText(html: string): string {
  const withoutDropped = html.replace(DROPPED, ' ')

  const withBreaks = withoutDropped.replace(BREAKS, '\n')

  const withoutTags = withBreaks.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')

  const decoded = withoutTags
    .replace(/&[a-z]+;|&#\d+;/gi, (entity) => {
      const known = ENTITIES[entity.toLowerCase()]
      if (known !== undefined) return known
      const code = /^&#(\d+);$/.exec(entity)
      return code ? String.fromCodePoint(Number(code[1])) : ' '
    })
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')

  return decoded.trim()
}

function titleOf(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match ? htmlToText(match[1]!).slice(0, 200) || null : null
}

async function readCapped(response: Response): Promise<{ text: string; truncated: boolean }> {
  const body = response.body
  if (!body) return { text: await response.text(), truncated: false }

  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  let truncated = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      chunks.push(value)
      size += value.byteLength

      if (size >= MAX_BYTES) {
        truncated = true
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }

  return { text: new TextDecoder().decode(joined), truncated }
}

export async function fetchDocs(rawUrl: string): Promise<DocsResult> {
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`)
  } catch {
    return { url: rawUrl, title: null, text: '', truncated: false, errorMessage: 'Not a URL.' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      url: url.toString(),
      title: null,
      text: '',
      truncated: false,
      errorMessage: 'Only http and https URLs can be read.',
    }
  }

  try {
    const response = await fetch(url, {
      headers: { accept: 'text/html,text/plain,text/markdown;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
    })

    if (!response.ok) {
      return {
        url: url.toString(),
        title: null,
        text: '',
        truncated: false,
        errorMessage: `The page returned ${response.status}.`,
      }
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!/text\/|json|xml|markdown/i.test(contentType)) {
      return {
        url: url.toString(),
        title: null,
        text: '',
        truncated: false,
        errorMessage: `That URL is ${contentType.split(';')[0] || 'not text'}, so there is nothing to read.`,
      }
    }

    const { text: raw, truncated: capped } = await readCapped(response)
    const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw)
    const text = isHtml ? htmlToText(raw) : raw.trim()

    if (isHtml && text.length < SUSPICIOUSLY_SHORT) {
      return {
        url: url.toString(),
        title: titleOf(raw),
        text,
        truncated: false,
        errorMessage:
          'That page has almost no text in its HTML, which usually means it renders its content with JavaScript. You have a real browser — `navigate` to it and `observe` instead.',
      }
    }

    return {
      url: url.toString(),
      title: isHtml ? titleOf(raw) : null,
      text: text.slice(0, MAX_CHARS),
      truncated: capped || text.length > MAX_CHARS,
      errorMessage: null,
    }
  } catch (error) {
    return {
      url: url.toString(),
      title: null,
      text: '',
      truncated: false,
      errorMessage: `That page could not be fetched: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}
