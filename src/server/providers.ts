/**
 * Where a provider's API key comes from.
 *
 * A Worker secret always wins: an operator who has bound `ANTHROPIC_API_KEY`
 * has said where that key lives, so the admin console must refuse to store or
 * delete a database key for that provider. The database is only a fallback for
 * instances that would rather manage keys from the UI.
 */
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { providerKey } from '#/db/schema/app.ts'
import { PROVIDER_SECRET_VARS, type Provider } from '#/lib/models.ts'
import { decryptSecret } from './crypto.ts'

export type ProviderKeySource = 'secret' | 'database' | 'none'

export interface ResolvedProviderKey {
  source: ProviderKeySource
  /** Null for `workers-ai` (binding-backed) and for `'none'`. */
  key: string | null
}

/** Optional vars aren't in `Cloudflare.Env` as a lookup, so read them by name. */
function readSecretVar(name: string): string | null {
  const value = (env as unknown as Record<string, unknown>)[name]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function hasProviderSecret(provider: Provider): boolean {
  const name = PROVIDER_SECRET_VARS[provider]
  return name !== null && readSecretVar(name) !== null
}

export async function resolveProviderKey(db: Db, provider: Provider): Promise<ResolvedProviderKey> {
  if (provider === 'workers-ai') return { source: 'secret', key: null }

  const secret = readSecretVar(PROVIDER_SECRET_VARS[provider])
  if (secret) return { source: 'secret', key: secret }

  const [row] = await db
    .select({ encryptedKey: providerKey.encryptedKey })
    .from(providerKey)
    .where(eq(providerKey.provider, provider))
    .limit(1)

  if (!row) return { source: 'none', key: null }

  return { source: 'database', key: await decryptSecret(row.encryptedKey) }
}
