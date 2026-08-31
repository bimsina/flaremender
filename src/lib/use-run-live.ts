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
import { readTranscript } from './transcript.ts'

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
  status: RunStatus | null
}

export function useRunLive(runId: string | null, intentId: string): RunLive {
  const queryClient = useQueryClient()
  const poll = useQuery({
    ...runQuery(runId ?? ''),
    enabled: runId !== null,
    refetchInterval: (query) =>
      query.state.data && TERMINAL.has(query.state.data.run.status) ? false : POLL_INTERVAL_MS,
  })
  const { envelopes, transport } = useChannelFeed(
    poll.data && TERMINAL.has(poll.data.run.status) ? null : runId,
  )

  const live = useMemo(() => reduceFeed(envelopes), [envelopes])

  const socketFinished = live.outcome !== null

  const polledStatus = runId === null ? null : (poll.data?.run.status ?? null)
  const finished = socketFinished || (polledStatus !== null && TERMINAL.has(polledStatus))

  useEffect(() => {
    if (runId === null || !finished) return

    void queryClient.invalidateQueries({ queryKey: runQuery(runId).queryKey })
    void queryClient.invalidateQueries({ queryKey: runsQuery(intentId).queryKey })
    void queryClient.invalidateQueries({ queryKey: intentQuery(intentId).queryKey })
  }, [finished, runId, intentId, queryClient])

  return {
    steps:
      polledStatus && TERMINAL.has(polledStatus)
        ? readTranscript(poll.data?.attempts.at(-1)).steps
        : live.steps,
    transport,
    started: live.started || polledStatus !== null,
    finished,
    outcome:
      polledStatus === 'passed' || polledStatus === 'healed'
        ? 'passed'
        : polledStatus === 'failed'
          ? 'failed'
          : polledStatus === 'error'
            ? 'error'
            : live.outcome,
    errorMessage: poll.data?.run.errorMessage ?? live.errorMessage,
    status: polledStatus,
  }
}
