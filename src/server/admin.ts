import { createServerFn } from '@tanstack/react-start'
import { count, desc, eq, sql } from 'drizzle-orm'

import { member, organization, project, testCase, testRun, user } from '#/db/schema/index.ts'
import { adminMiddleware } from './auth.ts'

/**
 * Instance-wide counters. User management itself goes through Better Auth's
 * admin plugin endpoints; this only covers what the plugin doesn't expose.
 */
export const getAdminStats = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context }) => {
    const [[users], [orgs], [projects], [tests], [runs], [admins], [banned]] = await Promise.all([
      context.db.select({ value: count() }).from(user),
      context.db.select({ value: count() }).from(organization),
      context.db.select({ value: count() }).from(project),
      context.db.select({ value: count() }).from(testCase),
      context.db.select({ value: count() }).from(testRun),
      context.db.select({ value: count() }).from(user).where(eq(user.role, 'admin')),
      context.db.select({ value: count() }).from(user).where(eq(user.banned, true)),
    ])

    return {
      users: users?.value ?? 0,
      organizations: orgs?.value ?? 0,
      projects: projects?.value ?? 0,
      tests: tests?.value ?? 0,
      runs: runs?.value ?? 0,
      admins: admins?.value ?? 0,
      banned: banned?.value ?? 0,
    }
  })

export const listAllOrganizations = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context }) => {
    const rows = await context.db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        createdAt: organization.createdAt,
        members: sql<number>`count(distinct ${member.id})`,
        projects: sql<number>`count(distinct ${project.id})`,
      })
      .from(organization)
      .leftJoin(member, eq(member.organizationId, organization.id))
      .leftJoin(project, eq(project.organizationId, organization.id))
      .groupBy(organization.id)
      .orderBy(desc(organization.createdAt))

    return rows.map((row) => ({
      ...row,
      members: Number(row.members),
      projects: Number(row.projects),
    }))
  })

export const listAllMemberships = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator((data: unknown) => ({
    organizationId: String((data as { organizationId?: string })?.organizationId ?? ''),
  }))
  .handler(async ({ data, context }) => {
    if (!data.organizationId) return []

    return context.db
      .select({
        id: member.id,
        role: member.role,
        createdAt: member.createdAt,
        userId: user.id,
        name: user.name,
        email: user.email,
        banned: user.banned,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, data.organizationId))
      .orderBy(desc(member.createdAt))
  })
