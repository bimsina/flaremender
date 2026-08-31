import { useEffect, useState } from 'react'

import type { RunEventEnvelope } from '#/engine/contract.ts'

const KEEPALIVE_MS = 30_000

export type LiveTransport = 'connecting' | 'socket' | 'polling'

/** Key state by channel to avoid displaying the previous run’s events during a switch. */
interface Feed {
  channelId: string | null
  envelopes: Array<RunEventEnvelope>
  transport: LiveTransport
}

const NO_EVENTS: Array<RunEventEnvelope> = []

const EMPTY: Feed = { channelId: null, envelopes: NO_EVENTS, transport: 'connecting' }

function liveUrl(channelId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/runs/${encodeURIComponent(channelId)}/live`
}

function parseEnvelope(data: unknown): RunEventEnvelope | null {
  if (typeof data !== 'string') return null

  try {
    const parsed = JSON.parse(data) as RunEventEnvelope
    return typeof parsed?.seq === 'number' && typeof parsed?.event?.type === 'string'
      ? parsed
      : null
  } catch {
    return null
  }
}

export interface ChannelFeed {
  envelopes: Array<RunEventEnvelope>
  transport: LiveTransport
}

export function useChannelFeed(channelId: string | null): ChannelFeed {
  const [feed, setFeed] = useState<Feed>(EMPTY)

  const current = feed.channelId === channelId ? feed : EMPTY

  useEffect(() => {
    if (channelId === null) return

    let disposed = false
    let finished = false

    const update = (change: (feed: Feed) => Feed) => {
      if (disposed) return
      setFeed((previous) =>
        change(previous.channelId === channelId ? previous : { ...EMPTY, channelId }),
      )
    }

    const fallBack = () =>
      update((state) => (finished ? state : { ...state, transport: 'polling' }))

    let socket: WebSocket
    try {
      socket = new WebSocket(liveUrl(channelId))
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

      if (envelope.event.type === 'run.finished') finished = true

      update((state) =>
        state.envelopes.some((seen) => seen.seq === envelope.seq)
          ? state
          : {
              ...state,
              envelopes: [...state.envelopes, envelope].sort((a, b) => a.seq - b.seq),
            },
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
  }, [channelId])

  return { envelopes: current.envelopes, transport: current.transport }
}

export interface LiveStep {
  index: number
  label: string
  ok: boolean | null
  durationMs: number | null
  error: string | null
}

export interface ReducedFeed {
  steps: Array<LiveStep>
  logs: Array<{ seq: number; line: string }>
  started: boolean
  outcome: 'passed' | 'failed' | 'error' | null
  errorMessage: string | null
}

export function reduceFeed(envelopes: Array<RunEventEnvelope>): ReducedFeed {
  const steps = new Map<number, LiveStep>()
  const logs: Array<{ seq: number; line: string }> = []
  let started = false
  let outcome: ReducedFeed['outcome'] = null
  let errorMessage: string | null = null

  for (const { seq, event } of envelopes) {
    switch (event.type) {
      case 'run.started':
        started = true
        break
      case 'step.started':
        steps.set(event.index, {
          index: event.index,
          label: event.label,
          ok: null,
          durationMs: null,
          error: null,
        })
        break
      case 'step.finished':
        steps.set(event.index, {
          index: event.index,
          label: event.step.label,
          ok: event.step.ok,
          durationMs: event.step.durationMs,
          error: event.step.error ?? null,
        })
        break
      case 'log':
        logs.push({ seq, line: event.line })
        break
      case 'run.finished':
        outcome = event.outcome
        errorMessage = event.errorMessage
        break
      default:
        break
    }
  }

  return {
    steps: [...steps.values()].sort((a, b) => a.index - b.index),
    logs,
    started,
    outcome,
    errorMessage,
  }
}
