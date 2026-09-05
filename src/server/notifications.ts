/**
 * Where a project's results go: signed webhooks, Slack, Discord and email. Anyone in
 * the organization can read the list; only owners and admins change it, because a
 * destination receives every failure with its error text and links.
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import { and, desc, eq } from 'drizzle-orm'

import {
  NOTIFICATION_KINDS,
  type NotificationKind,
  notificationDelivery,
  notificationDestination,
} from '#/db/schema/app.ts'
import {
  DEFAULT_NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationEventType,
  isNotificationEvent,
} from '#/engine/notifications/events.ts'
import { deliver } from '#/engine/notifications/dispatch.ts'
import { createId } from '#/lib/ids.ts'
import { orgMiddleware } from './auth.ts'
import { encryptSecret } from './crypto.ts'
import { assertOrganizationManager, canManageOrganization, membershipRole } from './membership.ts'
import { assertProject } from './scope.ts'
import { ValidationError, has, oneOf, str } from './validate.ts'

function events(data: unknown): Array<NotificationEventType> {
  const value = (data as Record<string, unknown>).events
  if (!Array.isArray(value)) throw new ValidationError('"events" must be a list.')
  const picked = value.filter(
    (item): item is NotificationEventType => typeof item === 'string' && isNotificationEvent(item),
  )
  if (picked.length === 0) throw new ValidationError('Pick at least one event.')
  return [...new Set(picked)]
}

function target(kind: NotificationKind, value: string): string {
  if (kind === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      throw new ValidationError('Enter one email address.')
    return value.toLowerCase()
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ValidationError('Enter a full URL, starting with https://.')
  }
  const local = /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new ValidationError('Webhook URLs must use https.')
  }
  if (kind === 'slack' && parsed.hostname !== 'hooks.slack.com') {
    throw new ValidationError(
      'A Slack destination takes an incoming webhook URL on hooks.slack.com.',
    )
  }
  if (kind === 'discord' && !/(^|\.)discord(app)?\.com$/.test(parsed.hostname)) {
    throw new ValidationError('A Discord destination takes a webhook URL on discord.com.')
  }
  return parsed.toString()
}

function present(row: typeof notificationDestination.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    target:
      row.kind === 'email'
        ? row.target
        : row.target.replace(/^(https:\/\/[^/]+\/[^/]{0,12})[^]*$/, '$1…'),
    events: row.events,
    enabled: row.enabled,
    signed: row.encryptedSecret !== null,
    lastDeliveryAt: row.lastDeliveryAt,
    lastDeliveryStatus: row.lastDeliveryStatus,
    createdAt: row.createdAt,
  }
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `whsec_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export const listNotificationDestinations = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId') }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)
    const role = await membershipRole(context.db, context.organizationId, context.user.id)

    const rows = await context.db
      .select()
      .from(notificationDestination)
      .where(eq(notificationDestination.projectId, data.projectId))
      .orderBy(desc(notificationDestination.createdAt))

    return {
      canManage: role !== null && canManageOrganization(role),
      emailEnabled: env.EMAIL !== undefined && typeof env.NOTIFY_FROM_ADDRESS === 'string',
      destinations: rows.map(present),
    }
  })

export const createNotificationDestination = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => {
    const kind = oneOf(data, 'kind', NOTIFICATION_KINDS)
    return {
      projectId: str(data, 'projectId'),
      kind,
      name: str(data, 'name', { max: 64 }),
      target: target(kind, str(data, 'target', { max: 2000 })),
      events: has(data, 'events') ? events(data) : DEFAULT_NOTIFICATION_EVENTS,
    }
  })
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)
    await assertOrganizationManager(context.db, context.organizationId, context.user.id)

    const secret = data.kind === 'webhook' ? randomSecret() : null
    const row = {
      id: createId('ntf'),
      projectId: data.projectId,
      kind: data.kind,
      name: data.name,
      target: data.target,
      encryptedSecret: secret ? await encryptSecret(secret) : null,
      events: data.events,
      enabled: true,
      dashboardOrigin: new URL(getRequest().url).origin,
      createdBy: context.user.id,
    }
    await context.db.insert(notificationDestination).values(row)

    const [stored] = await context.db
      .select()
      .from(notificationDestination)
      .where(eq(notificationDestination.id, row.id))
      .limit(1)

    // The signing secret is shown once, like an API key.
    return { ...present(stored!), secret }
  })

export const updateNotificationDestination = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    destinationId: str(data, 'destinationId'),
    enabled: has(data, 'enabled') ? Boolean((data as Record<string, unknown>).enabled) : undefined,
    events: has(data, 'events') ? events(data) : undefined,
    name: has(data, 'name') ? str(data, 'name', { max: 64 }) : undefined,
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)
    await assertOrganizationManager(context.db, context.organizationId, context.user.id)

    const patch = {
      ...(data.enabled === undefined ? {} : { enabled: data.enabled }),
      ...(data.events === undefined ? {} : { events: data.events }),
      ...(data.name === undefined ? {} : { name: data.name }),
    }
    if (Object.keys(patch).length === 0) return { ok: true as const }

    await context.db
      .update(notificationDestination)
      .set(patch)
      .where(
        and(
          eq(notificationDestination.id, data.destinationId),
          eq(notificationDestination.projectId, data.projectId),
        ),
      )
    return { ok: true as const }
  })

export const deleteNotificationDestination = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    destinationId: str(data, 'destinationId'),
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)
    await assertOrganizationManager(context.db, context.organizationId, context.user.id)

    await context.db
      .delete(notificationDestination)
      .where(
        and(
          eq(notificationDestination.id, data.destinationId),
          eq(notificationDestination.projectId, data.projectId),
        ),
      )
    return { ok: true as const }
  })

export const listNotificationDeliveries = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    destinationId: str(data, 'destinationId'),
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    return context.db
      .select({
        id: notificationDelivery.id,
        event: notificationDelivery.event,
        subjectId: notificationDelivery.subjectId,
        status: notificationDelivery.status,
        responseStatus: notificationDelivery.responseStatus,
        error: notificationDelivery.error,
        createdAt: notificationDelivery.createdAt,
      })
      .from(notificationDelivery)
      .innerJoin(
        notificationDestination,
        eq(notificationDestination.id, notificationDelivery.destinationId),
      )
      .where(
        and(
          eq(notificationDelivery.destinationId, data.destinationId),
          eq(notificationDestination.projectId, data.projectId),
        ),
      )
      .orderBy(desc(notificationDelivery.createdAt))
      .limit(20)
  })

/** Sends a made-up failed run so the destination can be checked without breaking a test. */
export const testNotificationDestination = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    destinationId: str(data, 'destinationId'),
  }))
  .handler(async ({ data, context }) => {
    const scoped = await assertProject(context.db, context.organizationId, data.projectId)
    await assertOrganizationManager(context.db, context.organizationId, context.user.id)

    const [destination] = await context.db
      .select()
      .from(notificationDestination)
      .where(
        and(
          eq(notificationDestination.id, data.destinationId),
          eq(notificationDestination.projectId, data.projectId),
        ),
      )
      .limit(1)
    if (!destination) throw new ValidationError('That destination no longer exists.')

    const origin = destination.dashboardOrigin
    const now = new Date()
    const event: NotificationEvent = {
      type: 'run.failed',
      project: { id: scoped.id, name: scoped.name },
      run: {
        id: 'run_test_notification',
        status: 'failed',
        trigger: 'manual',
        test: { id: 'int_test_notification', title: 'Test notification from Flaremender' },
        environment: { id: 'env_test', name: 'Example', baseUrl: 'https://example.com' },
        errorMessage: 'This is a test. Nothing failed; the destination is wired up correctly.',
        durationMs: 1234,
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        url: `${origin}/projects/${scoped.id}?tab=settings`,
        reportUrl: `${origin}/projects/${scoped.id}?tab=settings`,
      },
    }

    return deliver(env, destination, event, 'test')
  })
