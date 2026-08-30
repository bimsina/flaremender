/**
 * Everything this project has run, in one list.
 *
 * The list interleaves two different things by time: suites, which are one row
 * that opens into the runs inside them, and runs that were started on their
 * own. Suites are not flattened into their members — a "Run all" is one event,
 * and seven rows claiming to be seven separate decisions would misdescribe what
 * happened — and a member run is therefore reachable through its suite rather
 * than listed twice.
 *
 * The filters are server-side, so filtering widens the window rather than
 * narrowing what was already fetched: asking for the failures of a project that
 * has run two hundred times must not mean "the failures among the newest
 * fifty". The one exception is documented on `matchesStatus` below.
 */
import { Button, Empty, LayerCard, Loader, Select, Table, Text } from '@cloudflare/kumo'
import { CaretDownIcon, ClockIcon, PlayIcon, StackIcon } from '@phosphor-icons/react'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Fragment, useMemo, useState } from 'react'

import { Duration } from '#/components/duration.tsx'
import { InlineEmpty, Section } from '#/components/list.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { RunDetailPanel } from '#/components/run-detail.tsx'
import { RunStatusSummary } from '#/components/run-status-summary.tsx'
import { RunTrend } from '#/components/run-trend.tsx'
import { RunStatusBadge, SuiteRunStatusBadge } from '#/components/status-badge.tsx'
import { SuiteProgress } from '#/components/suite-progress.tsx'
import type { RunStatus, RunTrigger, SuiteRunStatus, SuiteTrigger } from '#/db/schema/app.ts'
import { shortId } from '#/lib/ids.ts'
import { projectRunsQuery, runTrendQuery, suiteRunQuery, suiteRunsQuery } from '#/lib/queries.ts'

const STATUS_FILTERS = {
  all: 'Any status',
  passed: 'Passed',
  healed: 'Healed',
  failed: 'Failed',
  error: 'Errored',
  running: 'Running',
} as const

type StatusFilter = keyof typeof STATUS_FILTERS

const TRIGGER_FILTERS = {
  all: 'Any trigger',
  manual: 'Manual',
  schedule: 'Schedule',
} as const

type TriggerFilter = keyof typeof TRIGGER_FILTERS

const TRIGGER_LABEL: Record<string, string> = {
  manual: 'Manual',
  regenerate: 'Regenerated',
  schedule: 'Schedule',
}

interface ProjectRunRow {
  id: string
  status: RunStatus
  trigger: RunTrigger
  suiteRunId: string | null
  startedAt: Date
  intentId: string
  intentTitle: string
  environmentId: string
  environmentName: string
  version: number
  durationMs: number | null
}

interface SuiteRow {
  id: string
  status: SuiteRunStatus
  trigger: SuiteTrigger
  totalCount: number
  passedCount: number
  failedCount: number
  errorCount: number
  startedAt: Date
  finishedAt: Date | null
  environmentId: string
  environmentName: string
}

type Entry =
  | { kind: 'suite'; id: string; startedAt: Date; suite: SuiteRow }
  | { kind: 'run'; id: string; startedAt: Date; run: ProjectRunRow }

/**
 * `running` covers both `queued` and `running`, which is one filter and two
 * values — more than the server function's single-status parameter can take.
 * It is therefore the one filter applied here instead, over the unfiltered
 * window; that window is the newest runs, which is exactly where anything still
 * in flight has to be.
 */
function matchesStatus(status: RunStatus | SuiteRunStatus, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'running') return status === 'running' || status === 'queued'
  return status === filter
}

export function ProjectRunsTab({
  projectId,
  environments,
  liveSuiteRunId,
}: {
  projectId: string
  environments: Array<{ id: string; name: string; isDefault: boolean }>
  /** The suite whose progress belongs above this list, if one is in flight. */
  liveSuiteRunId: string | null
}) {
  const [status, setStatus] = useState<StatusFilter>('all')
  const [environmentId, setEnvironmentId] = useState<string>('all')
  const [trigger, setTrigger] = useState<TriggerFilter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  // The summary describes the project, not the filter — so it reads the
  // unfiltered window. While nothing is filtered this is the same request as
  // the list's, and React Query serves both from one fetch.
  const { data: recent } = useSuspenseQuery(projectRunsQuery(projectId))
  const { data: suiteRuns } = useSuspenseQuery(suiteRunsQuery(projectId))

  // The trend is the project's own fortnight, counted server-side — not a
  // roll-up of the window above, which is the newest fifty runs and could be
  // an afternoon.
  const { data: trend } = useSuspenseQuery(runTrendQuery(projectId))

  const { data: runs, isPending } = useQuery(
    projectRunsQuery(projectId, {
      status: status === 'all' || status === 'running' ? null : status,
      environmentId: environmentId === 'all' ? null : environmentId,
      trigger: trigger === 'all' ? null : trigger,
    }),
  )

  const entries = useMemo((): Array<Entry> => {
    const standalone = (runs ?? [])
      .filter((row) => row.suiteRunId === null && matchesStatus(row.status, status))
      .map((row): Entry => ({ kind: 'run', id: row.id, startedAt: row.startedAt, run: row }))

    const suites = suiteRuns
      .filter((row) => {
        if (!matchesStatus(row.status, status)) return false
        if (environmentId !== 'all' && row.environmentId !== environmentId) return false
        if (trigger !== 'all' && row.trigger !== trigger) return false
        return true
      })
      .map((row): Entry => ({ kind: 'suite', id: row.id, startedAt: row.startedAt, suite: row }))

    return [...standalone, ...suites].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
  }, [runs, suiteRuns, status, environmentId, trigger])

  const environmentItems = useMemo(
    () => [
      { label: 'Any environment', value: 'all' },
      ...environments.map((row) => ({
        label: row.isDefault ? `${row.name} (default)` : row.name,
        value: row.id,
      })),
    ],
    [environments],
  )

  const filtered = status !== 'all' || environmentId !== 'all' || trigger !== 'all'

  if (recent.length === 0 && suiteRuns.length === 0) {
    return (
      <Empty
        icon={<PlayIcon size={48} className="text-kumo-inactive" />}
        title="No runs found"
        description="Save a script on an intent and press Run, or run the whole project at once — every execution lands here."
      />
    )
  }

  return (
    <Section
      title="Runs"
      description="Every execution in this project, newest first. Suites open into the runs inside them."
    >
      <div className="grid gap-4">
        {liveSuiteRunId ? (
          <SuiteProgress key={liveSuiteRunId} suiteRunId={liveSuiteRunId} projectId={projectId} />
        ) : null}

        <RunStatusSummary runs={recent} />

        <RunTrend days={trend} compact />

        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Filter by status"
            className="w-40"
            items={STATUS_FILTERS}
            value={status}
            onValueChange={(value: StatusFilter | null) => setStatus(value ?? 'all')}
          />
          <Select
            aria-label="Filter by environment"
            className="w-52"
            items={environmentItems}
            value={environmentId}
            onValueChange={(value: string | null) => setEnvironmentId(value ?? 'all')}
          />
          <Select
            aria-label="Filter by trigger"
            className="w-40"
            items={TRIGGER_FILTERS}
            value={trigger}
            onValueChange={(value: TriggerFilter | null) => setTrigger(value ?? 'all')}
          />
          {isPending ? <Loader size="sm" /> : null}
        </div>

        {entries.length === 0 ? (
          <LayerCard className="px-5 py-4">
            <InlineEmpty
              message={
                filtered ? 'No runs match these filters.' : 'Nothing has run in this project yet.'
              }
            />
          </LayerCard>
        ) : (
          <LayerCard className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head className="w-0" />
                    <Table.Head>Status</Table.Head>
                    <Table.Head>Started</Table.Head>
                    <Table.Head>Run</Table.Head>
                    <Table.Head>What ran</Table.Head>
                    <Table.Head>Environment</Table.Head>
                    <Table.Head>Trigger</Table.Head>
                    <Table.Head className="text-right">Duration</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {entries.map((entry) =>
                    entry.kind === 'suite' ? (
                      <SuiteEntry
                        key={entry.id}
                        projectId={projectId}
                        suite={entry.suite}
                        open={expanded === entry.id}
                        onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                      />
                    ) : (
                      <RunEntry
                        key={entry.id}
                        projectId={projectId}
                        run={entry.run}
                        open={expanded === entry.id}
                        onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                      />
                    ),
                  )}
                </Table.Body>
              </Table>
            </div>
          </LayerCard>
        )}
      </div>
    </Section>
  )
}

const COLUMNS = 8

function Caret({ open }: { open: boolean }) {
  return <CaretDownIcon size={14} className={open ? 'rotate-180' : '-rotate-90'} />
}

function RunEntry({
  projectId,
  run,
  open,
  onToggle,
}: {
  projectId: string
  run: ProjectRunRow
  open: boolean
  onToggle: () => void
}) {
  return (
    <Fragment>
      <Table.Row>
        <Table.Cell>
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label={open ? 'Hide run detail' : 'Show run detail'}
            onClick={onToggle}
          >
            <Caret open={open} />
          </Button>
        </Table.Cell>
        <Table.Cell>
          <RunStatusBadge status={run.status} />
        </Table.Cell>
        <Table.Cell>
          <RelativeTime value={run.startedAt} />
        </Table.Cell>
        <Table.Cell>
          <Link
            to="/projects/$projectId/runs/$runId"
            params={{ projectId, runId: run.id }}
            className="font-mono text-kumo-link hover:underline"
          >
            {shortId(run.id)}
          </Link>
        </Table.Cell>
        <Table.Cell>
          <Link
            to="/projects/$projectId/intents/$intentId"
            params={{ projectId, intentId: run.intentId }}
            className="text-kumo-link hover:underline"
          >
            {run.intentTitle}
          </Link>{' '}
          <Text as="span" variant="mono-secondary">
            v{run.version}
          </Text>
        </Table.Cell>
        <Table.Cell>{run.environmentName}</Table.Cell>
        <Table.Cell>
          <Text as="span" variant="secondary" size="xs">
            {TRIGGER_LABEL[run.trigger] ?? run.trigger}
          </Text>
        </Table.Cell>
        <Table.Cell className="text-right">
          <Duration ms={run.durationMs} />
        </Table.Cell>
      </Table.Row>
      {open ? (
        <Table.Row>
          <Table.Cell colSpan={COLUMNS} className="bg-kumo-recessed">
            <RunDetailPanel runId={run.id} projectId={projectId} />
          </Table.Cell>
        </Table.Row>
      ) : null}
    </Fragment>
  )
}

function SuiteEntry({
  projectId,
  suite,
  open,
  onToggle,
}: {
  projectId: string
  suite: SuiteRow
  open: boolean
  onToggle: () => void
}) {
  // The span, not the sum: a suite runs its members one after another, so how
  // long it occupied the browser is the wall clock from first to last.
  const spanMs =
    suite.finishedAt === null ? null : suite.finishedAt.getTime() - suite.startedAt.getTime()

  return (
    <Fragment>
      <Table.Row>
        <Table.Cell>
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label={open ? 'Hide suite members' : 'Show suite members'}
            onClick={onToggle}
          >
            <Caret open={open} />
          </Button>
        </Table.Cell>
        <Table.Cell>
          <SuiteRunStatusBadge status={suite.status} />
        </Table.Cell>
        <Table.Cell>
          <RelativeTime value={suite.startedAt} />
        </Table.Cell>
        <Table.Cell>
          <span className="flex items-center gap-1.5">
            <span className="h-lh flex items-center text-kumo-subtle">
              <StackIcon size={14} aria-label="Suite run" />
            </span>
            <Text as="span" variant="mono-secondary">
              {shortId(suite.id)}
            </Text>
          </span>
        </Table.Cell>
        <Table.Cell>
          <Text as="span">
            {suite.totalCount} intent{suite.totalCount === 1 ? '' : 's'} · {suite.passedCount}{' '}
            passed · {suite.failedCount} failed
            {suite.errorCount > 0 ? ` · ${suite.errorCount} errored` : ''}
          </Text>
        </Table.Cell>
        <Table.Cell>{suite.environmentName}</Table.Cell>
        <Table.Cell>
          <span className="flex items-center gap-1.5">
            {suite.trigger === 'schedule' ? (
              <span className="h-lh flex items-center text-kumo-subtle">
                <ClockIcon size={13} aria-label="Started by the schedule" />
              </span>
            ) : null}
            <Text as="span" variant="secondary" size="xs">
              {TRIGGER_LABEL[suite.trigger] ?? suite.trigger}
            </Text>
          </span>
        </Table.Cell>
        <Table.Cell className="text-right">
          <Duration ms={spanMs} />
        </Table.Cell>
      </Table.Row>
      {open ? (
        <Table.Row>
          <Table.Cell colSpan={COLUMNS} className="bg-kumo-recessed">
            <SuiteMembers projectId={projectId} suiteRunId={suite.id} />
          </Table.Cell>
        </Table.Row>
      ) : null}
    </Fragment>
  )
}

/**
 * The runs inside a suite, fetched only when someone opens it.
 *
 * Read from `getSuiteRun` rather than filtered out of the list above: the list
 * is a limited, filtered window, and a suite must show all of its members or it
 * is lying about what it did.
 */
function SuiteMembers({ projectId, suiteRunId }: { projectId: string; suiteRunId: string }) {
  const { data, isPending, error } = useQuery(suiteRunQuery(suiteRunId))

  if (isPending) {
    return (
      <div className="flex items-center gap-2 py-2">
        <Loader size="sm" />
        <Text as="span" variant="secondary" size="xs">
          Loading the suite…
        </Text>
      </div>
    )
  }

  if (error) return <InlineEmpty message={error.message} />
  if (data.members.length === 0) {
    return <InlineEmpty message="This suite has not started an intent yet." />
  }

  return (
    <ol className="grid gap-1 py-1">
      {data.members.map((member) => (
        <li
          key={member.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-kumo-base"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <RunStatusBadge status={member.status} />
            <Link
              to="/projects/$projectId/runs/$runId"
              params={{ projectId, runId: member.id }}
              className="truncate text-kumo-link hover:underline"
            >
              {member.intentTitle}
            </Link>
          </span>
          <span className="flex items-center gap-3">
            <Text as="span" variant="mono-secondary">
              {shortId(member.id)}
            </Text>
            <Duration ms={member.durationMs} />
          </span>
        </li>
      ))}
    </ol>
  )
}
