import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { apiKey } from '@better-auth/api-key'
import { admin } from 'better-auth/plugins/admin'
import { organization } from 'better-auth/plugins/organization'
import { createAccessControl } from 'better-auth/plugins/access'
import { defaultStatements } from 'better-auth/plugins/organization/access'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'

import * as schema from '#/db/schema'

const organizationAccess = createAccessControl({
  ...defaultStatements,
  apiKey: ['create', 'read', 'update', 'delete'],
} as const)

const organizationRoles = {
  owner: organizationAccess.newRole({
    organization: ['update', 'delete'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    team: ['create', 'update', 'delete'],
    ac: ['create', 'read', 'update', 'delete'],
    apiKey: ['create', 'read', 'update', 'delete'],
  }),
  admin: organizationAccess.newRole({
    organization: ['update'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    team: ['create', 'update', 'delete'],
    ac: ['create', 'read', 'update', 'delete'],
    apiKey: ['create', 'read', 'update', 'delete'],
  }),
  member: organizationAccess.newRole({
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: ['read'],
    apiKey: [],
  }),
}

export const WEBHOOK_API_KEY_CONFIG = 'project-webhook'
export const WEBHOOK_API_KEY_PREFIX = 'flm_pk_'

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
    plugins: [
      organization({ ac: organizationAccess, roles: organizationRoles }),
      apiKey({
        configId: WEBHOOK_API_KEY_CONFIG,
        references: 'organization',
        defaultPrefix: WEBHOOK_API_KEY_PREFIX,
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
      tanstackStartCookies(),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
