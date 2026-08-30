/**
 * What a "Run all" looks like while it is happening.
 *
 * A suite runs its members one at a time and can take minutes, so the only
 * useful thing to show is movement: how far through it is, and what it has
 * found so far. The counts come off the `suite_run` row, which the workflow
 * updates after every member — one row read per poll, regardless of how many
 * intents the project has.
 *
 * Polling rather than the `RunChannel` socket on purpose: the channel is
 * per-run, and a suite is not a run. Each member still narrates itself live on
 * its own intent page; this is the view from above.
 */
import { Loader, Text, useKumoToastManager } from '@cloudflare/kumo'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { SuiteRunStatusBadge } from '#/components/status-badge.tsx'
import { SummaryStrip } from '#/components/summary-strip.tsx'
import type { SuiteRunStatus } from '#/db/schema/app.ts'
import { intentsQuery, suiteRunQuery } from '#/lib/queries.ts'

const POLL_INTERVAL_MS = 2500

const TERMINAL: ReadonlySet<SuiteRunStatus> = new Set(['passed', 'failed', 'error'])

const FINAL_TOAST = {
  passed: { variant: 'success', title: 'Suite passed' },
  failed: { variant: 'error', title: 'Suite failed' },
  error: { variant: 'error', title: 'Suite could not finish' },
} as const

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

export function SuiteProgress({
  suiteRunId,
  projectId,
  onFinished,
}: {
  suiteRunId: string
  projectId: string
  /** Fired once, when the suite reaches a verdict. */
  onFinished?: () => void
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const { data } = useQuery({
    ...suiteRunQuery(suiteRunId),
    refetchInterval: (query) => {
      const status = query.state.data?.suiteRun.status
      return status && TERMINAL.has(status) ? false : POLL_INTERVAL_MS
    },
  })

  const suite = data?.suiteRun ?? null
  const done = suite ? suite.passedCount + suite.failedCount + suite.errorCount : 0

  // Two separate signals, because they mean different things: a member landing
  // means the intent list is stale, and the suite ending means everything is.
  const lastDone = useRef(-1)
  const announced = useRef(false)

  useEffect(() => {
    if (!suite || done === lastDone.current) return
    lastDone.current = done
    void queryClient.invalidateQueries({ queryKey: intentsQuery(projectId).queryKey })
  }, [suite, done, projectId, queryClient])

  useEffect(() => {
    if (!suite || announced.current) return

    const final = FINAL_TOAST[suite.status as keyof typeof FINAL_TOAST] as
      | (typeof FINAL_TOAST)[keyof typeof FINAL_TOAST]
      | undefined
    if (!final) return

    announced.current = true
    toast.add({
      variant: final.variant,
      title: final.title,
      description: `${plural(suite.totalCount, 'intent')} · ${suite.passedCount} passed · ${suite.failedCount} failed · ${suite.errorCount} errored`,
    })

    void queryClient.invalidateQueries()
    onFinished?.()
  }, [suite, toast, queryClient, onFinished])

  if (!data) {
    return (
      <div className="flex items-center gap-2">
        <Loader size="sm" />
        <Text as="span" variant="secondary" size="xs">
          Starting the suite…
        </Text>
      </div>
    )
  }

  const row = data.suiteRun
  const running = !TERMINAL.has(row.status)
  const inFlight = data.members.find((member) => member.status === 'running') ?? null

  return (
    <div className="grid gap-2">
      <SummaryStrip
        items={[
          {
            key: 'status',
            label: 'Suite',
            value: <SuiteRunStatusBadge status={row.status} />,
          },
          {
            key: 'progress',
            label: running ? 'Running' : 'Intents run',
            value: (
              <Text as="span" variant="heading">
                {done}
                <span className="text-kumo-subtle">/{row.totalCount}</span>
              </Text>
            ),
          },
          {
            key: 'passed',
            label: 'Passed',
            dim: row.passedCount === 0,
            value: (
              <Text as="span" variant="heading">
                {row.passedCount}
              </Text>
            ),
          },
          {
            key: 'failed',
            label: 'Failed',
            dim: row.failedCount === 0,
            value: (
              <Text as="span" variant="heading">
                {row.failedCount}
              </Text>
            ),
          },
          {
            key: 'error',
            label: 'Errored',
            dim: row.errorCount === 0,
            value: (
              <Text as="span" variant="heading">
                {row.errorCount}
              </Text>
            ),
          },
          {
            key: 'environment',
            label: 'Environment',
            value: <Text as="span">{data.environment.name}</Text>,
          },
        ]}
      />

      <Text variant="secondary" size="xs">
        {running
          ? inFlight
            ? `Running ${inFlight.intentTitle}…`
            : 'Waiting for the next intent…'
          : 'Open an intent to see its steps, logs and artifacts.'}
      </Text>
    </div>
  )
}
