import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import { and, eq, inArray } from 'drizzle-orm'

import { intent } from '#/db/schema/app.ts'
import type { ChatPart } from '#/engine/chat/contract.ts'
import {
  MAX_BATCH_INTENTS,
  MAX_PROJECT_CONTEXT_CHARS,
  deleteIntentRecord,
  queueBatchGeneration,
  queueExploration,
  resolveTargetEnvironment,
  setProjectContextRecord,
} from './actions.ts'
import { orgMiddleware } from './auth.ts'
import { assertProject, loadEnvironment, loadIntent } from './scope.ts'
import { ValidationError, has, optionalStr, str } from './validate.ts'

async function announce(
  projectId: string,
  organizationId: string,
  parts: Array<ChatPart>,
): Promise<void> {
  try {
    await env.PROJECT_CHAT.getByName(projectId).announce({ projectId, organizationId, parts })
  } catch (error) {
    console.error(`[explore] could not post to ${projectId}'s chat:`, error)
  }
}

async function requireIntents(
  db: Parameters<typeof assertProject>[0],
  projectId: string,
  intentIds: Array<string>,
) {
  if (intentIds.length === 0) throw new ValidationError('Choose at least one test.')
  if (intentIds.length > MAX_BATCH_INTENTS) {
    throw new ValidationError(`Generate at most ${MAX_BATCH_INTENTS} tests at a time.`)
  }

  const rows = await db
    .select({ id: intent.id, title: intent.title })
    .from(intent)
    .where(and(eq(intent.projectId, projectId), inArray(intent.id, intentIds)))

  if (rows.length !== intentIds.length) {
    throw new ValidationError('Some of those tests no longer exist.')
  }

  return rows
}

export const exploreProject = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    environmentId: has(data, 'environmentId') ? str(data, 'environmentId') : null,
    focus: optionalStr(data, 'focus', 500),
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    const named = data.environmentId
      ? (await loadEnvironment(context.db, context.organizationId, data.environmentId)).environment
      : null

    const target = await resolveTargetEnvironment(context.db, data.projectId, named, 'explore')

    const queued = await queueExploration(context.db, {
      projectId: data.projectId,
      organizationId: context.organizationId,
      environment: target,
      createdBy: context.user.id,
      focus: data.focus,
    })

    await announce(data.projectId, context.organizationId, [
      {
        type: 'text',
        text: 'Looking round the app now. I will post a plan here when I am done.',
      },
      {
        type: 'card',
        card: {
          kind: 'explore',
          jobId: queued.jobId,
          environmentName: target.name,
          focus: data.focus,
        },
      },
    ])

    return queued
  })

export const approveProposedIntents = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => {
    const value = (data as { intentIds?: unknown } | null)?.intentIds
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
      throw new ValidationError('"intentIds" must be a list of test ids.')
    }

    return {
      projectId: str(data, 'projectId'),
      environmentId: has(data, 'environmentId') ? str(data, 'environmentId') : null,
      intentIds: value as Array<string>,
    }
  })
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)
    await requireIntents(context.db, data.projectId, data.intentIds)

    const named = data.environmentId
      ? (await loadEnvironment(context.db, context.organizationId, data.environmentId)).environment
      : null

    const target = await resolveTargetEnvironment(context.db, data.projectId, named, 'generate')

    const queued = await queueBatchGeneration(context.db, {
      projectId: data.projectId,
      organizationId: context.organizationId,
      environment: target,
      createdBy: context.user.id,
      intentIds: data.intentIds,
    })

    await announce(data.projectId, context.organizationId, [
      {
        type: 'text',
        text: `Approved ${queued.total} test${queued.total === 1 ? '' : 's'}. Writing their scripts now, one at a time.`,
      },
      {
        type: 'card',
        card: {
          kind: 'batch',
          jobId: queued.jobId,
          environmentName: target.name,
          intentIds: queued.intentIds,
        },
      },
    ])

    return queued
  })

export const dismissProposedIntent = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ intentId: str(data, 'intentId') }))
  .handler(async ({ data, context }) => {
    const row = await loadIntent(context.db, context.organizationId, data.intentId)

    if (row.intent.status !== 'proposed') {
      throw new ValidationError(
        'That test has already been approved. Delete it from the Intents tab instead.',
      )
    }

    return deleteIntentRecord(context.db, row.intent.id)
  })

export const setProjectContext = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    context: optionalStr(data, 'context', MAX_PROJECT_CONTEXT_CHARS),
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)
    return setProjectContextRecord(context.db, data.projectId, data.context)
  })
