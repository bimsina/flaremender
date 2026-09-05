/**
 * An organization's own model provider keys. They win over the instance's keys and
 * Worker secrets, so a team can bring its own billing without touching the instance.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, eq } from 'drizzle-orm'

import { providerKey } from '#/db/schema/app.ts'
import { createId } from '#/lib/ids.ts'
import { PROVIDERS, type Provider } from '#/lib/models.ts'
import { orgMiddleware } from './auth.ts'
import { decryptSecret, encryptSecret, maskSecret } from './crypto.ts'
import { assertOrganizationManager, canManageOrganization, membershipRole } from './membership.ts'
import { instanceHasProviderKey } from './providers.ts'
import { ValidationError, oneOf, str } from './validate.ts'

export interface OrganizationProviderStatus {
  provider: Provider
  /** Masked tail of this organization's own key, or null when it has none. */
  ownKeyHint: string | null
  /** Whether the instance can serve this provider when the organization has no key. */
  instanceCovers: boolean
}

function assertManageable(provider: Provider): void {
  if (provider === 'workers-ai') {
    throw new ValidationError(
      'Workers AI has no API key. It runs through the instance’s AI binding.',
    )
  }
}

export const getOrganizationProviderKeys = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .handler(async ({ context }) => {
    const role = await membershipRole(context.db, context.organizationId, context.user.id)

    const rows = await context.db
      .select({ provider: providerKey.provider, encryptedKey: providerKey.encryptedKey })
      .from(providerKey)
      .where(eq(providerKey.organizationId, context.organizationId))

    const own = new Map(rows.map((row) => [row.provider, row.encryptedKey]))

    const providers: Array<OrganizationProviderStatus> = []
    for (const provider of PROVIDERS) {
      if (provider === 'workers-ai') continue

      let ownKeyHint: string | null = null
      const encrypted = own.get(provider)
      if (encrypted) {
        try {
          ownKeyHint = maskSecret(await decryptSecret(encrypted))
        } catch {
          ownKeyHint = '••••'
        }
      }

      providers.push({
        provider,
        ownKeyHint,
        instanceCovers: await instanceHasProviderKey(context.db, provider),
      })
    }

    return { canManage: role !== null && canManageOrganization(role), providers }
  })

export const setOrganizationProviderKey = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    provider: oneOf(data, 'provider', PROVIDERS),
    key: str(data, 'key', { max: 500 }),
  }))
  .handler(async ({ data, context }) => {
    assertManageable(data.provider)
    await assertOrganizationManager(context.db, context.organizationId, context.user.id)

    const encryptedKey = await encryptSecret(data.key)

    await context.db
      .insert(providerKey)
      .values({
        id: createId('pk'),
        organizationId: context.organizationId,
        provider: data.provider,
        encryptedKey,
        addedBy: context.user.id,
      })
      .onConflictDoUpdate({
        target: [providerKey.organizationId, providerKey.provider],
        set: { encryptedKey, addedBy: context.user.id, updatedAt: new Date() },
      })

    return { provider: data.provider, ownKeyHint: maskSecret(data.key) }
  })

export const deleteOrganizationProviderKey = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ provider: oneOf(data, 'provider', PROVIDERS) }))
  .handler(async ({ data, context }) => {
    assertManageable(data.provider)
    await assertOrganizationManager(context.db, context.organizationId, context.user.id)

    await context.db
      .delete(providerKey)
      .where(
        and(
          eq(providerKey.organizationId, context.organizationId),
          eq(providerKey.provider, data.provider),
        ),
      )

    return { ok: true as const }
  })
