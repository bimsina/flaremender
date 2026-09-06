/**
 * Which API key a model call uses, in order: the organization's own key, then the
 * Worker secret, then the key saved in the admin console for the whole instance.
 */
import { env } from 'cloudflare:workers'
import { and, eq, isNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { providerKey } from '#/db/schema/app.ts'
import { PROVIDER_SECRET_VARS, type Provider } from '#/lib/models.ts'
import { decryptSecret } from '#/server/core/crypto.ts'
import { type ResolvedProviderKey, pickProviderKey } from '#/server/org/provider-keys.ts'

export type { ProviderKeySource, ResolvedProviderKey } from '#/server/org/provider-keys.ts'

function readSecretVar(name: string): string | null {
  const value = (env as unknown as Record<string, unknown>)[name]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function hasProviderSecret(provider: Provider): boolean {
  const name = PROVIDER_SECRET_VARS[provider]
  return name !== null && readSecretVar(name) !== null
}

export function resolveProviderKey(
  db: Db,
  provider: Provider,
  organizationId: string | null = null,
): Promise<ResolvedProviderKey> {
  const name = PROVIDER_SECRET_VARS[provider]
  return pickProviderKey(db, {
    provider,
    organizationId,
    secret: name === null ? null : readSecretVar(name),
    decrypt: decryptSecret,
  })
}

/** Whether the instance can serve this provider without an organization key. */
export async function instanceHasProviderKey(db: Db, provider: Provider): Promise<boolean> {
  if (provider === 'workers-ai') return true
  if (hasProviderSecret(provider)) return true

  const [row] = await db
    .select({ id: providerKey.id })
    .from(providerKey)
    .where(and(eq(providerKey.provider, provider), isNull(providerKey.organizationId)))
    .limit(1)

  return row !== undefined
}
