import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import { and, desc, eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { apikey } from '#/db/schema/auth.ts'
import { WEBHOOK_API_KEY_CONFIG, WEBHOOK_API_KEY_PREFIX, createAuth } from '#/lib/auth.ts'
import { orgMiddleware } from './auth.ts'
import { canManageOrganization, membershipRole } from './membership.ts'
import { assertProject } from './scope.ts'
import { ValidationError, has, str } from './validate.ts'

const WEBHOOK_PERMISSIONS = { webhook: ['trigger', 'read'] }
const EXPIRATION_DAYS = [30, 90, 365] as const

function metadata(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

async function assertWebhookKeyManager(db: Db, organizationId: string, userId: string) {
  const role = await membershipRole(db, organizationId, userId)
  if (!role || !canManageOrganization(role)) {
    throw new Error('Only organization owners and admins can manage API keys.')
  }
}

function projectIdFromMetadata(value: unknown): string | null {
  const parsed = metadata(value)
  return typeof parsed?.projectId === 'string' ? parsed.projectId : null
}

function presentApiKey(row: typeof apikey.$inferSelect) {
  const parsed = metadata(row.metadata)
  return {
    id: row.id,
    name: row.name ?? 'Unnamed key',
    start: row.start ?? row.prefix ?? WEBHOOK_API_KEY_PREFIX,
    enabled: row.enabled !== false,
    createdAt: row.createdAt,
    lastRequest: row.lastRequest,
    expiresAt: row.expiresAt,
    createdByName:
      typeof parsed?.createdByName === 'string' ? parsed.createdByName : 'Unknown user',
  }
}

export const getProjectWebhookSettings = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId') }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)
    const role = await membershipRole(context.db, context.organizationId, context.user.id)
    const canManage = role !== null && canManageOrganization(role)
    const origin = new URL(getRequest().url).origin
    const projectRunPath = `/api/v1/projects/${encodeURIComponent(data.projectId)}/runs`
    const testRunPath = `/api/v1/projects/${encodeURIComponent(data.projectId)}/tests/{testId}/runs`
    const keys = canManage
      ? await context.db
          .select()
          .from(apikey)
          .where(
            and(
              eq(apikey.configId, WEBHOOK_API_KEY_CONFIG),
              eq(apikey.referenceId, context.organizationId),
            ),
          )
          .orderBy(desc(apikey.createdAt))
      : []

    return {
      canManage,
      projectRunUrl: `${origin}${projectRunPath}`,
      testRunUrl: `${origin}${testRunPath}`,
      keys: keys
        .filter((row) => projectIdFromMetadata(row.metadata) === data.projectId)
        .map(presentApiKey),
    }
  })

export const createProjectWebhookKey = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => {
    const expiresInDays = has(data, 'expiresInDays')
      ? (data as Record<string, unknown>).expiresInDays
      : 90
    if (
      expiresInDays !== null &&
      (typeof expiresInDays !== 'number' ||
        !EXPIRATION_DAYS.includes(expiresInDays as (typeof EXPIRATION_DAYS)[number]))
    ) {
      throw new ValidationError('Choose 30 days, 90 days, one year, or no expiration.')
    }
    return {
      projectId: str(data, 'projectId'),
      name: str(data, 'name', { max: 64 }),
      expiresInDays: expiresInDays as (typeof EXPIRATION_DAYS)[number] | null,
    }
  })
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)
    await assertWebhookKeyManager(context.db, context.organizationId, context.user.id)
    const created = await createAuth(env.DB, env).api.createApiKey({
      body: {
        configId: WEBHOOK_API_KEY_CONFIG,
        name: data.name,
        expiresIn: data.expiresInDays === null ? null : data.expiresInDays * 24 * 60 * 60,
        organizationId: context.organizationId,
        userId: context.user.id,
        metadata: {
          projectId: data.projectId,
          createdBy: context.user.id,
          createdByName: context.user.name,
        },
        permissions: WEBHOOK_PERMISSIONS,
        rateLimitEnabled: false,
      },
    })
    return { ...presentApiKey({ ...created, key: '' }), key: created.key }
  })

export const revokeProjectWebhookKey = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    keyId: str(data, 'keyId'),
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)
    await assertWebhookKeyManager(context.db, context.organizationId, context.user.id)
    const [key] = await context.db
      .select()
      .from(apikey)
      .where(
        and(
          eq(apikey.id, data.keyId),
          eq(apikey.configId, WEBHOOK_API_KEY_CONFIG),
          eq(apikey.referenceId, context.organizationId),
        ),
      )
      .limit(1)
    if (!key || projectIdFromMetadata(key.metadata) !== data.projectId) {
      throw new Error('API key not found.')
    }
    await createAuth(env.DB, env).api.updateApiKey({
      body: { configId: WEBHOOK_API_KEY_CONFIG, keyId: key.id, enabled: false },
      headers: getRequest().headers,
    })
    return { ok: true as const }
  })
