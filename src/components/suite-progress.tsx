import { Banner, LinkButton, Loader, Text, useKumoToastManager } from '@cloudflare/kumo'
import { WarningCircleIcon } from '@phosphor-icons/react'
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
  error: { variant: 'error', title: 'Suite finished with errors' },
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
  onFinished?: () => void
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const { data, error } = useQuery({
    ...suiteRunQuery(suiteRunId),
    refetchInterval: (query) => {
      const status = query.state.data?.suiteRun.status
      return status && TERMINAL.has(status) ? false : POLL_INTERVAL_MS
    },
  })

  const suite = data?.suiteRun ?? null
  const done = suite ? suite.passedCount + suite.failedCount + suite.errorCount : 0

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
      description: `${plural(suite.totalCount, 'test')} · ${suite.passedCount} passed · ${suite.failedCount} failed · ${suite.errorCount} errored`,
    })

    void queryClient.invalidateQueries()
    onFinished?.()
  }, [suite, toast, queryClient, onFinished])

  if (!data) {
    if (error)
      return (
        <Banner
          variant="error"
          icon={<WarningCircleIcon />}
          title="Could not load the suite"
          description={error.message}
        />
      )
    return (
      <div className="flex items-center gap-2">
        <Loader size="sm" />
        <Text as="span" variant="secondary" size="base">
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
      {row.errorMessage ? (
        <Banner
          variant="error"
          icon={<WarningCircleIcon />}
          title="Suite execution interrupted"
          description={row.errorMessage}
        />
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <LinkButton
          variant="secondary"
          size="sm"
          href={`/api/reports/suites/${suiteRunId}?format=json`}
        >
          Export JSON
        </LinkButton>
        <LinkButton
          variant="secondary"
          size="sm"
          href={`/api/reports/suites/${suiteRunId}?format=junit`}
        >
          Export JUnit
        </LinkButton>
      </div>
      <SummaryStrip
        items={[
          {
            key: 'status',
            label: 'Suite',
            value: <SuiteRunStatusBadge status={row.status} />,
          },
          {
            key: 'progress',
            label: running ? 'Running' : 'Tests run',
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

      <Text variant="secondary" size="base">
        {running
          ? inFlight
            ? `Running ${inFlight.intentTitle}…`
            : 'Waiting for the next test…'
          : 'Open a test to see its steps, logs and artifacts.'}
      </Text>
    </div>
  )
}
