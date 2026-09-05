import { DurableObject } from 'cloudflare:workers'
import { type ModelMessage, stepCountIs, streamText } from 'ai'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import { type Db, createDb } from '#/db/index.ts'
import { chatMessage, environment, environmentVariable, intent, project } from '#/db/schema/app.ts'
import type {
  ChatAnnouncement,
  ChatCard,
  ChatEvent,
  ChatEventEnvelope,
  ChatMessageWire,
  ChatPart,
  ChatTurnAck,
  ChatTurnRequest,
} from '#/engine/chat/contract.ts'
import { CHAT_SYSTEM_PROMPT, buildChatContext } from '#/engine/chat/prompts.ts'
import { type ChatToolBus, buildChatTools } from '#/engine/chat/tools.ts'
import { modelSpanAttributes, resolveModel } from '#/engine/generation/llm.ts'
import { span } from '#/engine/tracing.ts'
import { type Scrubber, createScrubber } from '#/engine/runner/scrub.ts'
import { createId } from '#/lib/ids.ts'
import { decryptSecret } from '#/server/crypto.ts'

const HISTORY_LIMIT = 30

const MAX_TOOL_STEPS = 8

const MAX_BUFFERED = 2000

const BUSY_MESSAGE = 'Still working on the previous message — give it a moment and send that again.'

interface TurnSession {
  db: Db
  request: ChatTurnRequest
  userMessage: ChatMessageWire
  assistantMessageId: string
  secrets: Array<string>
  scrubber: Scrubber
  systemPrompt: string
  projectModelId: string | null
  parts: Array<ChatPart>
}

function describeCard(card: ChatCard): string {
  switch (card.kind) {
    case 'intent':
      return `[test ${card.intentId} — "${card.title}" — ${card.status}${
        card.schedule ? ` — scheduled ${card.schedule}` : ''
      }]`
    case 'generation':
      return `[generation ${card.jobId} running for test ${card.intentId} on ${card.environmentName}]`
    case 'run':
      return `[run ${card.runId} of test ${card.intentId} on ${card.environmentName} — ${card.status}]`
    case 'suite':
      return `[run-all ${card.suiteRunId} on ${card.environmentName} — ${card.status}]`
    case 'environment':
      return `[environment ${card.environmentId} — "${card.name}" — ${card.baseUrl}${
        card.variableNames.length > 0 ? ` — variables: ${card.variableNames.join(', ')}` : ''
      }]`
    case 'explore':
      return `[exploration ${card.jobId} running on ${card.environmentName}${
        card.focus ? ` — focus: ${card.focus}` : ''
      }]`
    case 'plan':
      return `[plan ${card.planId} — "${card.title}" — proposed tests: ${card.items
        .map((item) => `${item.intentId ?? 'unknown'} "${item.title}"`)
        .join('; ')}]`
    case 'batch':
      return `[batch generation ${card.jobId} running for ${card.intentIds.length} tests on ${card.environmentName}]`
  }
}

function renderParts(parts: Array<ChatPart>): string {
  return parts
    .map((part) => (part.type === 'text' ? part.text : describeCard(part.card)))
    .filter((line) => line.trim().length > 0)
    .join('\n')
}

function scrubCard(card: ChatCard, scrubber: Scrubber): ChatCard {
  switch (card.kind) {
    case 'intent':
      return { ...card, title: scrubber.text(card.title) }
    case 'generation':
      return { ...card, intentTitle: scrubber.text(card.intentTitle) }
    case 'run':
      return { ...card, intentTitle: scrubber.text(card.intentTitle) }
    case 'suite':
      return card
    case 'environment':
      return { ...card, name: scrubber.text(card.name), baseUrl: scrubber.text(card.baseUrl) }
    case 'explore':
      return { ...card, focus: scrubber.nullable(card.focus) }
    case 'batch':
      return card
    case 'plan':
      return {
        ...card,
        title: scrubber.text(card.title),
        items: card.items.map((item) => ({
          ...item,
          title: scrubber.text(item.title),
          description: scrubber.text(item.description),
        })),
      }
  }
}

function scrubParts(parts: Array<ChatPart>, scrubber: Scrubber): Array<ChatPart> {
  return parts.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: scrubber.text(part.text) }
      : { type: 'card', card: scrubCard(part.card, scrubber) },
  )
}

/** Add every new outgoing string field to this redaction pass. */
function scrubEvent(event: ChatEvent, scrubber: Scrubber): ChatEvent {
  switch (event.type) {
    case 'message.finished':
      return {
        ...event,
        message: { ...event.message, parts: scrubParts(event.message.parts, scrubber) },
      }
    case 'message.redacted':
      return { ...event, parts: scrubParts(event.parts, scrubber) }
    case 'text.delta':
      return { ...event, text: scrubber.text(event.text) }
    case 'tool.started':
      return { ...event, summary: scrubber.text(event.summary) }
    case 'tool.finished':
      return {
        ...event,
        detail: scrubber.nullable(event.detail),
        cards: event.cards.map((card) => scrubCard(card, scrubber)),
      }
    case 'error':
      return { ...event, message: scrubber.text(event.message) }
    case 'message.started':
    case 'busy':
      return event
  }
}

function tidyParts(parts: Array<ChatPart>): Array<ChatPart> {
  return parts
    .map((part) => (part.type === 'text' ? { ...part, text: part.text.trim() } : part))
    .filter((part) => part.type !== 'text' || part.text.length > 0)
}

export class ProjectChat extends DurableObject<Cloudflare.Env> {
  #busy = false

  #events: Array<ChatEventEnvelope> = []

  /** Clock-based sequences avoid collisions when a client socket survives object eviction. */
  #seq = 0

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)

    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async send(request: ChatTurnRequest): Promise<ChatTurnAck> {
    if (this.#busy) {
      await this.#emit({ type: 'busy', at: Date.now() })
      return { accepted: false, messageId: null, createdAt: null, reason: BUSY_MESSAGE }
    }

    this.#busy = true

    let session: TurnSession
    try {
      session = await this.#openTurn(request)
    } catch (error) {
      this.#busy = false
      throw error
    }

    const work = this.#runTurn(session).finally(() => {
      this.#busy = false
    })

    this.ctx.waitUntil(work)

    return {
      accepted: true,
      messageId: session.userMessage.id,
      createdAt: session.userMessage.createdAt,
      reason: null,
    }
  }

  /** Do not broadcast completion during a live turn: clients would discard its unfinished answer. */
  async announce(request: ChatAnnouncement): Promise<{ messageId: string }> {
    const db = createDb(this.env.DB)

    const [row] = await db
      .select({ id: project.id })
      .from(project)
      .where(
        and(eq(project.id, request.projectId), eq(project.organizationId, request.organizationId)),
      )
      .limit(1)

    if (!row) throw new Error('Project not found.')

    const environments = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.projectId, request.projectId))

    const scrubber = createScrubber(
      await this.#loadSecrets(
        db,
        environments.map((item) => item.id),
      ),
    )

    const parts = scrubParts(tidyParts(request.parts), scrubber)
    const messageId = createId('msg')
    const createdAt = Date.now()

    await db.insert(chatMessage).values({
      id: messageId,
      projectId: request.projectId,
      role: 'assistant',
      parts,
      status: 'complete',
      createdBy: null,
      createdAt: new Date(createdAt),
    })

    if (!this.#busy) {
      await this.#emit({
        type: 'message.finished',
        message: {
          id: messageId,
          role: 'assistant',
          parts,
          status: 'complete',
          createdBy: null,
          createdByName: null,
          createdAt,
        },
        at: createdAt,
      })
    }

    return { messageId }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    this.ctx.acceptWebSocket(server)

    for (const envelope of this.#events) {
      try {
        server.send(JSON.stringify(envelope))
      } catch {
        break
      }
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  override webSocketMessage(): void {}

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code === 1006 ? 1000 : code, reason)
    } catch {}
  }

  override webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'Socket error.')
    } catch {}
  }

  async #openTurn(request: ChatTurnRequest): Promise<TurnSession> {
    this.#events = []
    this.#seq = Math.max(this.#seq, Date.now())

    const db = createDb(this.env.DB)

    const [row] = await db
      .select({
        name: project.name,
        description: project.description,
        context: project.context,
        modelId: project.modelId,
      })
      .from(project)
      .where(
        and(eq(project.id, request.projectId), eq(project.organizationId, request.organizationId)),
      )
      .limit(1)

    if (!row) throw new Error('Project not found.')

    const environments = await db
      .select({
        id: environment.id,
        name: environment.name,
        baseUrl: environment.baseUrl,
        isDefault: environment.isDefault,
      })
      .from(environment)
      .where(eq(environment.projectId, request.projectId))
      .orderBy(environment.createdAt)

    const secrets = await this.#loadSecrets(
      db,
      environments.map((item) => item.id),
    )
    const scrubber = createScrubber(secrets)

    const counts = await this.#countIntents(db, request.projectId)

    const systemPrompt = `${CHAT_SYSTEM_PROMPT}\n\n${buildChatContext({
      projectName: row.name,
      projectDescription: row.description,
      projectContext: row.context,
      environments,
      intentCount: counts.total,
      proposedCount: counts.proposed,
    })}`

    const userMessage: ChatMessageWire = {
      id: createId('msg'),
      role: 'user',
      parts: [{ type: 'text', text: request.text }],
      status: 'complete',
      createdBy: request.userId,
      createdByName: request.userName,
      createdAt: Date.now(),
    }

    await db.insert(chatMessage).values({
      id: userMessage.id,
      projectId: request.projectId,
      role: 'user',
      parts: scrubParts(userMessage.parts, scrubber),
      status: 'complete',
      createdBy: request.userId,
      createdAt: new Date(userMessage.createdAt),
    })

    const session: TurnSession = {
      db,
      request,
      userMessage,
      assistantMessageId: createId('msg'),
      secrets,
      scrubber,
      systemPrompt,
      projectModelId: row.modelId,
      parts: [],
    }

    return session
  }

  async #runTurn(session: TurnSession): Promise<void> {
    const messageId = session.assistantMessageId

    await this.#emit({ type: 'message.started', messageId, at: Date.now() }, session)

    const bus: ChatToolBus = {
      started: (toolCallId, name, summary) =>
        this.#emit({ type: 'tool.started', messageId, toolCallId, name, summary }, session),
      finished: async ({ toolCallId, name, ok, detail, cards }) => {
        for (const card of cards ?? []) session.parts.push({ type: 'card', card })

        await this.#emit(
          {
            type: 'tool.finished',
            messageId,
            toolCallId,
            name,
            ok,
            detail: detail ?? null,
            cards: cards ?? [],
          },
          session,
        )
      },
      liftSecret: (value) => this.#liftSecret(session, value),
      redact: (text) => session.scrubber.text(text),
    }

    let failure: string | null = null
    let modelId: string | null = null
    const usage = { inputTokens: 0, outputTokens: 0 }

    try {
      const resolved = await resolveModel(
        session.db,
        session.projectModelId,
        session.request.organizationId,
        {
          metadata: {
            organizationId: session.request.organizationId,
            projectId: session.request.projectId,
            kind: 'chat',
          },
        },
      )
      modelId = resolved.modelId
      const history = await this.#loadHistory(session)

      await span(
        'model.stream',
        modelSpanAttributes(resolved, session.request.projectId, 'chat'),
        async (set) => {
          const result = streamText({
            model: resolved.model,
            ...(resolved.providerOptions ? { providerOptions: resolved.providerOptions } : {}),
            system: session.systemPrompt,
            messages: history,
            tools: buildChatTools(
              {
                db: session.db,
                projectId: session.request.projectId,
                organizationId: session.request.organizationId,
                userId: session.request.userId,
              },
              bus,
            ),
            stopWhen: stepCountIs(MAX_TOOL_STEPS),
          })

          for await (const part of result.fullStream) {
            if (part.type === 'text-delta') {
              this.#appendText(session, part.text)
              await this.#emit(
                { type: 'text.delta', messageId, text: part.text, at: Date.now() },
                session,
              )
              continue
            }

            if (part.type === 'error') {
              failure = part.error instanceof Error ? part.error.message : String(part.error)
            }
          }

          try {
            const total = await result.totalUsage
            usage.inputTokens = total.inputTokens ?? 0
            usage.outputTokens = total.outputTokens ?? 0
          } catch {}

          set({
            'tokens.input': usage.inputTokens,
            'tokens.output': usage.outputTokens,
            'turn.failed': failure !== null,
          })
        },
      )
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (failure) {
      console.error(`[project-chat] ${session.request.projectId} turn failed:`, failure)

      if (session.parts.length === 0 || session.parts.at(-1)?.type === 'card') {
        session.parts.push({ type: 'text', text: `That did not go through — ${failure}` })
      }
    }

    const message = await this.#persistAssistantMessage(session, failure ? 'error' : 'complete', {
      modelId,
      usage,
    })

    if (failure) {
      await this.#emit({ type: 'error', messageId, message: failure, at: Date.now() }, session)
    }

    await this.#emit({ type: 'message.finished', message, at: Date.now() }, session)
  }

  async #liftSecret(session: TurnSession, value: string): Promise<void> {
    if (session.secrets.includes(value)) return

    session.secrets.push(value)
    session.scrubber = createScrubber(session.secrets)

    session.parts = scrubParts(session.parts, session.scrubber)

    const redacted = scrubParts(session.userMessage.parts, session.scrubber)
    session.userMessage = { ...session.userMessage, parts: redacted }

    await session.db
      .update(chatMessage)
      .set({ parts: redacted })
      .where(eq(chatMessage.id, session.userMessage.id))

    await this.#emit(
      {
        type: 'message.redacted',
        messageId: session.userMessage.id,
        parts: redacted,
        at: Date.now(),
      },
      session,
    )
  }

  async #persistAssistantMessage(
    session: TurnSession,
    status: 'complete' | 'error',
    cost: { modelId: string | null; usage: { inputTokens: number; outputTokens: number } },
  ): Promise<ChatMessageWire> {
    const parts = scrubParts(tidyParts(session.parts), session.scrubber)
    const createdAt = Date.now()

    await session.db.insert(chatMessage).values({
      id: session.assistantMessageId,
      projectId: session.request.projectId,
      role: 'assistant',
      parts,
      status,
      modelId: cost.modelId,
      inputTokens: cost.usage.inputTokens,
      outputTokens: cost.usage.outputTokens,
      createdBy: null,
      createdAt: new Date(createdAt),
    })

    return {
      id: session.assistantMessageId,
      role: 'assistant',
      parts,
      status,
      createdBy: null,
      createdByName: null,
      createdAt,
    }
  }

  async #loadHistory(session: TurnSession): Promise<Array<ModelMessage>> {
    const rows = await session.db
      .select({
        role: chatMessage.role,
        parts: chatMessage.parts,
        createdAt: chatMessage.createdAt,
      })
      .from(chatMessage)
      .where(eq(chatMessage.projectId, session.request.projectId))
      .orderBy(desc(chatMessage.createdAt))
      .limit(HISTORY_LIMIT)

    const messages: Array<ModelMessage> = []

    for (const row of rows.reverse()) {
      const content = renderParts(row.parts)
      if (content.length === 0) continue
      messages.push({ role: row.role, content })
    }

    return messages
  }

  async #loadSecrets(db: Db, environmentIds: Array<string>): Promise<Array<string>> {
    if (environmentIds.length === 0) return []

    const rows = await db
      .select({ encryptedValue: environmentVariable.encryptedValue })
      .from(environmentVariable)
      .where(inArray(environmentVariable.environmentId, environmentIds))

    const values: Array<string> = []

    for (const row of rows) {
      try {
        values.push(await decryptSecret(row.encryptedValue))
      } catch {}
    }

    return values
  }

  async #countIntents(db: Db, projectId: string): Promise<{ total: number; proposed: number }> {
    const [row] = await db
      .select({
        count: sql<number>`count(*)`,
        proposed: sql<number>`sum(case when ${intent.status} = 'proposed' then 1 else 0 end)`,
      })
      .from(intent)
      .where(eq(intent.projectId, projectId))

    const proposed = Number(row?.proposed ?? 0)
    return { total: Number(row?.count ?? 0) - proposed, proposed }
  }

  #appendText(session: TurnSession, text: string): void {
    const last = session.parts.at(-1)
    if (last?.type === 'text') {
      last.text += text
      return
    }
    session.parts.push({ type: 'text', text })
  }

  async #emit(event: ChatEvent, session?: TurnSession): Promise<void> {
    const safe = session ? scrubEvent(event, session.scrubber) : event

    this.#seq += 1
    const envelope: ChatEventEnvelope = { seq: this.#seq, event: safe }

    if (this.#events.length < MAX_BUFFERED) this.#events.push(envelope)

    const payload = JSON.stringify(envelope)
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload)
      } catch {}
    }
  }
}

export { BUSY_MESSAGE }
