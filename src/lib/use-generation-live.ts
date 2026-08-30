/**
 * Watching a script being written.
 *
 * Same stream, same Durable Object and same replay guarantees as a run — see
 * `use-channel-feed.ts` — with two differences that matter to the person
 * watching:
 *
 * - **There is narration.** Every tool call the model makes carries a one-line
 *   explanation of what it is about to do, streamed as a `log` event. Without
 *   it a generation is several minutes of silence punctuated by Playwright
 *   calls, and the reason for each of them is the interesting part.
 * - **The fallback polls the job, not a run.** A generation has no run row for
 *   most of its life; the job row is what says whether it is still going.
 *
 * When it finishes, everything on the page is stale at once — the script, the
 * version history, the intent's badge and the run history, because verification
 * left a real run behind — so the invalidation is broad on purpose.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'

import type { GenerationJobStatus } from '#/db/schema/app.ts'
import type { RunOutcome } from '#/engine/contract.ts'
import {
  intentGenerationQuery,
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
  /** Playwright calls the model's fragments made, as they happen. */
  steps: Array<LiveStep>
  /** The model's own account of what it is doing, oldest first. */
  logs: Array<{ seq: number; line: string }>
  transport: LiveTransport
  started: boolean
  finished: boolean
  outcome: RunOutcome | null
  errorMessage: string | null
  status: GenerationJobStatus | null
}

export function useGenerationLive(jobId: string | null, intentId: string): GenerationLive {
  const queryClient = useQueryClient()
  const { envelopes, transport } = useChannelFeed(jobId)

  const live = useMemo(() => reduceFeed(envelopes), [envelopes])

  const socketFinished = live.outcome !== null

  const poll = useQuery({
    ...intentGenerationQuery(intentId),
    enabled: jobId !== null && transport === 'polling' && !socketFinished,
    refetchInterval: POLL_INTERVAL_MS,
  })

  // Only this job's status counts: a stale row for an earlier generation would
  // otherwise report the panel finished the moment it opened.
  const polledStatus = poll.data?.id === jobId ? (poll.data?.status ?? null) : null
  const finished = socketFinished || (polledStatus !== null && TERMINAL.has(polledStatus))

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
    outcome: live.outcome,
    errorMessage: live.errorMessage,
    status: polledStatus,
  }
}
