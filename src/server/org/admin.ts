import { createServerFn } from '@tanstack/react-start'
import { count, desc, eq, sql } from 'drizzle-orm'

import {
  chatMessage,
  generationJob,
  intent,
  member,
  organization,
  project,
  run,
  user,
} from '#/db/schema/index.ts'
import { adminMiddleware } from '#/server/auth/auth.ts'

export const getAdminStats = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context }) => {
    const [[users], [orgs], [projects], [tests], [runs], [admins], [banned]] = await Promise.all([
      context.db.select({ value: count() }).from(user),
      context.db.select({ value: count() }).from(organization),
      context.db.select({ value: count() }).from(project),
      context.db.select({ value: count() }).from(intent),
      context.db.select({ value: count() }).from(run),
      context.db.select({ value: count() }).from(user).where(eq(user.role, 'admin')),
      context.db.select({ value: count() }).from(user).where(eq(user.banned, true)),
    ])

    return {
      users: users?.value ?? 0,
      organizations: orgs?.value ?? 0,
      projects: projects?.value ?? 0,
      intents: tests?.value ?? 0,
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

    const jobTokens = await context.db
      .select({
        organizationId: generationJob.organizationId,
        tokens: sql<number>`sum(${generationJob.inputTokens} + ${generationJob.outputTokens})`,
      })
      .from(generationJob)
      .groupBy(generationJob.organizationId)

    const chatTokens = await context.db
      .select({
        organizationId: project.organizationId,
        tokens: sql<number>`sum(${chatMessage.inputTokens} + ${chatMessage.outputTokens})`,
      })
      .from(chatMessage)
      .innerJoin(project, eq(project.id, chatMessage.projectId))
      .groupBy(project.organizationId)

    const tokens = new Map<string, number>()
    for (const row of [...jobTokens, ...chatTokens]) {
      tokens.set(
        row.organizationId,
        (tokens.get(row.organizationId) ?? 0) + Number(row.tokens ?? 0),
      )
    }

    return rows.map((row) => ({
      ...row,
      members: Number(row.members),
      projects: Number(row.projects),
      tokens: tokens.get(row.id) ?? 0,
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
