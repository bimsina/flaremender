/**
 * The request-shaped half of the chat.
 *
 * Reading is an ordinary query against D1; sending is a handoff. Neither runs a
 * model: the turn belongs to the `ProjectChat` Durable Object, which is the only
 * thing that can serialise it, stream it and redact it. What lives here is the
 * part a Durable Object cannot do for itself — reading the session to find out
 * who is asking, and refusing anyone whose organization does not own the
 * project.
 */
import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import { asc, desc, eq } from 'drizzle-orm'

import { chatMessage } from '#/db/schema/app.ts'
import { user } from '#/db/schema/auth.ts'
import type { ChatMessageWire } from '#/engine/chat/contract.ts'
import { orgMiddleware } from './auth.ts'
import { assertProject } from './scope.ts'
import { ValidationError, str } from './validate.ts'

/**
 * How much of a conversation a page loads. Cursor-less on purpose for v1: a
 * project chat is a working surface rather than an archive, and fifty messages
 * is more than anyone scrolls back through before starting a new thought.
 */
const HISTORY_LIMIT = 50

/** Long enough to paste a flow description; short enough not to be a document. */
const MAX_MESSAGE_CHARS = 4000

export const listChatMessages = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId') }))
  .handler(async ({ data, context }): Promise<Array<ChatMessageWire>> => {
    await assertProject(context.db, context.organizationId, data.projectId)

    // Newest fifty, then flipped: "the latest window" is what the view wants,
    // and reading it oldest-first is what the reader wants.
    const rows = await context.db
      .select({
        id: chatMessage.id,
        role: chatMessage.role,
        parts: chatMessage.parts,
        status: chatMessage.status,
        createdBy: chatMessage.createdBy,
        createdByName: user.name,
        createdAt: chatMessage.createdAt,
      })
      .from(chatMessage)
      .leftJoin(user, eq(user.id, chatMessage.createdBy))
      .where(eq(chatMessage.projectId, data.projectId))
      .orderBy(desc(chatMessage.createdAt), asc(chatMessage.id))
      .limit(HISTORY_LIMIT)

    return rows.reverse().map((row) => ({
      id: row.id,
      role: row.role,
      parts: row.parts,
      status: row.status,
      createdBy: row.createdBy,
      createdByName: row.createdByName,
      createdAt: row.createdAt.getTime(),
    }))
  })

/**
 * Say something to the project.
 *
 * Returns as soon as the message is durable, not when the answer is ready: the
 * Durable Object persists it, acknowledges, and then spends however long the
 * turn takes streaming over the sockets. A send that arrives while a turn is
 * running is refused here rather than queued — the composer is disabled while
 * one is in flight, so reaching this is a race rather than a workflow, and
 * silently stacking turns would let two of them create the same intent twice.
 *
 * The id and timestamp come back so the sender can render its own message from
 * what it typed. That is the only copy of it that exists outside D1 until the
 * turn ends, which is what keeps a pasted credential off every other viewer's
 * socket.
 */
export const sendChatMessage = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    text: str(data, 'text', { max: MAX_MESSAGE_CHARS }),
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    const ack = await env.PROJECT_CHAT.getByName(data.projectId).send({
      projectId: data.projectId,
      // From the session. A Durable Object trusts its caller completely, which
      // is only safe because this and the socket route are the only ways in.
      organizationId: context.organizationId,
      userId: context.user.id,
      userName: context.user.name,
      text: data.text,
    })

    if (!ack.accepted) {
      throw new ValidationError(ack.reason ?? 'The assistant is busy.')
    }

    return { messageId: ack.messageId!, createdAt: ack.createdAt! }
  })
