import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { desc, eq } from 'drizzle-orm'

import { member, organization } from '#/db/schema/index.ts'
import { THEME_COOKIE, isThemePreference, type ThemePreference } from '#/lib/theme.tsx'
import { getDb, readSession } from './auth.ts'

export interface AppSession {
  user: {
    id: string
    name: string
    email: string
    image: string | null
    role: string | null
    banned: boolean | null
    createdAt: Date
  }
  activeOrganizationId: string | null
  organizations: Array<{ id: string; name: string; slug: string; role: string }>
}

/**
 * One round trip for everything the shell needs: who you are, which
 * organizations you belong to, and which one is active.
 */
export const fetchSession = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AppSession | null> => {
    const result = await readSession()
    if (!result?.user) return null

    const db = getDb()
    const organizations = await db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: member.role,
        createdAt: organization.createdAt,
      })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(member.userId, result.user.id))
      .orderBy(desc(organization.createdAt))

    return {
      user: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        image: result.user.image ?? null,
        role: (result.user as { role?: string | null }).role ?? null,
        banned: (result.user as { banned?: boolean | null }).banned ?? null,
        createdAt: result.user.createdAt,
      },
      activeOrganizationId:
        (result.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
      organizations: organizations.map(({ createdAt: _createdAt, ...rest }) => rest),
    }
  },
)

/** Read on the server so the first paint already matches the saved theme. */
export const fetchThemePreference = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ThemePreference> => {
    const cookie = getRequest().headers.get('cookie') ?? ''
    const match = cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]*)`))
    const value = match?.[1] ? decodeURIComponent(match[1]) : 'system'
    return isThemePreference(value) ? value : 'system'
  },
)
