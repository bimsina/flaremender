/**
 * Instance-wide LLM configuration: provider credentials, the model allowlist
 * and the default every project falls back to.
 *
 * Two rules run through the whole file. A Worker secret always wins — when one
 * is bound for a provider, this module refuses to store or delete a database
 * key for it, so an operator who put a key in the platform cannot have it
 * quietly shadowed from a web form. And key material never travels to the
 * client: listings decrypt only far enough to compute a four-character hint.
 */
import { createServerFn } from '@tanstack/react-start'
import { asc, eq } from 'drizzle-orm'

import { allowedModel, instanceSettings, providerKey } from '#/db/schema/app.ts'
import { createId } from '#/lib/ids.ts'
import {
  PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_SECRET_VARS,
  type Provider,
  parseModelId,
} from '#/lib/models.ts'
import { adminMiddleware, authMiddleware } from './auth.ts'
import { decryptSecret, encryptSecret, maskSecret } from './crypto.ts'
import { hasProviderSecret } from './providers.ts'
import { ValidationError, oneOf, optionalStr, str } from './validate.ts'

const SETTINGS_ID = 'default'

/** Where the key a run would actually use comes from. Mirrors `resolveProviderKey`. */
export type ProviderEffectiveSource = 'secret' | 'database' | 'none'

export interface ProviderStatus {
  provider: Provider
  /** A Worker secret is bound (or, for Workers AI, the `AI` binding stands in). */
  secretDetected: boolean
  /** `••••1234` for a key held in the database, null when there is none. */
  dbKeyHint: string | null
  effectiveSource: ProviderEffectiveSource
}

/**
 * Model slugs are passed through to the provider untouched, so the only thing
 * worth checking is that the string is a slug at all — `@cf/meta/llama-3.3`,
 * `claude-sonnet-4-5-20250929`, `gemini-2.0-flash` all have to survive.
 */
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

/** Rejects the two provider states where a stored key would be a lie. */
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

    const stored = await context.db.select().from(providerKey)
    const byProvider = new Map(stored.map((row) => [row.provider, row]))

    const providers: Array<ProviderStatus> = []
    for (const provider of PROVIDERS) {
      // Workers AI is reached through a binding rather than a key, so it is
      // always "configured" and never manageable from here.
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
          // Decrypted only to mask: the plaintext dies in this scope.
          dbKeyHint = maskSecret(await decryptSecret(row.encryptedKey))
        } catch {
          // A rotated ENCRYPTION_KEY must not take the page down; the row shows
          // as unreadable so the operator can replace it.
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
        provider: data.provider,
        encryptedKey,
        addedBy: context.user.id,
      })
      .onConflictDoUpdate({
        target: providerKey.provider,
        set: { encryptedKey, addedBy: context.user.id, updatedAt: new Date() },
      })

    return { provider: data.provider, dbKeyHint: maskSecret(data.key) }
  })

export const deleteProviderKey = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator((data: unknown) => ({ provider: oneOf(data, 'provider', PROVIDERS) }))
  .handler(async ({ data, context }) => {
    assertKeyManageable(data.provider)

    await context.db.delete(providerKey).where(eq(providerKey.provider, data.provider))
    return { ok: true as const }
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

      // Anything outside the allowlist would be a default nobody can see, and
      // one a project picker could never restore after changing it.
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

/**
 * Under `authMiddleware`, not `adminMiddleware`: the allowlist is what every
 * project's model picker reads, and it carries no credentials.
 */
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
      // Adding a model twice renames it rather than failing: the catalog and a
      // manual entry can reasonably disagree about the display name.
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
    // The default must not survive the model it points at, and D1 has no
    // interactive transactions — so both statements go in one batch. The update
    // is a no-op unless this model happens to be the default.
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

/**
 * Whether onboarding should show the instance-setup step. Non-admins never see
 * it, so this answers "no" for them rather than refusing — it is asked on the
 * way into the app, by everybody.
 */
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
