/**
 * Live model lists, read from each provider's own catalog.
 *
 * Nothing here is a hard-coded list of models: a provider ships a new one and
 * an admin can allowlist it the same day. A provider with no credentials is not
 * an error — it reports `available: false` with a reason, because "you have not
 * given us a key" is a normal state for an instance that only uses one vendor.
 *
 * Results are cached per isolate for half an hour. Catalogs move on the scale
 * of weeks and an admin opening the settings page repeatedly should not spend a
 * round trip per keystroke; `force` is the escape hatch when they know better.
 */
import { env } from 'cloudflare:workers'
import { createServerFn } from '@tanstack/react-start'

import type { Db } from '#/db/index.ts'
import {
  PROVIDERS,
  PROVIDER_LABELS,
  type Provider,
  WORKERS_AI_FALLBACK_MODELS,
} from '#/lib/models.ts'
import { adminMiddleware } from './auth.ts'
import { resolveProviderKey } from './providers.ts'
import { bool, oneOf } from './validate.ts'

export interface ProviderModel {
  /** The provider's own id, e.g. `claude-sonnet-4-5` or `@cf/meta/llama-3.3…`. */
  slug: string
  displayName: string
}

export type ProviderCatalog =
  | {
      available: true
      models: Array<ProviderModel>
      /** True when the live call failed and a built-in list stood in. */
      fallback: boolean
      fetchedAt: number
    }
  | { available: false; reason: string }

const CACHE_TTL_MS = 30 * 60 * 1000

/** Per isolate, so a cold start re-reads and a warm page does not. */
const cache = new Map<Provider, { expiresAt: number; catalog: ProviderCatalog }>()

/** Every catalog paginates; a cap keeps a misbehaving one from spinning forever. */
const MAX_PAGES = 20

async function readJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers })

  if (!response.ok) {
    // The body can carry the provider's own complaint (bad key, quota), which
    // is far more useful to an operator than the status code alone.
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new Error(`${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`)
  }

  return response.json()
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? (value.filter((item) => typeof item === 'object' && item !== null) as Array<
        Record<string, unknown>
      >)
    : []
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** `GET /v1/models`, `after_id` paginated, newest first as the API returns them. */
async function fetchAnthropicModels(key: string): Promise<Array<ProviderModel>> {
  const models: Array<ProviderModel> = []
  let afterId: string | null = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://api.anthropic.com/v1/models')
    url.searchParams.set('limit', '100')
    if (afterId) url.searchParams.set('after_id', afterId)

    const body = (await readJson(url.toString(), {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    })) as { data?: unknown; has_more?: unknown; last_id?: unknown }

    for (const row of asArray(body.data)) {
      const slug = text(row.id)
      if (slug) models.push({ slug, displayName: text(row.display_name) ?? slug })
    }

    if (body.has_more !== true) break
    afterId = text(body.last_id)
    if (!afterId) break
  }

  return models
}

/** `GET v1beta/models`, `pageToken` paginated; ids arrive as `models/<slug>`. */
async function fetchGoogleModels(key: string): Promise<Array<ProviderModel>> {
  const models: Array<ProviderModel> = []
  let pageToken: string | null = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models')
    url.searchParams.set('pageSize', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const body = (await readJson(url.toString(), { 'x-goog-api-key': key })) as {
      models?: unknown
      nextPageToken?: unknown
    }

    for (const row of asArray(body.models)) {
      // Embedding and image models live in the same list; only the ones that
      // can answer a prompt belong in a catalog of text generators.
      const methods = Array.isArray(row.supportedGenerationMethods)
        ? row.supportedGenerationMethods
        : []
      if (!methods.includes('generateContent')) continue

      const name = text(row.name)
      if (!name) continue

      const slug = name.startsWith('models/') ? name.slice('models/'.length) : name
      models.push({ slug, displayName: text(row.displayName) ?? slug })
    }

    pageToken = text(body.nextPageToken)
    if (!pageToken) break
  }

  return models
}

/**
 * `GET /v1/models` returns every model on the account, including ones that
 * cannot hold a conversation. There is no "kind" field to filter on, so the
 * names are all there is to go by.
 */
const OPENAI_EXCLUDED = [
  'embedding',
  'whisper',
  'tts',
  'dall-e',
  'moderation',
  'realtime',
  'audio',
  'image',
]

async function fetchOpenAiModels(key: string): Promise<Array<ProviderModel>> {
  const body = (await readJson('https://api.openai.com/v1/models', {
    Authorization: `Bearer ${key}`,
  })) as { data?: unknown }

  const models: Array<ProviderModel> = []
  for (const row of asArray(body.data)) {
    const slug = text(row.id)
    if (!slug) continue

    const lower = slug.toLowerCase()
    if (OPENAI_EXCLUDED.some((word) => lower.includes(word))) continue

    models.push({ slug, displayName: slug })
  }

  return models
}

/**
 * The `AI` binding's own catalog. Two traps: `id` is a UUID and `name` is the
 * `@cf/...` slug the SDK actually takes, and the list covers every task the
 * platform runs — speech, embeddings, classifiers — so `task.name` is what
 * separates a model that can answer a prompt from one that cannot.
 */
async function fetchWorkersAiModels(): Promise<Array<ProviderModel>> {
  const rows = await env.AI.models({ per_page: 100 })

  return rows
    .filter((row) => row.task?.name?.toLowerCase() === 'text generation')
    .map((row) => ({ slug: row.name, displayName: workersAiDisplayName(row.name) }))
}

/** `@cf/meta/llama-3.3-70b` reads as `llama-3.3-70b`; the full slug is shown beside it. */
function workersAiDisplayName(slug: string): string {
  return slug.slice(slug.lastIndexOf('/') + 1) || slug
}

const workersAiFallback = (): Array<ProviderModel> =>
  WORKERS_AI_FALLBACK_MODELS.map((slug) => ({
    slug,
    displayName: workersAiDisplayName(slug),
  }))

async function loadCatalog(db: Db, provider: Provider): Promise<ProviderCatalog> {
  const fetchedAt = Date.now()

  if (provider === 'workers-ai') {
    try {
      const models = await fetchWorkersAiModels()
      // An empty live list is indistinguishable from a broken one to an admin
      // staring at a picker, so treat it the same way.
      if (models.length > 0) return { available: true, models, fallback: false, fetchedAt }
    } catch {
      // Falls through: Workers AI is the floor of the resolution chain and must
      // stay pickable even when its catalog endpoint is unreachable.
    }

    return { available: true, models: workersAiFallback(), fallback: true, fetchedAt }
  }

  const resolved = await resolveProviderKey(db, provider)
  if (resolved.source === 'none' || !resolved.key) {
    return {
      available: false,
      reason: `No ${PROVIDER_LABELS[provider]} key on this instance. Add one to list its models.`,
    }
  }

  const models =
    provider === 'anthropic'
      ? await fetchAnthropicModels(resolved.key)
      : provider === 'google'
        ? await fetchGoogleModels(resolved.key)
        : await fetchOpenAiModels(resolved.key)

  models.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return { available: true, models, fallback: false, fetchedAt }
}

export const listProviderModels = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator((data: unknown) => ({
    provider: oneOf(data, 'provider', PROVIDERS),
    force:
      (data as Record<string, unknown> | null)?.force === undefined ? false : bool(data, 'force'),
  }))
  .handler(async ({ data, context }): Promise<ProviderCatalog> => {
    const cached = cache.get(data.provider)
    if (!data.force && cached && cached.expiresAt > Date.now()) return cached.catalog

    try {
      const catalog = await loadCatalog(context.db, data.provider)
      cache.set(data.provider, { expiresAt: Date.now() + CACHE_TTL_MS, catalog })
      return catalog
    } catch (error) {
      // A provider that answered with an error is *not* cached: the next click
      // should retry rather than sit on a failure for half an hour.
      return {
        available: false,
        reason: `Could not read the ${PROVIDER_LABELS[data.provider]} catalog: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
  })
