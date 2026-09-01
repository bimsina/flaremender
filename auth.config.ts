/** Keep these plugins in sync with createAuth in src/lib/auth.ts. */
import Database from 'better-sqlite3'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
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
  plugins: [organization(), admin()],
})
