import { Badge } from '@cloudflare/kumo'

import type { IntentStatus, RunStatus, ScriptAuthor, SuiteRunStatus } from '#/db/schema/app.ts'

type BadgeVariant = React.ComponentProps<typeof Badge>['variant']

const INTENT: Record<IntentStatus, { label: string; variant: BadgeVariant }> = {
  proposed: { label: 'Proposed', variant: 'neutral' },
  draft: { label: 'Draft', variant: 'neutral' },
  generating: { label: 'Generating', variant: 'neutral' },
  ready: { label: 'Ready to run', variant: 'neutral' },
  passing: { label: 'Passing', variant: 'success' },
  failing: { label: 'Failing', variant: 'error' },
}

const RUN: Record<RunStatus, { label: string; variant: BadgeVariant }> = {
  queued: { label: 'Queued', variant: 'neutral' },
  running: { label: 'Running', variant: 'neutral' },
  passed: { label: 'Passed', variant: 'success' },
  healed: { label: 'Healed', variant: 'neutral' },
  failed: { label: 'Failed', variant: 'error' },
  error: { label: 'Errored', variant: 'warning' },
}

const SUITE: Record<SuiteRunStatus, { label: string; variant: BadgeVariant }> = {
  queued: { label: 'Queued', variant: 'neutral' },
  running: { label: 'Running', variant: 'neutral' },
  passed: { label: 'Passed', variant: 'success' },
  failed: { label: 'Failed', variant: 'error' },
  error: { label: 'Errored', variant: 'warning' },
}

const AUTHOR: Record<ScriptAuthor, { label: string; variant: BadgeVariant }> = {
  user: { label: 'User', variant: 'neutral' },
  agent: { label: 'Agent', variant: 'neutral' },
}

export function IntentStatusBadge({ status }: { status: IntentStatus }) {
  const meta = INTENT[status] ?? INTENT.draft
  return (
    <Badge
      variant={meta.variant === 'neutral' ? 'secondary' : meta.variant}
      className="rounded-md text-base"
    >
      {meta.label}
    </Badge>
  )
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const meta = RUN[status] ?? RUN.queued
  return (
    <Badge
      variant={meta.variant === 'neutral' ? 'secondary' : meta.variant}
      className="rounded-md text-base"
    >
      {meta.label}
    </Badge>
  )
}

export function SuiteRunStatusBadge({ status }: { status: SuiteRunStatus }) {
  const meta = SUITE[status] ?? SUITE.queued
  return (
    <Badge
      variant={meta.variant === 'neutral' ? 'secondary' : meta.variant}
      className="rounded-md text-base"
    >
      {meta.label}
    </Badge>
  )
}

export function ScriptAuthorBadge({ author }: { author: ScriptAuthor }) {
  const meta = AUTHOR[author] ?? AUTHOR.user
  return (
    <Badge variant="secondary" className="rounded-md text-base">
      {meta.label}
    </Badge>
  )
}
