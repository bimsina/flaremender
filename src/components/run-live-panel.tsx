/**
 * The run, as it happens.
 *
 * Steps appear the moment the harness makes the call and settle in place when
 * it returns, which is why a step can be listed with no verdict yet — that is
 * the point of the panel. It lives on the Script tab, directly under the
 * editor, so the code and what it is doing are on one screen.
 */
import { Badge, Banner, LayerCard, Loader, Text } from '@cloudflare/kumo'
import { WarningCircleIcon } from '@phosphor-icons/react'

import { StepList } from '#/components/step-list.tsx'
import { type LiveTransport, useRunLive } from '#/lib/use-run-live.ts'

const TRANSPORT_LABEL: Record<LiveTransport, string> = {
  connecting: 'Connecting…',
  socket: 'Live',
  polling: 'Polling',
}

const OUTCOME_LABEL = { passed: 'Passed', failed: 'Failed', error: 'Errored' } as const

export function RunLivePanel({ runId, intentId }: { runId: string; intentId: string }) {
  const live = useRunLive(runId, intentId)

  return (
    <LayerCard className="px-5 py-4">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {live.finished ? null : <Loader size="sm" />}
            <Text as="h3" variant="heading">
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
                {OUTCOME_LABEL[live.outcome]}
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
          <StepList steps={live.steps} />
        )}
      </div>
    </LayerCard>
  )
}
