/**
 * The run, as it happens.
 *
 * Steps appear the moment the harness makes the call and settle in place when
 * it returns, which is why a step can be listed with no verdict yet — that is
 * the point of the panel. M7 gives this a proper home next to the editor; today
 * it is a card that appears under the header once a run is queued.
 */
import { Badge, Banner, LayerCard, Loader, Text } from '@cloudflare/kumo'
import { CheckCircleIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react'

import { formatDuration } from '#/lib/format.ts'
import { type LiveStep, type LiveTransport, useRunLive } from '#/lib/use-run-live.ts'

const TRANSPORT_LABEL: Record<LiveTransport, string> = {
  connecting: 'Connecting…',
  socket: 'Live',
  polling: 'Polling',
}

export function RunLivePanel({ runId, intentId }: { runId: string; intentId: string }) {
  const live = useRunLive(runId, intentId)

  return (
    <LayerCard className="px-5 py-4">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {live.finished ? null : <Loader size="sm" />}
            <Text as="h2" variant="heading">
              {live.finished ? 'Run finished' : 'Run in progress'}
            </Text>
          </div>

          <div className="flex items-center gap-2">
            {live.finished && live.outcome ? (
              <Badge
                variant={
                  live.outcome === 'passed'
                    ? 'success'
                    : live.outcome === 'failed'
                      ? 'error'
                      : 'warning'
                }
                appearance="dot"
              >
                {live.outcome}
              </Badge>
            ) : (
              <Badge variant="neutral" appearance="dot">
                {TRANSPORT_LABEL[live.transport]}
              </Badge>
            )}
            <Text as="span" variant="mono-secondary" truncate>
              {runId}
            </Text>
          </div>
        </div>

        {live.errorMessage ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="The run did not pass"
            description={live.errorMessage.split('\n')[0]}
          />
        ) : null}

        {live.steps.length === 0 ? (
          <Text variant="secondary" size="xs">
            {live.transport === 'polling'
              ? 'Live progress is unavailable, so this is being read from the run itself.'
              : live.started
                ? 'Waiting for the first step…'
                : 'Waiting for the browser to start…'}
          </Text>
        ) : (
          <ol className="grid gap-1">
            {live.steps.map((step) => (
              <li key={step.index}>
                <StepRow step={step} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </LayerCard>
  )
}

function StepRow({ step }: { step: LiveStep }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0">
        {step.ok === null ? (
          <Loader size={14} />
        ) : step.ok ? (
          <CheckCircleIcon size={14} weight="fill" className="text-kumo-success" />
        ) : (
          <XCircleIcon size={14} weight="fill" className="text-kumo-danger" />
        )}
      </span>

      <span className="grid min-w-0 flex-1 gap-0.5 break-all">
        <Text as="span" variant="mono-secondary">
          {step.label}
        </Text>
        {/* The first line only: Playwright errors run to dozens, and the whole
            thing is on the attempt row once the run lands. */}
        {step.error ? (
          <Text as="span" variant="error" size="xs">
            {step.error.split('\n')[0]}
          </Text>
        ) : null}
      </span>

      <span className="shrink-0 tabular-nums">
        <Text as="span" variant="secondary" size="xs">
          {step.durationMs === null ? '' : formatDuration(step.durationMs)}
        </Text>
      </span>
    </div>
  )
}
