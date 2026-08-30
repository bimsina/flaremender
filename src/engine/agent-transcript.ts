/**
 * Keeping an agent's transcript from becoming mostly stale page trees.
 *
 * Both loops in this engine — the one that writes a script and the one that
 * explores an app — hand the model a fresh accessibility tree with every tool
 * result. Each is ten kilobytes, each was decisive when it arrived, and each is
 * noise two turns later, because they all describe a *present* that has moved
 * on. The model needs the page as it is now; the newest copy is always the one
 * immediately above it.
 *
 * So older copies are replaced by a line saying where to get another. Crucially
 * this happens in the **in-memory** copy only: what the workflow stored is
 * untouched, so a replayed instance rebuilds exactly the same messages from
 * exactly the same stored deltas.
 */
import type { ModelMessage } from 'ai'

/** Anything shorter than this is too small to be worth pruning. */
const PRUNE_THRESHOLD = 400

export interface PruneOptions {
  /** How many of the most recent tool results keep their fields in full. */
  keep: number
  /** Field name → what to say instead, once it is old enough to drop. */
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

  // Newest first, so the most recent results are the ones kept.
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
