/**
 * The script being written, as it is written.
 *
 * Two tracks, side by side down the page: what the model *said* it was doing
 * and what the browser actually did about it. They are shown together because
 * either alone is misleading — narration without steps is a model's account of
 * itself, and steps without narration is a wall of Playwright calls with no
 * explanation of why any of them happened.
 *
 * The panel deliberately reuses `StepList`, so a generation's steps read
 * exactly like a run's. They are the same kind of thing: real calls against a
 * real browser, and the only difference is that these ones were written moments
 * before they ran.
 */
import { Badge, Banner, LayerCard, Loader, Text } from '@cloudflare/kumo'
import { SparkleIcon, WarningCircleIcon } from '@phosphor-icons/react'

import { StepList } from '#/components/step-list.tsx'
import type { LiveTransport } from '#/lib/use-channel-feed.ts'
import { useGenerationLive } from '#/lib/use-generation-live.ts'

const TRANSPORT_LABEL: Record<LiveTransport, string> = {
  connecting: 'Connecting…',
  socket: 'Live',
  polling: 'Polling',
}

export function GenerationLivePanel({ jobId, intentId }: { jobId: string; intentId: string }) {
  const live = useGenerationLive(jobId, intentId)
  const succeeded = live.outcome === 'passed'

  return (
    <LayerCard className="px-5 py-4">
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {live.finished ? <SparkleIcon size={18} /> : <Loader size="sm" />}
            <Text as="h3" variant="heading">
              {live.finished
                ? succeeded
                  ? 'Script generated and verified'
                  : 'Generation did not finish'
                : 'Writing the script'}
            </Text>
          </div>

          <div className="flex items-center gap-2">
            {live.finished ? (
              <Badge variant={succeeded ? 'success' : 'error'} appearance="dot">
                {succeeded ? 'Verified' : 'Incomplete'}
              </Badge>
            ) : (
              <Badge variant="neutral" appearance="dot">
                {TRANSPORT_LABEL[live.transport]}
              </Badge>
            )}
            <Text as="span" variant="mono-secondary" truncate>
              {jobId}
            </Text>
          </div>
        </div>

        {live.errorMessage ? (
          <Banner
            variant={succeeded ? 'default' : 'alert'}
            icon={<WarningCircleIcon weight="fill" />}
            title="Where it got to"
            description={live.errorMessage.split('\n')[0]}
          />
        ) : null}

        {live.logs.length > 0 ? (
          <ol className="grid gap-1.5">
            {live.logs.map((entry) => (
              <li key={entry.seq} className="flex items-start gap-2">
                <span className="mt-[0.35em] size-1.5 shrink-0 rounded-full bg-kumo-accent" />
                <Text as="span" size="xs" variant="secondary">
                  {entry.line}
                </Text>
              </li>
            ))}
          </ol>
        ) : (
          <Text variant="secondary" size="xs">
            {live.transport === 'polling'
              ? 'Live progress is unavailable, so this is being read from the job itself.'
              : live.started
                ? 'Opening a browser and reading the page…'
                : 'Waiting for the generator to start…'}
          </Text>
        )}

        {live.steps.length > 0 ? (
          <div className="grid gap-2 border-t border-kumo-hairline pt-3">
            <Text as="h4" variant="secondary" size="xs">
              Executed against the live page
            </Text>
            <StepList steps={live.steps} />
          </div>
        ) : null}
      </div>
    </LayerCard>
  )
}
