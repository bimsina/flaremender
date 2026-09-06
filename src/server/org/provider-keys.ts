/**
 * Pure key resolution so it can be tested without a Worker. `providers.ts` supplies the
 * secret read from the Worker environment.
 */
import { and, eq, isNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { providerKey } from '#/db/schema/app.ts'
import type { Provider } from '#/lib/models.ts'

export type ProviderKeySource = 'organization' | 'secret' | 'database' | 'none'

export interface ResolvedProviderKey {
  source: ProviderKeySource
  key: string | null
}

async function storedKey(
  db: Db,
  provider: Provider,
  organizationId: string | null,
  decrypt: (envelope: string) => Promise<string>,
): Promise<string | null> {
  const [row] = await db
    .select({ encryptedKey: providerKey.encryptedKey })
    .from(providerKey)
    .where(
      and(
        eq(providerKey.provider, provider),
        organizationId === null
          ? isNull(providerKey.organizationId)
          : eq(providerKey.organizationId, organizationId),
      ),
    )
    .limit(1)

  return row ? decrypt(row.encryptedKey) : null
}

/** Organization key, then the Worker secret, then the instance's saved key. */
export async function pickProviderKey(
  db: Db,
  input: {
    provider: Provider
    organizationId: string | null
    secret: string | null
    decrypt: (envelope: string) => Promise<string>
  },
): Promise<ResolvedProviderKey> {
  if (input.provider === 'workers-ai') return { source: 'secret', key: null }

  if (input.organizationId) {
    const own = await storedKey(db, input.provider, input.organizationId, input.decrypt)
    if (own) return { source: 'organization', key: own }
  }

  if (input.secret) return { source: 'secret', key: input.secret }

  const instance = await storedKey(db, input.provider, null, input.decrypt)
  if (instance) return { source: 'database', key: instance }

  return { source: 'none', key: null }
}
