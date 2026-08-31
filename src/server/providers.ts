/** Worker-bound credentials take precedence over keys managed through the admin console. */
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { providerKey } from '#/db/schema/app.ts'
import { PROVIDER_SECRET_VARS, type Provider } from '#/lib/models.ts'
import { decryptSecret } from './crypto.ts'

export type ProviderKeySource = 'secret' | 'database' | 'none'

export interface ResolvedProviderKey {
  source: ProviderKeySource
  key: string | null
}

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
