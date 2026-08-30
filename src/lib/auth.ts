import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins/admin'
import { organization } from 'better-auth/plugins/organization'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'

import * as schema from '#/db/schema'

/**
 * Keep the plugin list in sync with `auth.config.ts`, which is what
 * `pnpm auth:generate` reads to emit `src/db/schema/auth.ts`.
 */
export function createAuth(d1: D1Database, env: Cloudflare.Env) {
  const db = drizzle(d1, { schema })

  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: { enabled: true },
    databaseHooks: {
      session: {
        create: {
          // Pin the session to an organization up front so every query can
          // rely on `session.activeOrganizationId` instead of re-resolving it.
          before: async (session) => {
            const membership = await db
              .select({ organizationId: schema.member.organizationId })
              .from(schema.member)
              .where(eq(schema.member.userId, session.userId))
              .limit(1)

            return {
              data: {
                ...session,
                activeOrganizationId: membership[0]?.organizationId ?? null,
              },
            }
          },
        },
      },
    },
    plugins: [organization(), admin(), tanstackStartCookies()],
  })
}

export type Auth = ReturnType<typeof createAuth>
