import { and, eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { member } from '#/db/schema/auth.ts'
import { AuthError } from './auth-error.ts'

/** Better Auth stores multiple roles comma-separated. */
export function canManageOrganization(role: string): boolean {
  return role.split(',').some((value) => value === 'owner' || value === 'admin')
}

export async function membershipRole(
  db: Db,
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1)
  return row?.role ?? null
}

export async function assertOrganizationManager(
  db: Db,
  organizationId: string,
  userId: string,
): Promise<void> {
  const role = await membershipRole(db, organizationId, userId)
  if (!role || !canManageOrganization(role)) {
    throw new AuthError('Only organization owners and admins can change this.', 403)
  }
}
