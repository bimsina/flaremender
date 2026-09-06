import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import { allowedModel, instanceSettings, providerKey } from '#/db/schema/app.ts'
import { createId } from '#/lib/ids.ts'
import {
  PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_SECRET_VARS,
  type Provider,
  RECOMMENDED_MODELS,
  parseModelId,
} from '#/lib/models.ts'
import { adminMiddleware, authMiddleware } from '#/server/auth/auth.ts'
import { decryptSecret, encryptSecret, maskSecret } from '#/server/core/crypto.ts'
import { hasProviderSecret } from '#/server/org/providers.ts'
import { ValidationError, oneOf, optionalStr, str } from '#/server/core/validate.ts'

const SETTINGS_ID = 'default'

export type ProviderEffectiveSource = 'secret' | 'database' | 'none'

export interface ProviderStatus {
  provider: Provider
  secretDetected: boolean
  dbKeyHint: string | null
  effectiveSource: ProviderEffectiveSource
}

const SLUG_PATTERN = /^[\w@./:-]+$/

function modelSlug(value: string): string {
  if (value.length > 200) throw new ValidationError('A model id must be at most 200 characters.')
  if (!SLUG_PATTERN.test(value)) {
    throw new ValidationError(
      'A model id may only contain letters, numbers and the characters @ . / : _ -',
    )
  }
  return value
}

function assertKeyManageable(provider: Provider): void {
  if (provider === 'workers-ai') {
    throw new ValidationError(
      'Workers AI has no API key. It runs through this account’s AI binding.',
    )
  }

  if (hasProviderSecret(provider)) {
    throw new ValidationError(
      `${PROVIDER_LABELS[provider]} is configured with the ${PROVIDER_SECRET_VARS[provider]} Worker secret, which takes precedence over anything saved here. Remove the secret if you want to manage this key from the console.`,
    )
  }
}

export const getInstanceSettings = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context }) => {
    const [settings] = await context.db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.id, SETTINGS_ID))
      .limit(1)

    const stored = await context.db
      .select()
      .from(providerKey)
      .where(isNull(providerKey.organizationId))
    const byProvider = new Map(stored.map((row) => [row.provider, row]))

    const providers: Array<ProviderStatus> = []
    for (const provider of PROVIDERS) {
      if (provider === 'workers-ai') {
        providers.push({
          provider,
          secretDetected: true,
          dbKeyHint: null,
          effectiveSource: 'secret',
        })
        continue
      }

      const secretDetected = hasProviderSecret(provider)
      const row = byProvider.get(provider)

      let dbKeyHint: string | null = null
      if (row) {
        try {
          dbKeyHint = maskSecret(await decryptSecret(row.encryptedKey))
        } catch {
          dbKeyHint = null
        }
      }

      providers.push({
        provider,
        secretDetected,
        dbKeyHint,
        effectiveSource: secretDetected ? 'secret' : row ? 'database' : 'none',
      })
    }

    return {
      defaultModelId: settings?.defaultModelId ?? null,
      aiGatewayId: settings?.aiGatewayId ?? null,
      setupCompletedAt: settings?.setupCompletedAt ?? null,
      retentionRunsPerIntent: settings?.retentionRunsPerIntent ?? null,
      providers,
    }
  })

export const setProviderKey = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator((data: unknown) => ({
    provider: oneOf(data, 'provider', PROVIDERS),
    key: str(data, 'key', { max: 500 }),
  }))
  .handler(async ({ data, context }) => {
    assertKeyManageable(data.provider)

    const encryptedKey = await encryptSecret(data.key)

    await context.db
      .insert(providerKey)
      .values({
        id: createId('pk'),
        organizationId: null,
        provider: data.provider,
        encryptedKey,
        addedBy: context.user.id,
      })
      .onConflictDoUpdate({
        target: providerKey.provider,
        targetWhere: sql`organization_id is null`,
        set: { encryptedKey, addedBy: context.user.id, updatedAt: new Date() },
      })

    // A key with no model to use it is a dead end, so the first key also picks a model.
    const recommended = RECOMMENDED_MODELS[data.provider]
    let adoptedModelId: string | null = null
    if (recommended) {
      await context.db
        .insert(allowedModel)
        .values({
          id: createId('mdl'),
          modelId: recommended.modelId,
          provider: data.provider,
          displayName: recommended.displayName,
          addedBy: context.user.id,
        })
        .onConflictDoNothing()

      const [settings] = await context.db
        .select({ defaultModelId: instanceSettings.defaultModelId })
        .from(instanceSettings)
        .where(eq(instanceSettings.id, SETTINGS_ID))
        .limit(1)

      if (!settings?.defaultModelId) {
        await context.db
          .insert(instanceSettings)
          .values({
            id: SETTINGS_ID,
            defaultModelId: recommended.modelId,
            updatedBy: context.user.id,
          })
          .onConflictDoUpdate({
            target: instanceSettings.id,
            set: {
              defaultModelId: recommended.modelId,
              updatedBy: context.user.id,
              updatedAt: new Date(),
            },
          })
        adoptedModelId = recommended.modelId
      }
    }

    return { provider: data.provider, dbKeyHint: maskSecret(data.key), adoptedModelId }
  })

export const deleteProviderKey = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator((data: unknown) => ({ provider: oneOf(data, 'provider', PROVIDERS) }))
  .handler(async ({ data, context }) => {
    assertKeyManageable(data.provider)

    await context.db
      .delete(providerKey)
      .where(and(eq(providerKey.provider, data.provider), isNull(providerKey.organizationId)))
    return { ok: true as const }
  })

const GATEWAY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export const setAiGateway = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator((data: unknown) => {
    const aiGatewayId = optionalStr(data, 'aiGatewayId', 64)
    if (aiGatewayId !== null && !GATEWAY_ID.test(aiGatewayId)) {
      throw new ValidationError(
        'A gateway id is letters, numbers, dashes and underscores, like "default" or "flaremender-prod".',
      )
    }
    return { aiGatewayId }
  })
  .handler(async ({ data, context }) => {
    await context.db
      .insert(instanceSettings)
      .values({ id: SETTINGS_ID, aiGatewayId: data.aiGatewayId, updatedBy: context.user.id })
      .onConflictDoUpdate({
        target: instanceSettings.id,
        set: { aiGatewayId: data.aiGatewayId, updatedBy: context.user.id, updatedAt: new Date() },
      })

    return { aiGatewayId: data.aiGatewayId }
  })

export const updateInstanceSettings = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator((data: unknown) => ({ defaultModelId: optionalStr(data, 'defaultModelId', 200) }))
  .handler(async ({ data, context }) => {
    if (data.defaultModelId !== null) {
      const [row] = await context.db
        .select({ id: allowedModel.id })
        .from(allowedModel)
        .where(eq(allowedModel.modelId, data.defaultModelId))
        .limit(1)

      if (!row) {
        throw new ValidationError('Add that model to the allowlist before making it the default.')
      }
    }

    await context.db
      .insert(instanceSettings)
      .values({
        id: SETTINGS_ID,
        defaultModelId: data.defaultModelId,
        updatedBy: context.user.id,
      })
      .onConflictDoUpdate({
        target: instanceSettings.id,
        set: {
          defaultModelId: data.defaultModelId,
          updatedBy: context.user.id,
          updatedAt: new Date(),
        },
      })

    return { defaultModelId: data.defaultModelId }
  })

export const listAllowedModels = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) =>
    context.db
      .select({
        id: allowedModel.id,
        modelId: allowedModel.modelId,
        provider: allowedModel.provider,
        displayName: allowedModel.displayName,
        createdAt: allowedModel.createdAt,
      })
      .from(allowedModel)
      .orderBy(asc(allowedModel.provider), asc(allowedModel.displayName)),
  )

export const addAllowedModel = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator((data: unknown) => ({
    modelId: modelSlug(str(data, 'modelId', { max: 200 })),
    displayName: str(data, 'displayName', { max: 120 }),
  }))
  .handler(async ({ data, context }) => {
    const parsed = parseModelId(data.modelId)
    if (!parsed) {
      throw new ValidationError(
        `A model id is "{provider}:{slug}" — one of ${PROVIDERS.join(', ')} then a colon and the provider's own name for the model.`,
      )
    }

    await context.db
      .insert(allowedModel)
      .values({
        id: createId('mdl'),
        modelId: data.modelId,
        provider: parsed.provider,
        displayName: data.displayName,
        addedBy: context.user.id,
      })
      .onConflictDoUpdate({
        target: allowedModel.modelId,
        set: { displayName: data.displayName, addedBy: context.user.id },
      })

    return { modelId: data.modelId, provider: parsed.provider, displayName: data.displayName }
  })

export const removeAllowedModel = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator((data: unknown) => ({ modelId: str(data, 'modelId', { max: 200 }) }))
  .handler(async ({ data, context }) => {
    await context.db.batch([
      context.db.delete(allowedModel).where(eq(allowedModel.modelId, data.modelId)),
      context.db
        .update(instanceSettings)
        .set({ defaultModelId: null })
        .where(eq(instanceSettings.defaultModelId, data.modelId)),
    ])

    return { ok: true as const }
  })

export const completeInstanceSetup = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .handler(async ({ context }) => {
    const setupCompletedAt = new Date()

    await context.db
      .insert(instanceSettings)
      .values({ id: SETTINGS_ID, setupCompletedAt, updatedBy: context.user.id })
      .onConflictDoUpdate({
        target: instanceSettings.id,
        set: { setupCompletedAt, updatedBy: context.user.id, updatedAt: new Date() },
      })

    return { setupCompletedAt }
  })

export const getInstanceSetupStatus = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    if (context.user.role !== 'admin') return { needsSetup: false }

    const [row] = await context.db
      .select({ setupCompletedAt: instanceSettings.setupCompletedAt })
      .from(instanceSettings)
      .where(eq(instanceSettings.id, SETTINGS_ID))
      .limit(1)

    return { needsSetup: (row?.setupCompletedAt ?? null) === null }
  })
