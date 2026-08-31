import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import { asc, desc, eq } from 'drizzle-orm'

import { chatMessage } from '#/db/schema/app.ts'
import { user } from '#/db/schema/auth.ts'
import type { ChatMessageWire } from '#/engine/chat/contract.ts'
import { orgMiddleware } from './auth.ts'
import { assertProject } from './scope.ts'
import { ValidationError, str } from './validate.ts'

const HISTORY_LIMIT = 50

const MAX_MESSAGE_CHARS = 4000

export const listChatMessages = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId') }))
  .handler(async ({ data, context }): Promise<Array<ChatMessageWire>> => {
    await assertProject(context.db, context.organizationId, data.projectId)

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
