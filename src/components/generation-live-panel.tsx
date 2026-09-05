import { Badge, Banner, LayerCard, Loader, Text } from '@cloudflare/kumo'
import { SparkleIcon, WarningCircleIcon } from '@phosphor-icons/react'

import { StepList } from '#/components/step-list.tsx'
import { formatCount } from '#/lib/format.ts'
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
  const repairing = live.kind === 'repair'

  return (
    <LayerCard className="px-5 py-4">
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {live.finished ? <SparkleIcon size={18} /> : <Loader size="sm" />}
            <Text as="h3" variant="heading">
              {live.finished
                ? succeeded
                  ? repairing
                    ? 'Repair verified'
                    : 'Script generated and verified'
                  : repairing
                    ? 'Repair needs attention'
                    : 'Generation needs attention'
                : repairing
                  ? 'Repairing the script'
                  : 'Writing the script'}
            </Text>
          </div>

          <div className="flex items-center gap-2">
            {live.finished ? (
              <Badge variant={succeeded ? 'success' : 'error'} appearance="dot">
                {succeeded ? 'Verified' : 'Needs attention'}
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

        {live.finished && live.cost ? (
          <Text as="p" variant="secondary" size="base">
            <UsageLine {...live.cost} />
          </Text>
        ) : null}

        {live.logs.length > 0 ? (
          <ol className="grid gap-1.5">
            {live.logs.map((entry) => (
              <li key={entry.seq} className="flex items-start gap-2">
                <span className="mt-[0.35em] size-1.5 shrink-0 rounded-full bg-kumo-accent" />
                <Text as="span" size="base" variant="secondary">
                  {entry.line}
                </Text>
              </li>
            ))}
          </ol>
        ) : (
          <Text variant="secondary" size="base">
            {live.transport === 'polling'
              ? 'Live progress is unavailable, so this is being read from the job itself.'
              : live.started
                ? 'Opening a browser and reading the page…'
                : 'Waiting for the generator to start…'}
          </Text>
        )}

        {live.steps.length > 0 ? (
          <div className="grid gap-2 border-t border-kumo-hairline pt-3">
            <Text as="h4" variant="secondary" size="base">
              Executed against the live page
            </Text>
            <StepList steps={live.steps} />
          </div>
        ) : null}
      </div>
    </LayerCard>
  )
}

/** "4 turns · 38.2k tokens in, 1.1k out · anthropic:claude-sonnet-5" */
export function UsageLine({
  turns,
  inputTokens,
  outputTokens,
  modelId,
}: {
  turns: number
  inputTokens: number
  outputTokens: number
  modelId: string | null
}) {
  const parts = [`${turns} turn${turns === 1 ? '' : 's'}`]
  if (inputTokens > 0 || outputTokens > 0) {
    parts.push(`${formatCount(inputTokens)} tokens in, ${formatCount(outputTokens)} out`)
  }
  if (modelId) parts.push(modelId)
  return <>{parts.join(' · ')}</>
}
