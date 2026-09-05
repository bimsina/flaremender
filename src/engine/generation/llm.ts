import { env } from 'cloudflare:workers'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel, generateText } from 'ai'
import { eq } from 'drizzle-orm'
import { createWorkersAI } from 'workers-ai-provider'
import { anthropic as anthropicPlugin } from 'workers-ai-provider/anthropic'
import { openai as openaiPlugin } from 'workers-ai-provider/openai'

import type { Db } from '#/db/index.ts'
import { instanceSettings, organizationSettings } from '#/db/schema/app.ts'
import {
  DEFAULT_MODEL_ID,
  PROVIDER_LABELS,
  PROVIDER_SECRET_VARS,
  type Provider,
  parseModelId,
} from '#/lib/models.ts'
import { resolveProviderKey } from '#/server/providers.ts'

export type ModelOrigin = 'project' | 'instance' | 'fallback'

/**
 * Where the credentials for a call came from. `gateway-credits` means no key of any
 * kind was found, so the call runs through AI Gateway on the account's prepaid
 * credits; the others name the key, with `route: 'gateway'` when it went through the
 * gateway for logging and caching on the way.
 */
export type KeySource = 'organization' | 'secret' | 'database' | 'gateway-credits'

export interface ResolvedModel {
  model: LanguageModel
  modelId: string
  provider: Provider
  slug: string
  origin: ModelOrigin
  keySource: KeySource
  route: 'direct' | 'gateway'
  gatewayId: string | null
  /** Pass to generateText / streamText. Set when a route needs a provider quirk handled. */
  providerOptions?: ProviderOptions
}

/** The AI SDK does not export its provider-options type, so derive it from a call. */
type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>

/**
 * The gateway's OpenAI path is chat completions, where reasoning models refuse
 * function tools unless reasoning is off. Direct calls use the Responses API and
 * keep reasoning; measure the difference with `pnpm eval` before choosing.
 */
const GATEWAY_PROVIDER_OPTIONS: Partial<Record<Provider, ProviderOptions>> = {
  openai: { openai: { reasoningEffort: 'none' } },
}

export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelResolutionError'
  }
}

/** The header each provider reads its key from, when our key is forwarded through the gateway. */
const BYOK_HEADER: Record<
  Exclude<Provider, 'workers-ai'>,
  (key: string) => Record<string, string>
> = {
  anthropic: (key) => ({ 'x-api-key': key }),
  openai: (key) => ({ authorization: `Bearer ${key}` }),
  google: (key) => ({ 'x-goog-api-key': key }),
}

/** The unified catalog's prefix, for calls billed to credits through the AI binding. */
const CATALOG_PREFIX: Record<Exclude<Provider, 'workers-ai'>, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
}

export async function resolveModelId(
  db: Db,
  projectModelId: string | null,
): Promise<{ modelId: string; origin: ModelOrigin }> {
  if (projectModelId) return { modelId: projectModelId, origin: 'project' }

  const [row] = await db
    .select({ defaultModelId: instanceSettings.defaultModelId })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 'default'))
    .limit(1)

  if (row?.defaultModelId) return { modelId: row.defaultModelId, origin: 'instance' }

  return { modelId: DEFAULT_MODEL_ID, origin: 'fallback' }
}

/** The organization's own gateway wins over the instance's; null means calls go direct. */
export async function resolveGatewayId(
  db: Db,
  organizationId: string | null,
): Promise<string | null> {
  if (organizationId) {
    const [own] = await db
      .select({ aiGatewayId: organizationSettings.aiGatewayId })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1)
    if (own?.aiGatewayId) return own.aiGatewayId
  }

  const [instance] = await db
    .select({ aiGatewayId: instanceSettings.aiGatewayId })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 'default'))
    .limit(1)

  return instance?.aiGatewayId ?? null
}

export interface ResolveModelOptions {
  /** Spend attribution in the AI Gateway dashboard. */
  metadata?: Record<string, string | number | boolean | null>
}

export async function resolveModel(
  db: Db,
  projectModelId: string | null,
  organizationId: string | null = null,
  options: ResolveModelOptions = {},
): Promise<ResolvedModel> {
  const { modelId, origin } = await resolveModelId(db, projectModelId)

  const parsed = parseModelId(modelId)
  if (!parsed) {
    throw new ModelResolutionError(
      `"${modelId}" is not a model id this instance understands. Model ids are "{provider}:{slug}" — pick another model in ${
        origin === 'project' ? 'the project settings' : 'Administration → Settings'
      }.`,
    )
  }

  const { provider, slug } = parsed
  const gatewayId = await resolveGatewayId(db, organizationId)
  const gateway = gatewayId ? { id: gatewayId, metadata: options.metadata ?? {} } : undefined

  if (provider === 'workers-ai') {
    const workersai = createWorkersAI({ binding: env.AI, ...(gateway ? { gateway } : {}) })
    return {
      model: workersai(slug),
      modelId,
      provider,
      slug,
      origin,
      keySource: 'secret',
      route: gateway ? 'gateway' : 'direct',
      gatewayId,
    }
  }

  const resolved = await resolveProviderKey(db, provider, organizationId)

  if (resolved.source !== 'none' && resolved.key) {
    if (gatewayId) {
      // Our own key, forwarded through the gateway over the AI binding, which is
      // pre-authenticated. The call is logged, cached and rate limited on the way.
      const workersai = createWorkersAI({
        binding: env.AI,
        providers: [openaiPlugin, anthropicPlugin],
        gateway: { id: gatewayId },
      })
      const catalogId = `${CATALOG_PREFIX[provider]}/${slug}` as `${string}/${string}`
      return {
        model: workersai(catalogId, {
          byok: true,
          extraHeaders: BYOK_HEADER[provider](resolved.key),
          metadata: options.metadata ?? {},
        }),
        modelId,
        provider,
        slug,
        origin,
        keySource: resolved.source,
        route: 'gateway',
        gatewayId,
        providerOptions: GATEWAY_PROVIDER_OPTIONS[provider],
      }
    }

    const apiKey = resolved.key
    const model =
      provider === 'anthropic'
        ? createAnthropic({ apiKey })(slug)
        : provider === 'openai'
          ? createOpenAI({ apiKey })(slug)
          : createGoogleGenerativeAI({ apiKey })(slug)

    return {
      model,
      modelId,
      provider,
      slug,
      origin,
      keySource: resolved.source,
      route: 'direct',
      gatewayId: null,
    }
  }

  if (gatewayId) {
    // No key anywhere: AI Gateway serves the call from the account's prepaid credits.
    const workersai = createWorkersAI({
      binding: env.AI,
      providers: [openaiPlugin, anthropicPlugin],
      gateway: { id: gatewayId },
    })
    const catalogId = `${CATALOG_PREFIX[provider]}/${slug}` as `${string}/${string}`
    return {
      model: workersai(catalogId, { metadata: options.metadata ?? {} }),
      modelId,
      provider,
      slug,
      origin,
      keySource: 'gateway-credits',
      route: 'gateway',
      gatewayId,
      providerOptions: GATEWAY_PROVIDER_OPTIONS[provider],
    }
  }

  throw new ModelResolutionError(
    `${PROVIDER_LABELS[provider]} has no API key, so "${modelId}" cannot run. Add one under Organization → Model providers, ask an administrator to add one in Administration → Settings or set the ${PROVIDER_SECRET_VARS[provider]} Worker secret, or turn on AI Gateway in Administration → Settings to pay with Cloudflare credits instead.`,
  )
}

/** The attributes a `model.*` span carries, so traces can be filtered by route and key. */
export function modelSpanAttributes(
  resolved: ResolvedModel,
  subjectId: string,
  kind: 'generation' | 'exploration' | 'chat',
) {
  return {
    'model.id': resolved.modelId,
    'model.provider': resolved.provider,
    'model.route': resolved.route,
    'model.key_source': resolved.keySource,
    'model.gateway': resolved.gatewayId,
    'subject.id': subjectId,
    kind,
  }
}
