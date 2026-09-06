import { Button, Loader, Text, cn } from '@cloudflare/kumo'
import { CheckIcon, XIcon } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'

import { Duration } from '#/components/ui/duration.tsx'
import { MonoPanel } from '#/components/ui/mono-panel.tsx'

export interface StepRowData {
  index: number
  label: string
  ok: boolean | null
  durationMs: number | null
  error: string | null
}

export function StepList({
  steps,
  showOffset = false,
}: {
  steps: Array<StepRowData>
  showOffset?: boolean
}) {
  const [expanded, setExpanded] = useState<number | null>(null)

  const rows = useMemo(
    () =>
      steps.map((step, position) => ({
        step,
        offsetMs: steps
          .slice(0, position)
          .reduce((total, previous) => total + (previous.durationMs ?? 0), 0),
      })),
    [steps],
  )

  return (
    <ol className="grid">
      {rows.map(({ step, offsetMs }, position) => (
        <li
          key={step.index}
          className={cn(position > 0 && 'border-t border-kumo-hairline', 'py-2')}
        >
          <StepRow
            step={step}
            offsetMs={showOffset ? offsetMs : null}
            expanded={expanded === step.index}
            onToggle={() => setExpanded((current) => (current === step.index ? null : step.index))}
          />
        </li>
      ))}
    </ol>
  )
}

function StepRow({
  step,
  offsetMs,
  expanded,
  onToggle,
}: {
  step: StepRowData
  offsetMs: number | null
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div className="grid gap-2">
      <div className="flex items-start gap-3">
        {offsetMs === null ? null : (
          <span className="flex h-lh w-14 shrink-0 items-center justify-end tabular-nums">
            <Text as="span" variant="secondary" size="base">
              +{Math.round(offsetMs / 100) / 10}s
            </Text>
          </span>
        )}

        <span className="flex h-lh shrink-0 items-center">
          <StepIcon ok={step.ok} />
        </span>

        <span className="min-w-0 flex-1 break-all">
          <Text as="span" variant="mono-secondary">
            {step.label}
          </Text>
        </span>

        <span className="flex h-lh shrink-0 items-center">
          <Text as="span" size="base">
            <Duration ms={step.durationMs} />
          </Text>
        </span>
      </div>

      {step.error ? (
        <div className={cn('grid gap-2', offsetMs === null ? 'pl-8' : 'pl-25')}>
          {expanded ? null : (
            <Text as="span" variant="error" size="base">
              {step.error.split('\n')[0]}
            </Text>
          )}
          <Button variant="ghost" size="xs" className="justify-self-start" onClick={onToggle}>
            {expanded ? 'Hide detail' : 'Show detail'}
          </Button>
          {expanded ? <MonoPanel label="Error" text={step.error} tone="danger" /> : null}
        </div>
      ) : null}
    </div>
  )
}

function StepIcon({ ok }: { ok: boolean | null }) {
  if (ok === null) {
    return (
      <span className="flex size-5 items-center justify-center rounded-sm bg-kumo-recessed">
        <Loader size={12} />
      </span>
    )
  }

  return (
    <span
      className={cn(
        'flex size-5 items-center justify-center rounded-sm',
        ok ? 'bg-kumo-success-tint text-kumo-success' : 'bg-kumo-danger-tint text-kumo-danger',
      )}
    >
      {ok ? <CheckIcon size={12} weight="bold" /> : <XIcon size={12} weight="bold" />}
    </span>
  )
}
