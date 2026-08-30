/**
 * Watching a conversation happen.
 *
 * The same idea as `use-channel-feed.ts` — a socket carrying sequenced
 * envelopes, with anything already seen dropped — with one difference that
 * shapes the whole hook: a chat has a *durable* half. The history is fifty rows
 * in D1 and the socket only ever describes the turn happening right now, so this
 * merges the two rather than reducing one of them.
 *
 * The merge rule is simple and matters: a message the socket announced wins
 * until the history query has caught up, and then the two are the same row and
 * deduplicate by id. That is what makes a sent message appear instantly, a
 * streaming answer appear as it is written, and a reload land on exactly the
 * same conversation.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  ChatCard,
  ChatEventEnvelope,
  ChatMessageWire,
  ChatPart,
} from '#/engine/chat/contract.ts'
import {
  chatMessagesQuery,
  environmentsQuery,
  intentsQuery,
  projectRunsQuery,
  suiteRunsQuery,
} from '#/lib/queries.ts'
import type { LiveTransport } from '#/lib/use-channel-feed.ts'
import { sendChatMessage } from '#/server/chat.ts'

/** Matches the Durable Object's ping auto-response, which never wakes it. */
const KEEPALIVE_MS = 30_000

/** How often the history is re-read when the socket will not open. */
const POLL_INTERVAL_MS = 3000

export type { LiveTransport }

/** One tool call, as the transcript shows it while it is happening. */
export interface LiveToolCall {
  toolCallId: string
  name: string
  summary: string
  /** Null while the call is still out. */
  ok: boolean | null
  detail: string | null
}

/** The assistant's message while it is being written. */
export interface PendingMessage {
  id: string
  parts: Array<ChatPart>
  tools: Array<LiveToolCall>
}

interface Feed {
  projectId: string | null
  envelopes: Array<ChatEventEnvelope>
  transport: LiveTransport
}

const NO_ENVELOPES: Array<ChatEventEnvelope> = []
const EMPTY: Feed = { projectId: null, envelopes: NO_ENVELOPES, transport: 'connecting' }

function socketUrl(projectId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/projects/${encodeURIComponent(projectId)}/chat`
}

function parseEnvelope(data: unknown): ChatEventEnvelope | null {
  if (typeof data !== 'string') return null

  try {
    const parsed = JSON.parse(data) as ChatEventEnvelope
    return typeof parsed?.seq === 'number' && typeof parsed?.event?.type === 'string'
      ? parsed
      : null
  } catch {
    return null
  }
}

function useChatSocket(projectId: string): Feed {
  const [feed, setFeed] = useState<Feed>(EMPTY)

  const current = feed.projectId === projectId ? feed : EMPTY

  useEffect(() => {
    let disposed = false

    const update = (change: (feed: Feed) => Feed) => {
      if (disposed) return
      setFeed((previous) =>
        change(previous.projectId === projectId ? previous : { ...EMPTY, projectId }),
      )
    }

    const fallBack = () => update((state) => ({ ...state, transport: 'polling' }))

    let socket: WebSocket
    try {
      socket = new WebSocket(socketUrl(projectId))
    } catch {
      const timer = setTimeout(fallBack, 0)
      return () => {
        disposed = true
        clearTimeout(timer)
      }
    }

    socket.addEventListener('open', () => {
      update((state) => ({ ...state, transport: 'socket' }))
    })

    socket.addEventListener('message', (message: MessageEvent) => {
      const envelope = parseEnvelope(message.data)
      if (!envelope) return

      update((state) =>
        state.envelopes.some((seen) => seen.seq === envelope.seq)
          ? state
          : { ...state, envelopes: [...state.envelopes, envelope].sort((a, b) => a.seq - b.seq) },
      )
    })

    socket.addEventListener('error', fallBack)
    socket.addEventListener('close', fallBack)

    // A turn can be quiet for a minute while a tool runs; some intermediaries
    // read that as a dead connection.
    const keepalive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send('ping')
    }, KEEPALIVE_MS)

    return () => {
      disposed = true
      clearInterval(keepalive)
      socket.close()
    }
  }, [projectId])

  return current
}

interface Reduced {
  /** Finished assistant messages the socket announced, in arrival order. */
  announced: Array<ChatMessageWire>
  pending: PendingMessage | null
  busy: boolean
  error: string | null
  /** Bumped every time a turn ends, so the history query knows to re-read. */
  completedTurns: number
  /**
   * Ids the Durable Object has rewritten, with their redacted parts. Applied to
   * the sender's own optimistic copy, which is the only place the unredacted
   * text ever existed outside the model call.
   */
  redactions: Map<string, Array<ChatPart>>
}

function appendText(parts: Array<ChatPart>, text: string): Array<ChatPart> {
  const last = parts.at(-1)
  if (last?.type === 'text') {
    return [...parts.slice(0, -1), { type: 'text', text: last.text + text }]
  }
  return [...parts, { type: 'text', text }]
}

function appendCards(parts: Array<ChatPart>, cards: Array<ChatCard>): Array<ChatPart> {
  if (cards.length === 0) return parts
  return [...parts, ...cards.map((card): ChatPart => ({ type: 'card', card }))]
}

/**
 * Folds one channel's events into what the transcript renders.
 *
 * The message being written is kept as three flat variables rather than as one
 * nullable object: every event that touches it touches exactly one of the three,
 * and the alternative — reassigning a `PendingMessage | null` from a spread of
 * itself — is a shape TypeScript declines to narrow.
 */
function reduceChat(envelopes: Array<ChatEventEnvelope>): Reduced {
  const announced: Array<ChatMessageWire> = []
  const redactions = new Map<string, Array<ChatPart>>()
  let pendingId: string | null = null
  let pendingParts: Array<ChatPart> = []
  let pendingTools: Array<LiveToolCall> = []
  let busy = false
  let error: string | null = null
  let completedTurns = 0

  for (const { event } of envelopes) {
    switch (event.type) {
      case 'message.started':
        pendingId = event.messageId
        pendingParts = []
        pendingTools = []
        busy = true
        error = null
        break

      case 'text.delta':
        if (pendingId === event.messageId) {
          pendingParts = appendText(pendingParts, event.text)
        }
        break

      case 'tool.started':
        if (pendingId === event.messageId) {
          pendingTools = [
            ...pendingTools,
            {
              toolCallId: event.toolCallId,
              name: event.name,
              summary: event.summary,
              ok: null,
              detail: null,
            },
          ]
        }
        break

      case 'tool.finished':
        if (pendingId === event.messageId) {
          pendingParts = appendCards(pendingParts, event.cards)
          pendingTools = pendingTools.map((call) =>
            call.toolCallId === event.toolCallId
              ? { ...call, ok: event.ok, detail: event.detail }
              : call,
          )
        }
        break

      case 'message.finished':
        announced.push(event.message)
        pendingId = null
        pendingParts = []
        pendingTools = []
        busy = false
        completedTurns += 1
        break

      case 'message.redacted':
        redactions.set(event.messageId, event.parts)
        break

      case 'busy':
        // Nothing was stored, and the composer already told the sender. The
        // event exists so a second viewer's screen does not go quiet.
        break

      case 'error':
        error = event.message
        break

      default:
        break
    }
  }

  const pendingMessage: PendingMessage | null =
    pendingId === null ? null : { id: pendingId, parts: pendingParts, tools: pendingTools }

  return { announced, pending: pendingMessage, busy, error, completedTurns, redactions }
}

export interface ProjectChat {
  /** History, the sender's own message and live messages merged, oldest first. */
  messages: Array<ChatMessageWire>
  pending: PendingMessage | null
  /** A turn is in flight; the composer stays disabled. */
  busy: boolean
  /** Why the last send did not go through, if it did not. */
  sendError: string | null
  /** Why the last turn stopped, if it stopped badly. */
  error: string | null
  transport: LiveTransport
  loading: boolean
  send: (text: string) => void
}

export function useProjectChat(projectId: string): ProjectChat {
  const queryClient = useQueryClient()
  const { envelopes, transport } = useChatSocket(projectId)

  const live = useMemo(() => reduceChat(envelopes), [envelopes])

  /**
   * The sender's own messages, kept locally until the history has them.
   *
   * This is not an optimistic-UI nicety: it is the mechanism that keeps a pasted
   * credential off everybody else's socket. The Durable Object never broadcasts
   * a user message, so this is the only copy of the text as typed, and it lives
   * exactly as long as it takes the turn to end and the history to be re-read.
   */
  const [sent, setSent] = useState<Array<ChatMessageWire>>([])

  const history = useQuery({
    ...chatMessagesQuery(projectId),
    // Only when the socket is not carrying the conversation. With one open the
    // history is re-read at the end of each turn instead.
    refetchInterval: transport === 'polling' ? POLL_INTERVAL_MS : false,
  })

  const mutation = useMutation({
    mutationFn: (text: string) => sendChatMessage({ data: { projectId, text } }),
    onSuccess: (result, text) => {
      setSent((previous) => [
        ...previous,
        {
          id: result.messageId,
          role: 'user',
          parts: [{ type: 'text', text }],
          status: 'complete',
          createdBy: null,
          createdByName: null,
          createdAt: result.createdAt,
        },
      ])
    },
  })

  /**
   * A finished turn has almost certainly changed something else on the page —
   * an intent was created, a run was queued, a variable was stored — and none
   * of those listings know it. Broad on purpose, and cheap: it happens once per
   * turn, not once per token.
   */
  useEffect(() => {
    if (live.completedTurns === 0) return

    void queryClient.invalidateQueries({ queryKey: chatMessagesQuery(projectId).queryKey })
    void queryClient.invalidateQueries({ queryKey: intentsQuery(projectId).queryKey })
    void queryClient.invalidateQueries({ queryKey: environmentsQuery(projectId).queryKey })
    void queryClient.invalidateQueries({ queryKey: suiteRunsQuery(projectId).queryKey })
    void queryClient.invalidateQueries({ queryKey: projectRunsQuery(projectId).queryKey })
  }, [live.completedTurns, projectId, queryClient])

  const messages = useMemo(() => {
    const byId = new Map<string, ChatMessageWire>()

    // Order is the precedence: the local copy is the weakest, because it is the
    // only unredacted one. The socket and then the database overwrite it as soon
    // as either has something to say about the same id.
    for (const message of sent) {
      const redacted = live.redactions.get(message.id)
      byId.set(message.id, redacted ? { ...message, parts: redacted } : message)
    }
    for (const message of live.announced) byId.set(message.id, message)
    for (const message of history.data ?? []) byId.set(message.id, message)

    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
  }, [history.data, live.announced, live.redactions, sent])

  const { mutate, isPending } = mutation

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || live.busy || isPending) return
      mutate(trimmed)
    },
    [live.busy, isPending, mutate],
  )

  return {
    messages,
    pending: live.pending,
    busy: live.busy || mutation.isPending,
    sendError: mutation.error?.message ?? null,
    error: live.error,
    transport,
    loading: history.isPending,
    send,
  }
}
