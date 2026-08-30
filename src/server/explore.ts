/**
 * Exploring an app, and what to do with what it found.
 *
 * The request-shaped half of M9c. Every one of these has a twin in the chat's
 * tool belt calling the same function in `actions.ts`, which is the rule the
 * whole feature is built on: the plan card's "Generate" button and the sentence
 * "generate the first three" have to do the same thing to the same rows, or the
 * conversation and the UI are two products.
 *
 * Approving is deliberately *not* a plain status change with a separate
 * generate step. A proposal a person has ticked is a test they want, and the
 * only useful thing to do with it is write its script — so one call approves and
 * queues, and the card that comes back is about the generation rather than about
 * the approval.
 */
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

/**
 * Speaks into the project's chat on behalf of an action taken outside it.
 *
 * Best effort, always: the work these announce is already running by the time
 * they are called, and a transcript that missed a message is worth far less
 * than the job it describes. The `ProjectChat` object redacts what it is given
 * and declines to broadcast over a turn that is mid-answer.
 */
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

/** Every id in the list must be a real intent of this project. Returns them. */
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

/**
 * Sends the agent round the app.
 *
 * Enqueue-only, exactly like a run or a generation: the browser, the model and
 * the intents it will write are all a Workflow's business, and this returns as
 * soon as the job row exists. The job id is the handle for everything after —
 * it names the Workflow instance, it addresses the live channel the UI watches,
 * and it is the row `src/server.ts` checks before letting a socket near that
 * channel.
 *
 * Posts its card into the chat, because *this* entry point is the one that is
 * not already inside a conversation — the button on an empty Intents tab. The
 * chat's own `explore_project` tool does not announce: it is mid-turn, and the
 * card it returns is already going into the message being written. Without this,
 * pressing the button would start four minutes of work and land the user on a
 * chat with nothing in it.
 */
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

/**
 * Approves a plan, or part of one, and starts writing the scripts.
 *
 * Posts the resulting batch card into the project's chat, because the plan card
 * the user pressed the button on lives in that conversation and an approval
 * that left no trace there would read as nothing having happened. Best effort —
 * the generation is already running by then, and a transcript that missed a
 * message is worth less than the batch it describes.
 */
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

/**
 * Throws a proposal away.
 *
 * A delete rather than a "dismissed" status, and deliberately so: a rejected
 * suggestion is not a state the product has any use for. It would sit in every
 * listing, be filtered out of every query, and be re-proposed by the next
 * exploration anyway — which is the right outcome, because an app changes and
 * yesterday's bad idea can become today's obvious test.
 *
 * Guarded on the status: this is the one delete in the app with no confirmation
 * dialog in front of it, which is only acceptable while it can touch nothing
 * but a proposal.
 */
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

/**
 * Replaces what the project knows about itself. Any member, not just admins.
 *
 * This column is written by agents and read into every prompt they are given,
 * which is precisely why a person has to be able to open it and correct it: an
 * exploration that concluded something wrong about an app would otherwise go on
 * telling every future generation so, with nowhere to say otherwise.
 */
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
