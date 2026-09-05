import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { apiKey } from '@better-auth/api-key'
import { admin } from 'better-auth/plugins/admin'
import { organization } from 'better-auth/plugins/organization'
import { createAccessControl } from 'better-auth/plugins/access'
import { defaultStatements } from 'better-auth/plugins/organization/access'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { and, eq, gt } from 'drizzle-orm'
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

/**
 * `DISABLE_SIGNUP` closes public registration on a deployed instance. Two signups
 * still get through, because closing them completely would lock everyone out:
 * the very first account, which bootstraps the instance and becomes its admin,
 * and anyone holding a pending organization invitation.
 */
function isTruthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

async function assertSignUpAllowed(
  db: ReturnType<typeof drizzle<typeof schema>>,
  email: string,
): Promise<void> {
  const [invited] = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.email, email.toLowerCase()),
        eq(schema.invitation.status, 'pending'),
        gt(schema.invitation.expiresAt, new Date()),
      ),
    )
    .limit(1)

  if (invited) return

  throw new APIError('FORBIDDEN', {
    message: 'Registration is closed on this instance. Ask an administrator for an invitation.',
  })
}

export function createAuth(d1: D1Database, env: Cloudflare.Env) {
  const db = drizzle(d1, { schema })
  const signUpDisabled = isTruthy(env.DISABLE_SIGNUP)

  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    secret: env.BETTER_AUTH_SECRET,
    // Optional. When unset, Better Auth infers the origin from each request, which
    // is what a fresh deploy needs before its workers.dev hostname is known.
    baseURL: env.BETTER_AUTH_URL || undefined,
    emailAndPassword: { enabled: true },
    databaseHooks: {
      user: {
        create: {
          before: async (newUser) => {
            const [existing] = await db.select({ id: schema.user.id }).from(schema.user).limit(1)
            if (!existing) return { data: { ...newUser, role: 'admin' } }

            if (signUpDisabled) await assertSignUpAllowed(db, newUser.email)
            return
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
