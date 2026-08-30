/**
 * Watching a run happen.
 *
 * The socket is the fast path, not the only one. Everything a run produces is
 * also in the database, so if the WebSocket never opens — a proxy that strips
 * upgrades, an offline moment, a browser that has run out of connections — the
 * hook falls back to polling the same `getRun` query the page would have used
 * anyway. The panel gets quieter, not broken.
 *
 * The socket itself, and the fold from envelopes to steps, live in
 * `use-channel-feed.ts` and are shared with generation — the two are the same
 * stream from the same Durable Object, and only what they poll when it fails
 * is different.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'

import type { RunStatus } from '#/db/schema/app.ts'
import type { RunOutcome } from '#/engine/contract.ts'
import {
  type LiveStep,
  type LiveTransport,
  reduceFeed,
  useChannelFeed,
} from '#/lib/use-channel-feed.ts'
import { intentQuery, runQuery, runsQuery } from '#/lib/queries.ts'

const POLL_INTERVAL_MS = 2500

const TERMINAL: ReadonlySet<RunStatus> = new Set(['passed', 'healed', 'failed', 'error'])

export type { LiveStep, LiveTransport }

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
 * @param runId The run to watch, or null when nothing is running.
 * @param intentId Which listings to refresh once the run reports a verdict.
 */
export function useRunLive(runId: string | null, intentId: string): RunLive {
  const queryClient = useQueryClient()
  const { envelopes, transport } = useChannelFeed(runId)

  const live = useMemo(() => reduceFeed(envelopes), [envelopes])

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
