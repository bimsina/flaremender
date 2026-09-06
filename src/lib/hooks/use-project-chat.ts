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
import type { LiveTransport } from '#/lib/hooks/use-channel-feed.ts'
import { sendChatMessage } from '#/server/projects/chat.ts'

const KEEPALIVE_MS = 30_000

const POLL_INTERVAL_MS = 3000

export type { LiveTransport }

export interface LiveToolCall {
  toolCallId: string
  name: string
  summary: string
  ok: boolean | null
  detail: string | null
}

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
  announced: Array<ChatMessageWire>
  pending: PendingMessage | null
  busy: boolean
  error: string | null
  completedTurns: number
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
  messages: Array<ChatMessageWire>
  pending: PendingMessage | null
  busy: boolean
  sendError: string | null
  error: string | null
  transport: LiveTransport
  loading: boolean
  send: (text: string) => void
}

export function useProjectChat(projectId: string): ProjectChat {
  const queryClient = useQueryClient()
  const { envelopes, transport } = useChatSocket(projectId)

  const live = useMemo(() => reduceChat(envelopes), [envelopes])

  /** Keep unredacted user messages local until persisted redaction replaces them. */
  const [sent, setSent] = useState<Array<ChatMessageWire>>([])

  const history = useQuery({
    ...chatMessagesQuery(projectId),
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

    // Redacted socket and database copies must overwrite the sender’s unredacted local copy.
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
