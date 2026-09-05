import type { UserContent } from 'ai'

import type { KnowledgeImage } from '#/engine/knowledge.ts'

/**
 * The first user message of an agent conversation: the task, plus any uploaded
 * pictures as image parts. A plain string when there are none, which keeps
 * transcripts small and works for every model. Kept to JSON-safe shapes so it can
 * cross a Workflow step boundary.
 */
export type OpeningContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }>

export function openingContent(prompt: string, images: Array<KnowledgeImage>): OpeningContent {
  if (images.length === 0) return prompt
  return [
    { type: 'text', text: prompt },
    ...images.map((image) => ({
      type: 'image' as const,
      image: image.base64,
      mediaType: image.mediaType,
    })),
  ]
}

/** The AI SDK accepts base64 strings for image parts, so the shapes line up. */
export function asUserContent(content: OpeningContent): UserContent {
  return content as UserContent
}
