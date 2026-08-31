import type { ModelMessage } from 'ai'

const PRUNE_THRESHOLD = 400

export interface PruneOptions {
  keep: number
  replacements: Record<string, string>
}

export function pruneToolResults(
  messages: Array<ModelMessage>,
  options: PruneOptions,
): Array<ModelMessage> {
  let remaining = options.keep

  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(prune)
    if (typeof value !== 'object' || value === null) return value

    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const replacement = options.replacements[key]
      if (replacement && typeof item === 'string' && item.length > PRUNE_THRESHOLD) {
        return [key, replacement] as const
      }
      return [key, prune(item)] as const
    })

    return Object.fromEntries(entries)
  }

  const reversed = [...messages].reverse().map((message) => {
    if (message.role !== 'tool') return message
    if (remaining > 0) {
      remaining -= 1
      return message
    }
    return { ...message, content: prune(message.content) } as ModelMessage
  })

  return reversed.reverse()
}
