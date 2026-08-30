/**
 * Watching a run happen.
 *
 * The socket is the fast path, not the only one. Everything a run produces is
 * also in the database, so if the WebSocket never opens — a proxy that strips
 * upgrades, an offline moment, a browser that has run out of connections — the
 * hook falls back to polling the same `getRun` query the page would have used
 * anyway. The panel gets quieter, not broken.
 *
 * Replay is what makes that honest: the Durable Object keeps every event for
 * fifteen minutes after a run ends, so connecting late is the same as
 * connecting early, and a reconnect is not a gap. Each envelope carries a
 * sequence number and anything already seen is dropped, so a replay that
 * overlaps a live broadcast shows each step once.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'

import type { RunStatus } from '#/db/schema/app.ts'
import type { RunEventEnvelope, RunOutcome } from '#/engine/contract.ts'
import { intentQuery, runQuery, runsQuery } from '#/lib/queries.ts'

/** Matches the Durable Object's ping auto-response, which never wakes it. */
const KEEPALIVE_MS = 30_000
const POLL_INTERVAL_MS = 2500

const TERMINAL: ReadonlySet<RunStatus> = new Set(['passed', 'healed', 'failed', 'error'])

export type LiveTransport = 'connecting' | 'socket' | 'polling'

/** One step as the panel knows it: `ok` is null while the call is still out. */
export interface LiveStep {
  index: number
  label: string
  ok: boolean | null
  durationMs: number | null
  error: string | null
}

export interface RunLive {
  steps: Array<LiveStep>
  transport: LiveTransport
  started: boolean
  finished: boolean
  outcome: RunOutcome | null
  errorMessage: string | null
  /** The run's status as the database has it, once polling has asked. */
  status: RunStatus | null
}

/**
 * What has been heard about one run.
 *
 * The run id is part of the state rather than something an effect resets,
 * because the alternative — clearing the feed after the render that switched
 * runs — paints one frame of the previous run's steps under the new run's
 * heading.
 */
interface Feed {
  runId: string | null
  envelopes: Array<RunEventEnvelope>
  transport: LiveTransport
}

/** Shared so `useMemo` sees a stable reference while nothing is being watched. */
const NO_EVENTS: Array<RunEventEnvelope> = []

const EMPTY: Feed = { runId: null, envelopes: NO_EVENTS, transport: 'connecting' }

function liveUrl(runId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/runs/${encodeURIComponent(runId)}/live`
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

/**
 * @param runId The run to watch, or null when nothing is running.
 * @param intentId Which listings to refresh once the run reports a verdict.
 */
export function useRunLive(runId: string | null, intentId: string): RunLive {
  const queryClient = useQueryClient()
  const [feed, setFeed] = useState<Feed>(EMPTY)

  const current = feed.runId === runId ? feed : EMPTY
  const envelopes = current.envelopes
  const transport = current.transport

  useEffect(() => {
    if (runId === null) return

    let disposed = false
    // Local rather than a ref: every handler below is created by this same
    // effect run, so they all close over this one variable.
    let finished = false

    /** Writes only ever land on this run's feed, never on a newer one's. */
    const update = (change: (feed: Feed) => Feed) => {
      if (disposed) return
      setFeed((previous) => change(previous.runId === runId ? previous : { ...EMPTY, runId }))
    }

    // A socket that closes *after* the run finished did its job; only an
    // unfinished run needs the database asked instead.
    const fallBack = () =>
      update((state) => (finished ? state : { ...state, transport: 'polling' }))

    let socket: WebSocket
    try {
      socket = new WebSocket(liveUrl(runId))
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
  }, [runId])

  const live = useMemo(() => {
    const steps = new Map<number, LiveStep>()
    let started = false
    let outcome: RunOutcome | null = null
    let errorMessage: string | null = null

    for (const { event } of envelopes) {
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
      started,
      outcome,
      errorMessage,
    }
  }, [envelopes])

  const socketFinished = live.outcome !== null

  const poll = useQuery({
    ...runQuery(runId ?? ''),
    enabled: runId !== null && transport === 'polling' && !socketFinished,
    refetchInterval: POLL_INTERVAL_MS,
  })

  const polledStatus = runId === null ? null : (poll.data?.run.status ?? null)
  const finished = socketFinished || (polledStatus !== null && TERMINAL.has(polledStatus))

  useEffect(() => {
    if (runId === null || !finished) return

    // The run row, the history list and the intent's own badge all changed the
    // moment the verdict landed, and none of them know it.
    void queryClient.invalidateQueries({ queryKey: runQuery(runId).queryKey })
    void queryClient.invalidateQueries({ queryKey: runsQuery(intentId).queryKey })
    void queryClient.invalidateQueries({ queryKey: intentQuery(intentId).queryKey })
  }, [finished, runId, intentId, queryClient])

  return {
    steps: live.steps,
    transport,
    started: live.started || polledStatus !== null,
    finished,
    outcome: live.outcome,
    errorMessage: live.errorMessage,
    status: polledStatus,
  }
}
