/** Keep these plugins in sync with createAuth in src/lib/auth/auth.ts. */
import Database from 'better-sqlite3'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { apiKey } from '@better-auth/api-key'
import { admin } from 'better-auth/plugins/admin'
import { organization } from 'better-auth/plugins/organization'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from './src/db/schema/index.ts'

const sqlite = new Database(':memory:')
const db = drizzle(sqlite, { schema })

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'sqlite', schema }),
  secret: 'dev-only-min-32-characters-secret!!',
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3009',
  emailAndPassword: { enabled: true },
  plugins: [
    organization(),
    apiKey({
      configId: 'project-webhook',
      references: 'organization',
      defaultPrefix: 'flm_pk_',
      defaultKeyLength: 64,
      startingCharactersConfig: { shouldStore: true, charactersLength: 14 },
      requireName: true,
      maximumNameLength: 64,
      enableMetadata: true,
      keyExpiration: { defaultExpiresIn: null, minExpiresIn: 1, maxExpiresIn: 365 },
      rateLimit: { enabled: false },
      enableSessionForAPIKeys: false,
      permissions: { defaultPermissions: { webhook: ['trigger', 'read'] } },
    }),
    admin(),
  ],
})
