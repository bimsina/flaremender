import { Badge } from '@cloudflare/kumo'

import type { RunStatus, TestCaseStatus } from '#/db/schema/app.ts'

type BadgeVariant = React.ComponentProps<typeof Badge>['variant']

const TEST_CASE: Record<TestCaseStatus, { label: string; variant: BadgeVariant }> = {
  draft: { label: 'Draft', variant: 'neutral' },
  generating: { label: 'Generating', variant: 'info' },
  ready: { label: 'Ready to run', variant: 'blue' },
  passing: { label: 'Passing', variant: 'success' },
  failing: { label: 'Failing', variant: 'error' },
}

const RUN: Record<RunStatus, { label: string; variant: BadgeVariant }> = {
  queued: { label: 'Queued', variant: 'neutral' },
  running: { label: 'Running', variant: 'info' },
  passed: { label: 'Passed', variant: 'success' },
  failed: { label: 'Failed', variant: 'error' },
  error: { label: 'Errored', variant: 'warning' },
}

export function TestCaseStatusBadge({ status }: { status: TestCaseStatus }) {
  const meta = TEST_CASE[status] ?? TEST_CASE.draft
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
