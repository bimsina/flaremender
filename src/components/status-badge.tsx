import { Badge } from '@cloudflare/kumo'

import type { IntentStatus, RunStatus, ScriptAuthor, SuiteRunStatus } from '#/db/schema/app.ts'

type BadgeVariant = React.ComponentProps<typeof Badge>['variant']

const INTENT: Record<IntentStatus, { label: string; variant: BadgeVariant }> = {
  draft: { label: 'Draft', variant: 'neutral' },
  // Transient, and only ever set by a running `GenerateWorkflow`.
  generating: { label: 'Generating', variant: 'info' },
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

/**
 * A suite's own verdict. No `healed`: healing happens to a member, and a suite
 * that contains one still reads as passed.
 */
const SUITE: Record<SuiteRunStatus, { label: string; variant: BadgeVariant }> = {
  queued: { label: 'Queued', variant: 'neutral' },
  running: { label: 'Running', variant: 'info' },
  passed: { label: 'Passed', variant: 'success' },
  failed: { label: 'Failed', variant: 'error' },
  error: { label: 'Errored', variant: 'warning' },
}

const AUTHOR: Record<ScriptAuthor, { label: string; variant: BadgeVariant }> = {
  user: { label: 'You', variant: 'neutral' },
  agent: { label: 'Agent', variant: 'blue' },
}

export function IntentStatusBadge({ status }: { status: IntentStatus }) {
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

export function SuiteRunStatusBadge({ status }: { status: SuiteRunStatus }) {
  const meta = SUITE[status] ?? SUITE.queued
  return (
    <Badge variant={meta.variant} appearance="dot">
      {meta.label}
    </Badge>
  )
}

/** Who wrote a script version. Phase 2 starts producing `'agent'` rows. */
export function ScriptAuthorBadge({ author }: { author: ScriptAuthor }) {
  const meta = AUTHOR[author] ?? AUTHOR.user
  return (
    <Badge variant={meta.variant} appearance="dot">
      {meta.label}
    </Badge>
  )
}
