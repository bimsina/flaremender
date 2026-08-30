/**
 * The socket half of watching something happen.
 *
 * A run and a generation job are, on the wire, the same thing: a channel id, a
 * `RunChannel` Durable Object addressed by it, and a stream of sequenced
 * envelopes that replays in full to anyone who connects late. Only the *fallback*
 * differs — a run is polled from the run table, a generation from its job row —
 * so the socket lives here and each hook brings its own way of asking the
 * database instead.
 *
 * Replay is what makes the socket honest: the Durable Object keeps every event
 * for fifteen minutes after the channel finishes, so connecting late is the same
 * as connecting early and a reconnect is not a gap. Each envelope carries a
 * sequence number and anything already seen is dropped, so a replay that
 * overlaps a live broadcast shows each event once.
 */
import { useEffect, useState } from 'react'

import type { RunEventEnvelope } from '#/engine/contract.ts'

/** Matches the Durable Object's ping auto-response, which never wakes it. */
const KEEPALIVE_MS = 30_000

export type LiveTransport = 'connecting' | 'socket' | 'polling'

/**
 * What has been heard on one channel.
 *
 * The channel id is part of the state rather than something an effect resets,
 * because the alternative — clearing the feed after the render that switched
 * channels — paints one frame of the previous channel's events under the new
 * one's heading.
 */
interface Feed {
  channelId: string | null
  envelopes: Array<RunEventEnvelope>
  transport: LiveTransport
}

/** Shared so `useMemo` sees a stable reference while nothing is being watched. */
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
    // Local rather than a ref: every handler below is created by this same
    // effect run, so they all close over this one variable.
    let finished = false

    /** Writes only ever land on this channel's feed, never on a newer one's. */
    const update = (change: (feed: Feed) => Feed) => {
      if (disposed) return
      setFeed((previous) =>
        change(previous.channelId === channelId ? previous : { ...EMPTY, channelId }),
      )
    }

    // A socket that closes *after* the channel finished did its job; only an
    // unfinished one needs the database asked instead.
    const fallBack = () =>
      update((state) => (finished ? state : { ...state, transport: 'polling' }))

    let socket: WebSocket
    try {
      socket = new WebSocket(liveUrl(channelId))
    } catch {
      // A browser that refuses to open the socket at all — a sandboxed frame, a
      // blocked port — is in the same position as one whose socket died.
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

    // Long gaps between steps are normal; some intermediaries read them as a
    // dead connection.
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

/** One step as a panel knows it: `ok` is null while the call is still out. */
export interface LiveStep {
  index: number
  label: string
  ok: boolean | null
  durationMs: number | null
  error: string | null
}

export interface ReducedFeed {
  steps: Array<LiveStep>
  /** Narration lines, oldest first. Only generation produces these today. */
  logs: Array<{ seq: number; line: string }>
  started: boolean
  outcome: 'passed' | 'failed' | 'error' | null
  errorMessage: string | null
}

/** Folds a channel's envelopes into what a panel actually renders. */
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
