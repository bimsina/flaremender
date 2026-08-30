/**
 * Model identity, shared by client and server.
 *
 * A model id is `"{provider}:{slug}"` — the provider picks the SDK, the slug is
 * passed through untouched so new models work without a code change. Nothing
 * here may import secrets or server-only modules: the admin UI and the project
 * settings picker both read from this file.
 */
export const PROVIDERS = ['workers-ai', 'anthropic', 'openai', 'google'] as const
export type Provider = (typeof PROVIDERS)[number]

export const PROVIDER_LABELS: Record<Provider, string> = {
  'workers-ai': 'Workers AI',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
}

/**
 * The Worker secret each provider reads. A key bound here always wins over one
 * saved in the admin console, so the name is part of the UI's vocabulary — it
 * is what an operator has to remove before the console will manage that key.
 * Workers AI has none: it is reached through the `AI` binding.
 */
export const PROVIDER_SECRET_VARS = {
  'workers-ai': null,
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
} as const satisfies Record<Provider, string | null>

export interface ParsedModelId {
  provider: Provider
  slug: string
}

function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value)
}

/** Returns null rather than throwing: stored ids can outlive a provider list. */
export function parseModelId(modelId: string): ParsedModelId | null {
  const separator = modelId.indexOf(':')
  if (separator <= 0) return null

  const provider = modelId.slice(0, separator)
  const slug = modelId.slice(separator + 1).trim()
  if (!slug || !isProvider(provider)) return null

  return { provider, slug }
}

export function formatModelId(provider: Provider, slug: string): string {
  return `${provider}:${slug.trim()}`
}

/**
 * Shown when `env.AI.models()` is unreachable — an admin can still pick a model
 * on a fresh instance. The live catalog always wins when it loads.
 */
export const WORKERS_AI_FALLBACK_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/openai/gpt-oss-120b',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
] as const

/** Needs no credentials, so it is the floor of the resolution chain. */
export const DEFAULT_MODEL_ID = 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast'
