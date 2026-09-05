/**
 * Custom spans for Workers traces. Wrapping a call in `span` makes it show up as a
 * named child of whatever the runtime is already tracing (the request, the
 * Workflow step, the binding calls underneath), with the attributes attached.
 *
 * Tracing has to be on in `wrangler.jsonc` for spans to be recorded; when it is
 * not, or on a runtime without the API, this is a plain function call.
 */
import { tracing } from 'cloudflare:workers'

export type SpanAttributes = Record<string, boolean | number | string | null | undefined>

function clean(attributes: SpanAttributes): Record<string, boolean | number | string> {
  const out: Record<string, boolean | number | string> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) out[key] = value
  }
  return out
}

/**
 * Run `fn` inside a span called `name`. Attributes given up front land on the span
 * immediately; `fn` gets a setter for the ones only known afterwards (an outcome, a
 * token count). A thrown error marks the span and is rethrown.
 */
export async function span<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (set: (more: SpanAttributes) => void) => Promise<T>,
): Promise<T> {
  const enter = tracing?.enterSpan
  if (typeof enter !== 'function') return fn(() => {})

  return tracing.enterSpan(name, async (current) => {
    current.setAttributes(clean(attributes))
    try {
      return await fn((more) => current.setAttributes(clean(more)))
    } catch (error) {
      current.setAttributes({
        error: true,
        'error.message': error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  })
}
