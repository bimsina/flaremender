import { Badge } from '@cloudflare/kumo'

import type { IntentStatus, RunStatus } from '#/db/schema/app.ts'

type BadgeVariant = React.ComponentProps<typeof Badge>['variant']

const INTENT: Record<IntentStatus, { label: string; variant: BadgeVariant }> = {
  draft: { label: 'Draft', variant: 'neutral' },
  ready: { label: 'Ready to run', variant: 'blue' },
  passing: { label: 'Passing', variant: 'success' },
  failing: { label: 'Failing', variant: 'error' },
}

const RUN: Record<RunStatus, { label: string; variant: BadgeVariant }> = {
  queued: { label: 'Queued', variant: 'neutral' },
  running: { label: 'Running', variant: 'info' },
  passed: { label: 'Passed', variant: 'success' },
  // A healed run passed, but only after a repair — never collapse the two.
  healed: { label: 'Healed', variant: 'blue' },
  failed: { label: 'Failed', variant: 'error' },
  error: { label: 'Errored', variant: 'warning' },
}

// M4: renamed to `IntentStatusBadge` when the routes are rewritten.
export function TestCaseStatusBadge({ status }: { status: IntentStatus }) {
  const meta = INTENT[status] ?? INTENT.draft
  return (
    <Badge variant={meta.variant} appearance="dot">
      {meta.label}
    </Badge>
  )
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const meta = RUN[status] ?? RUN.queued
  return (
    <Badge variant={meta.variant} appearance="dot">
      {meta.label}
    </Badge>
  )
}
