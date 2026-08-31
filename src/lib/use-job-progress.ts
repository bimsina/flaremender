import { useQuery } from '@tanstack/react-query'

import { jobQuery } from './queries.ts'
import { reduceFeed, useChannelFeed } from './use-channel-feed.ts'

/** Persisted state owns completion; an expired event channel is not a running job. */
export function useJobProgress(jobId: string) {
  const query = useQuery({
    ...jobQuery(jobId),
    refetchInterval: (state) => {
      const status = state.state.data?.status
      return status === 'queued' || status === 'running' ? 2500 : false
    },
  })
  const active = query.data?.status === 'queued' || query.data?.status === 'running'
  const feed = useChannelFeed(active ? jobId : null)
  const streamed = reduceFeed(feed.envelopes)
  const job = query.data
  const unavailable = query.isError || (query.isSuccess && job === null)
  const outcome =
    job?.status === 'succeeded'
      ? ('passed' as const)
      : job?.status === 'failed'
        ? ('failed' as const)
        : unavailable
          ? ('error' as const)
          : streamed.outcome

  return {
    job,
    transport: query.isPending ? 'loading' : feed.transport,
    live: {
      ...streamed,
      outcome,
      errorMessage:
        job?.stuckReason ?? (unavailable ? 'Job history is unavailable.' : streamed.errorMessage),
    },
  }
}
