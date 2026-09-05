import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'

import type { GenerationJobStatus } from '#/db/schema/app.ts'
import type { RunOutcome } from '#/engine/contract.ts'
import {
  intentGenerationQuery,
  jobQuery,
  intentQuery,
  runsQuery,
  scriptVersionsQuery,
} from '#/lib/queries.ts'
import {
  type LiveStep,
  type LiveTransport,
  reduceFeed,
  useChannelFeed,
} from '#/lib/use-channel-feed.ts'

const POLL_INTERVAL_MS = 3000

const TERMINAL: ReadonlySet<GenerationJobStatus> = new Set(['succeeded', 'failed'])

export interface GenerationLive {
  steps: Array<LiveStep>
  logs: Array<{ seq: number; line: string }>
  transport: LiveTransport
  started: boolean
  finished: boolean
  outcome: RunOutcome | null
  errorMessage: string | null
  status: GenerationJobStatus | null
  cost: { turns: number; inputTokens: number; outputTokens: number; modelId: string | null } | null
  kind: 'generate' | 'explore' | 'batch' | 'repair' | null
}

export function useGenerationLive(jobId: string | null, intentId: string): GenerationLive {
  const queryClient = useQueryClient()
  const poll = useQuery({
    ...jobQuery(jobId ?? ''),
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data && TERMINAL.has(query.state.data.status) ? false : POLL_INTERVAL_MS,
  })
  const unavailable = jobId !== null && (poll.isError || (poll.isSuccess && poll.data === null))
  const { envelopes, transport } = useChannelFeed(
    unavailable || (poll.data && TERMINAL.has(poll.data.status)) ? null : jobId,
  )

  const live = useMemo(() => reduceFeed(envelopes), [envelopes])

  const socketFinished = live.outcome !== null

  // Only this job’s status counts; an earlier generation may already be finished.
  const polledStatus = poll.data?.id === jobId ? (poll.data?.status ?? null) : null
  const finished =
    unavailable || socketFinished || (polledStatus !== null && TERMINAL.has(polledStatus))

  useEffect(() => {
    if (jobId === null || !finished) return

    void queryClient.invalidateQueries({ queryKey: intentQuery(intentId).queryKey })
    void queryClient.invalidateQueries({ queryKey: scriptVersionsQuery(intentId).queryKey })
    void queryClient.invalidateQueries({ queryKey: runsQuery(intentId).queryKey })
    void queryClient.invalidateQueries({ queryKey: intentGenerationQuery(intentId).queryKey })
  }, [finished, jobId, intentId, queryClient])

  return {
    steps: live.steps,
    logs: live.logs,
    transport,
    started: live.started || polledStatus !== null,
    finished,
    outcome: unavailable
      ? 'error'
      : polledStatus === 'succeeded'
        ? 'passed'
        : polledStatus === 'failed'
          ? 'failed'
          : live.outcome,
    errorMessage: unavailable
      ? 'Job history is unavailable.'
      : (poll.data?.stuckReason ?? live.errorMessage),
    status: polledStatus,
    kind: poll.data && poll.data.id === jobId ? poll.data.kind : null,
    cost:
      poll.data && poll.data.id === jobId
        ? {
            turns: poll.data.turns,
            inputTokens: poll.data.inputTokens,
            outputTokens: poll.data.outputTokens,
            modelId: poll.data.modelId,
          }
        : null,
  }
}
