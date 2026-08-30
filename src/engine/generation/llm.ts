/**
 * The resolution chain, ending in an AI SDK model.
 *
 * A run asks for "the model for this project" and gets back something
 * `generateText` can use. Three steps, in order: the project's own choice, the
 * instance default, then Workers AI — which needs no credentials, so the chain
 * always terminates somewhere runnable on a fresh install.
 *
 * This module constructs models and nothing else; it never calls one. It is
 * imported from Workflows as well as request handlers, so it must stay free of
 * anything that assumes a request is in flight.
 */
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

/** Which link of the chain the model actually came from, for logs and UI. */
export type ModelOrigin = 'project' | 'instance' | 'fallback'

export interface ResolvedModel {
  model: LanguageModel
  /** `"{provider}:{slug}"`, recorded on the run so history says what wrote it. */
  modelId: string
  provider: Provider
  slug: string
  origin: ModelOrigin
  /** Where the credential came from: `'secret'` also covers the AI binding. */
  keySource: 'secret' | 'database'
}

/** Operator-facing: says what to fix and where, never what the key is. */
export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelResolutionError'
  }
}

/**
 * Walks the chain without touching credentials, so callers that only want to
 * *name* the effective model (a settings caption, a run record) do not have to
 * construct one.
 */
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

export async function resolveModel(db: Db, projectModelId: string | null): Promise<ResolvedModel> {
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

  const resolved = await resolveProviderKey(db, provider)
  if (resolved.source === 'none' || !resolved.key) {
    throw new ModelResolutionError(
      `${PROVIDER_LABELS[provider]} has no API key on this instance, so "${modelId}" cannot run. Add one in Administration → Settings, or set the ${PROVIDER_SECRET_VARS[provider]} Worker secret.`,
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
