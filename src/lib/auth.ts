import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins/admin'
import { organization } from 'better-auth/plugins/organization'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'

import * as schema from '#/db/schema'

export function createAuth(d1: D1Database, env: Cloudflare.Env) {
  const db = drizzle(d1, { schema })

  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: { enabled: true },
    databaseHooks: {
      user: {
        create: {
          before: async (newUser) => {
            const [existing] = await db.select({ id: schema.user.id }).from(schema.user).limit(1)
            if (existing) return

            return { data: { ...newUser, role: 'admin' } }
          },
        },
      },
      session: {
        create: {
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
