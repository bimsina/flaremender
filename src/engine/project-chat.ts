/**
 * The project's chat, as an object.
 *
 * One Durable Object per project, addressed by the project id, and the only
 * thing in the system that runs a chat turn. Three jobs, and each one is the
 * reason the other two can be simple:
 *
 * - **It serialises turns.** A conversation with tools that create rows, launch
 *   Workflows and store credentials cannot have two of itself running at once,
 *   and a Durable Object is the cheapest correct way to say so. A second send
 *   while a turn is in flight is refused politely and stores nothing.
 * - **It streams.** Text arrives in fragments, tools announce themselves before
 *   they act, and cards appear the moment the row behind them exists. Sockets
 *   are hibernating, exactly as in `RunChannel`, so a project whose chat is open
 *   in a background tab costs nothing between turns.
 * - **It redacts.** The turn holds the decrypted environment variables of the
 *   project — it has to, because the whole point of credential lifting is that a
 *   value the user pastes into the chat ends up encrypted in an environment and
 *   nowhere else. So every string this object streams or persists goes through
 *   the run engine's scrubber first, and the moment `set_environment_variable`
 *   succeeds the scrubber is rebuilt around the new value and the message that
 *   carried it is rewritten in place.
 *
 * What it deliberately does *not* hold: any provider credential. The model is
 * resolved per turn through `resolveModel`, from the project's own choice down
 * to the instance default, exactly as a generation resolves it.
 *
 * Nothing is written to Durable Object storage. The conversation lives in D1 and
 * the live buffer lives in memory for the length of one turn, which is the only
 * time anything could arrive late enough to need replaying — a page that opens
 * between turns reads the whole history from the database instead.
 */
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
import { resolveModel } from '#/engine/generation/llm.ts'
import { type Scrubber, createScrubber } from '#/engine/runner/scrub.ts'
import { createId } from '#/lib/ids.ts'
import { decryptSecret } from '#/server/crypto.ts'

/** How many past messages the model is shown. Older ones are simply dropped. */
const HISTORY_LIMIT = 30

/**
 * How many tool calls one turn may make. Generous enough to look something up,
 * act on it and report; short of the point where a confused model would work
 * its way through the whole project.
 */
const MAX_TOOL_STEPS = 8

/** How many live events one turn keeps for a page that connects mid-answer. */
const MAX_BUFFERED = 2000

const BUSY_MESSAGE = 'Still working on the previous message — give it a moment and send that again.'

/** What one turn needs, assembled once at the start and dead at the end. */
interface TurnSession {
  db: Db
  request: ChatTurnRequest
  userMessage: ChatMessageWire
  assistantMessageId: string
  /** Decrypted environment values, and the redactor built from them. */
  secrets: Array<string>
  scrubber: Scrubber
  systemPrompt: string
  projectModelId: string | null
  /** The assistant's message as it is being written. Rewritten by redaction. */
  parts: Array<ChatPart>
}

/** How a card reads in the transcript the model is shown next turn. */
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
    // The ids are spelled out because approving a subset is the obvious next
    // request, and this is where the model has to read them from.
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

/** Every string in a card, redacted. Titles are user text and can carry one. */
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

/**
 * The redaction pass every outgoing event goes through.
 *
 * Written out field by field rather than as a walk over JSON, because the set of
 * strings that can carry a secret is small and knowing exactly which ones they
 * are is the point. A field added to `ChatEvent` without a line here is a field
 * the compiler will not complain about — so the rule is that every new string
 * field gets one.
 */
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

/** Empty text is noise in a transcript; a card is never empty. */
function tidyParts(parts: Array<ChatPart>): Array<ChatPart> {
  return parts
    .map((part) => (part.type === 'text' ? { ...part, text: part.text.trim() } : part))
    .filter((part) => part.type !== 'text' || part.text.length > 0)
}

export class ProjectChat extends DurableObject<Cloudflare.Env> {
  /**
   * Whether a turn is running. In memory rather than in storage because it is
   * only meaningful while this instance is alive: a turn cannot outlive the
   * object that is awaiting it.
   */
  #busy = false

  /**
   * The current turn's events, for a page that connects halfway through one.
   *
   * Deliberately not persisted. A text delta is a few bytes and there are
   * hundreds per turn; writing each one to storage would cost more than the
   * model call. Anything worth replaying after the turn ends is in D1.
   */
  #events: Array<ChatEventEnvelope> = []

  /**
   * Seeded from the clock at the start of each turn rather than counted from
   * zero, so a client whose socket survived an eviction never sees a sequence
   * number it has already used.
   */
  #seq = 0

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)

    // Answered by the runtime without waking the object, which is the whole
    // point of a keepalive.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  /**
   * Take a message and answer it.
   *
   * Returns as soon as the user's message is durable — the model turn itself
   * runs in the background and reports over the sockets, because a request
   * handler cannot hold a connection open for the minute a generation takes to
   * be launched and explained.
   */
  async send(request: ChatTurnRequest): Promise<ChatTurnAck> {
    if (this.#busy) {
      await this.#emit({ type: 'busy', at: Date.now() })
      return { accepted: false, messageId: null, createdAt: null, reason: BUSY_MESSAGE }
    }

    // Claimed before the first `await`, so two calls that arrive together
    // cannot both get past this line.
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

    // Keeps the object alive while the model is thinking; without it the
    // instance could be evicted the moment this method returns.
    this.ctx.waitUntil(work)

    return {
      accepted: true,
      messageId: session.userMessage.id,
      createdAt: session.userMessage.createdAt,
      reason: null,
    }
  }

  /**
   * Say something nobody asked for.
   *
   * The one caller is a workflow that finished long after the turn that started
   * it: an exploration takes minutes, and the plan it produces belongs in the
   * conversation that asked for it rather than only on the Intents tab. So the
   * workflow speaks here, through the object that owns the transcript.
   *
   * Two rules make that safe. It **redacts** — the parts were built by a
   * workflow, and this object is the only thing holding the project's decrypted
   * variables, so they go through a scrubber built here whatever the caller
   * already did. And it **yields to a live turn**: broadcasting a finished
   * message while the assistant is mid-answer would make every watching client
   * discard the answer being written, so a busy object persists the message and
   * says nothing, and the clients pick it up from the history — which the
   * exploration card asks for the moment it sees the job finish.
   */
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

  /**
   * The WebSocket upgrade, reached only through `src/server.ts` — which has
   * already established that the caller is signed in and that the project
   * belongs to their organization. Nothing here re-checks that, so nothing else
   * may route to this object.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    this.ctx.acceptWebSocket(server)

    // A page that opens mid-answer sees the answer so far. Between turns this
    // is empty and the history query is what fills the view.
    for (const envelope of this.#events) {
      try {
        server.send(JSON.stringify(envelope))
      } catch {
        break
      }
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  /** The channel is one-way; `ping` never reaches here at all. */
  override webSocketMessage(): void {}

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      // 1006 is "no close frame", which a client cannot send back.
      ws.close(code === 1006 ? 1000 : code, reason)
    } catch {
      // Already gone.
    }
  }

  override webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'Socket error.')
    } catch {
      // Already closed.
    }
  }

  /* ------------------------------------------------------------------ Turn */

  /**
   * Everything that has to be true before the model is called: the project's
   * standing facts, the redactor, and the user's message safely in D1.
   */
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

    // Deliberately not broadcast. See the note on `ChatEvent`: this is the one
    // string that can hold a credential the redactor has not been told about
    // yet, and every other viewer learns of it only once the turn has ended and
    // the redacted row is in D1.
    return session
  }

  /** One `streamText` call, folded into a message. */
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
      // Read through the session rather than captured, so a tool that redacts
      // after `liftSecret` has run uses the rebuilt scrubber and not the one
      // that existed when the turn started.
      redact: (text) => session.scrubber.text(text),
    }

    let failure: string | null = null

    try {
      const resolved = await resolveModel(session.db, session.projectModelId)
      const history = await this.#loadHistory(session)

      const result = streamText({
        model: resolved.model,
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
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (failure) {
      console.error(`[project-chat] ${session.request.projectId} turn failed:`, failure)

      // The failure belongs in the transcript, not only in a toast: a
      // conversation that silently stops answering is unreadable a day later.
      if (session.parts.length === 0 || session.parts.at(-1)?.type === 'card') {
        session.parts.push({ type: 'text', text: `That did not go through — ${failure}` })
      }
    }

    const message = await this.#persistAssistantMessage(session, failure ? 'error' : 'complete')

    if (failure) {
      await this.#emit({ type: 'error', messageId, message: failure, at: Date.now() }, session)
    }

    await this.#emit({ type: 'message.finished', message, at: Date.now() }, session)
  }

  /* -------------------------------------------------------------- Redaction */

  /**
   * A credential has just been stored. Make it disappear.
   *
   * Two things happen, and the second is the one that matters: the redactor is
   * rebuilt so nothing from here on can carry the value, and the message the
   * user typed it into is rewritten in D1 and on every open socket. The value's
   * whole life in this system is the few hundred milliseconds between the user
   * pressing send and this call — after which it exists only as ciphertext.
   *
   * It did, once, cross the network to the configured model provider: it was in
   * the user's message and in the tool call that stored it. That is inherent to
   * lifting a credential out of a sentence, and it is the residual risk this
   * feature accepts.
   */
  async #liftSecret(session: TurnSession, value: string): Promise<void> {
    if (session.secrets.includes(value)) return

    session.secrets.push(value)
    session.scrubber = createScrubber(session.secrets)

    // Anything the assistant has said so far this turn, too — a model that
    // repeated the value before storing it must not leave it in the parts.
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

  /* ------------------------------------------------------------- Persistence */

  async #persistAssistantMessage(
    session: TurnSession,
    status: 'complete' | 'error',
  ): Promise<ChatMessageWire> {
    const parts = scrubParts(tidyParts(session.parts), session.scrubber)
    const createdAt = Date.now()

    await session.db.insert(chatMessage).values({
      id: session.assistantMessageId,
      projectId: session.request.projectId,
      role: 'assistant',
      parts,
      status,
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

  /**
   * The transcript the model is shown.
   *
   * Cards become one-line facts — `[test int_… — "Sign in" — passing]` — which
   * is both the compaction the plan asks for and the reason the model never has
   * to invent an id: every id it has ever been given is still in front of it,
   * without the tool result it originally arrived in.
   */
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

    // The user's message for this turn is already in there — it was inserted
    // before the model was called, on purpose, so a crash mid-turn still leaves
    // a readable conversation.
    return messages
  }

  /* ----------------------------------------------------------------- Wiring */

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
      } catch {
        // A value that will not decrypt cannot leak through this turn either;
        // the environments UI is where an operator finds out about it.
      }
    }

    return values
  }

  /**
   * How many tests the project has, and how many of those are still only
   * proposals — which the assistant needs kept apart, because "you have four
   * tests" and "you have four suggestions nobody has approved" are different
   * answers to the same question.
   */
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

  /**
   * Records an event and tells everyone watching — redacted first, always.
   *
   * The session is optional only for the `busy` refusal, which happens before a
   * turn exists and carries no text of its own.
   */
  async #emit(event: ChatEvent, session?: TurnSession): Promise<void> {
    const safe = session ? scrubEvent(event, session.scrubber) : event

    this.#seq += 1
    const envelope: ChatEventEnvelope = { seq: this.#seq, event: safe }

    if (this.#events.length < MAX_BUFFERED) this.#events.push(envelope)

    const payload = JSON.stringify(envelope)
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload)
      } catch {
        // A socket that died between `getWebSockets()` and here is not this
        // object's problem — the close handler will tidy it up.
      }
    }
  }
}

/** Exported so a caller can recognise the refusal without matching on prose. */
export { BUSY_MESSAGE }
