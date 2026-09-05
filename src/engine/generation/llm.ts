import { env } from 'cloudflare:workers'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { eq } from 'drizzle-orm'
import { createWorkersAI } from 'workers-ai-provider'

import type { Db } from '#/db/index.ts'
import { instanceSettings } from '#/db/schema/app.ts'
import {
  DEFAULT_MODEL_ID,
  PROVIDER_LABELS,
  PROVIDER_SECRET_VARS,
  type Provider,
  parseModelId,
} from '#/lib/models.ts'
import { resolveProviderKey } from '#/server/providers.ts'

export type ModelOrigin = 'project' | 'instance' | 'fallback'

export interface ResolvedModel {
  model: LanguageModel
  modelId: string
  provider: Provider
  slug: string
  origin: ModelOrigin
  keySource: 'organization' | 'secret' | 'database'
}

export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelResolutionError'
  }
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

export async function resolveModel(
  db: Db,
  projectModelId: string | null,
  organizationId: string | null = null,
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

  if (provider === 'workers-ai') {
    const workersai = createWorkersAI({ binding: env.AI })
    return { model: workersai(slug), modelId, provider, slug, origin, keySource: 'secret' }
  }

  const resolved = await resolveProviderKey(db, provider, organizationId)
  if (resolved.source === 'none' || !resolved.key) {
    throw new ModelResolutionError(
      `${PROVIDER_LABELS[provider]} has no API key, so "${modelId}" cannot run. Add one under Organization → Model providers, or ask an administrator to add one in Administration → Settings or set the ${PROVIDER_SECRET_VARS[provider]} Worker secret.`,
    )
  }

  const apiKey = resolved.key
  const model =
    provider === 'anthropic'
      ? createAnthropic({ apiKey })(slug)
      : provider === 'openai'
        ? createOpenAI({ apiKey })(slug)
        : createGoogleGenerativeAI({ apiKey })(slug)

  return { model, modelId, provider, slug, origin, keySource: resolved.source }
}
