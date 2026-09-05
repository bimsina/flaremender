import { Table, TablePagination, useTablePagination } from '#/components/table.tsx'
import { Button, Empty, LinkButton, Loader, Select, Text } from '@cloudflare/kumo'
import { CaretDownIcon, ClockIcon, PlayIcon, StackIcon } from '@phosphor-icons/react'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Fragment, useMemo, useState } from 'react'

import { Duration } from '#/components/duration.tsx'
import { InlineEmpty, ListToolbar, Section } from '#/components/list.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { RunDetailPanel } from '#/components/run-detail.tsx'
import { RunStatusSummary } from '#/components/run-status-summary.tsx'
import { RunTrend } from '#/components/run-trend.tsx'
import { RunStatusBadge, SuiteRunStatusBadge } from '#/components/status-badge.tsx'
import { SuiteProgress } from '#/components/suite-progress.tsx'
import type {
  RunPurpose,
  RunStatus,
  RunTrigger,
  SuiteRunStatus,
  SuiteTrigger,
} from '#/db/schema/app.ts'
import { shortId } from '#/lib/ids.ts'
import { projectRunsQuery, runTrendQuery, suiteRunQuery, suiteRunsQuery } from '#/lib/queries.ts'
import { describePurpose } from '#/lib/format.ts'

const STATUS_FILTERS = {
  all: 'Any status',
  passed: 'Passed',
  failed: 'Failed',
  error: 'Errored',
  running: 'Running',
} as const

type StatusFilter = keyof typeof STATUS_FILTERS

const TRIGGER_FILTERS = {
  all: 'Any trigger',
  manual: 'Manual',
  regenerate: 'Regenerated',
  schedule: 'Schedule',
  webhook: 'Webhook',
} as const

type TriggerFilter = keyof typeof TRIGGER_FILTERS

const TRIGGER_LABEL: Record<string, string> = {
  manual: 'Manual',
  regenerate: 'Regenerated',
  schedule: 'Schedule',
  webhook: 'Webhook',
}

interface ProjectRunRow {
  purpose: RunPurpose
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

function matchesStatus(status: RunStatus | SuiteRunStatus, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'running') return status === 'running' || status === 'queued'
  if (filter === 'passed') return status === 'passed' || status === 'healed'
  return status === filter
}

export function ProjectRunsTab({
  projectId,
  environments,
  liveSuiteRunId,
  search,
  status,
  trigger,
  environmentId,
  onFiltersChange,
}: {
  projectId: string
  environments: Array<{ id: string; name: string; isDefault: boolean }>
  liveSuiteRunId: string | null
  search: string
  status: StatusFilter
  trigger: TriggerFilter
  environmentId: string
  onFiltersChange: (patch: {
    runsQuery?: string
    runStatus?: StatusFilter
    runTrigger?: TriggerFilter
    environmentId?: string
  }) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)

  const { data: recent } = useSuspenseQuery(projectRunsQuery(projectId))
  const { data: suiteRuns } = useSuspenseQuery(suiteRunsQuery(projectId))

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

  const visibleEntries = entries.filter((entry) => {
    const text =
      entry.kind === 'run'
        ? `${entry.id} ${entry.run.intentTitle} ${entry.run.environmentName}`
        : `${entry.id} suite ${entry.suite.environmentName}`
    return text.toLowerCase().includes(search.trim().toLowerCase())
  })
  const pagination = useTablePagination(
    visibleEntries,
    `${status}:${environmentId}:${trigger}:${search}`,
  )
  const clearFilters = () => {
    onFiltersChange({
      runsQuery: undefined,
      runStatus: undefined,
      environmentId: undefined,
      runTrigger: undefined,
    })
  }

  if (recent.length === 0 && suiteRuns.length === 0) {
    return (
      <Empty
        icon={<PlayIcon size={48} className="text-kumo-inactive" />}
        title="No runs found"
        description="Save a script on a test and press Run, or run the whole project at once — every execution lands here."
      />
    )
  }

  return (
    <Section
      title="Runs"
      description="Every execution in this project, newest first. Suites open into the runs inside them."
    >
      <div className="grid min-w-0 grid-cols-1 gap-4">
        {liveSuiteRunId ? (
          <SuiteProgress key={liveSuiteRunId} suiteRunId={liveSuiteRunId} projectId={projectId} />
        ) : null}

        <RunStatusSummary runs={recent.filter((row) => row.purpose === 'regression')} />

        <RunTrend days={trend} compact />

        <Table
          label="Project runs"
          footer={<TablePagination {...pagination} />}
          toolbar={
            <ListToolbar
              value={search}
              onValueChange={(value) => onFiltersChange({ runsQuery: value || undefined })}
              placeholder="Search runs or tests"
            >
              <Select
                aria-label="Filter by status"
                className="w-40"
                items={STATUS_FILTERS}
                value={status}
                onValueChange={(value: StatusFilter | null) =>
                  onFiltersChange({ runStatus: value === 'all' ? undefined : (value ?? undefined) })
                }
              />
              <Select
                aria-label="Filter by environment"
                className="w-52"
                items={environmentItems}
                value={environmentId}
                onValueChange={(value: string | null) =>
                  onFiltersChange({
                    environmentId: value === 'all' ? undefined : (value ?? undefined),
                  })
                }
              />
              <Select
                aria-label="Filter by trigger"
                className="w-40"
                items={TRIGGER_FILTERS}
                value={trigger}
                onValueChange={(value: TriggerFilter | null) =>
                  onFiltersChange({
                    runTrigger: value === 'all' ? undefined : (value ?? undefined),
                  })
                }
              />
              {isPending ? <Loader size="sm" /> : null}
            </ListToolbar>
          }
        >
          <Table.Header>
            <Table.Row>
              <Table.Head className="w-0">
                <span className="sr-only">Expand details</span>
              </Table.Head>
              <Table.Head>Status</Table.Head>
              <Table.Head>Started</Table.Head>
              <Table.Head>Run</Table.Head>
              <Table.Head className="min-w-64">What ran</Table.Head>
              <Table.Head>Environment</Table.Head>
              <Table.Head>Trigger</Table.Head>
              <Table.Head className="text-right">Duration</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {pagination.items.map((entry) =>
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
            {pagination.items.length === 0 ? (
              <Table.Empty
                columns={COLUMNS}
                message={isPending ? 'Loading runs…' : 'No runs match your filters'}
                onClear={isPending ? undefined : clearFilters}
              />
            ) : null}
          </Table.Body>
        </Table>
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
      <Table.Row data-expanded={open}>
        <Table.Cell>
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label={open ? 'Hide run detail' : 'Show run detail'}
            aria-expanded={open}
            aria-controls={`run-detail-${run.id}`}
            onClick={onToggle}
          >
            <Caret open={open} />
          </Button>
        </Table.Cell>
        <Table.Cell>
          <div className="grid gap-1">
            <RunStatusBadge status={run.status} />
            <Text variant="secondary">{describePurpose(run.purpose)}</Text>
          </div>
        </Table.Cell>
        <Table.Cell className="whitespace-nowrap text-kumo-subtle">
          <RelativeTime value={run.startedAt} />
        </Table.Cell>
        <Table.Cell>
          <Link
            to="/projects/$projectId/runs/$runId"
            params={{ projectId, runId: run.id }}
            className="table-link font-mono text-[0.9em]"
          >
            {shortId(run.id)}
          </Link>
        </Table.Cell>
        <Table.Cell className="min-w-64 max-w-md">
          <Link
            to="/projects/$projectId/intents/$intentId"
            params={{ projectId, intentId: run.intentId }}
            className="table-link"
          >
            {run.intentTitle}
          </Link>{' '}
          <Text as="span" variant="mono-secondary">
            v{run.version}
          </Text>
        </Table.Cell>
        <Table.Cell className="whitespace-nowrap text-kumo-subtle">
          {run.environmentName}
        </Table.Cell>
        <Table.Cell>
          <Text as="span" variant="secondary" size="base">
            {TRIGGER_LABEL[run.trigger] ?? run.trigger}
          </Text>
        </Table.Cell>
        <Table.Cell className="text-right whitespace-nowrap tabular-nums">
          <Duration ms={run.durationMs} />
        </Table.Cell>
      </Table.Row>
      {open ? (
        <Table.Row>
          <Table.Cell id={`run-detail-${run.id}`} colSpan={COLUMNS} className="bg-kumo-recessed">
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
  const spanMs =
    suite.finishedAt === null ? null : suite.finishedAt.getTime() - suite.startedAt.getTime()

  return (
    <Fragment>
      <Table.Row data-expanded={open}>
        <Table.Cell>
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label={open ? 'Hide suite members' : 'Show suite members'}
            aria-expanded={open}
            aria-controls={`suite-detail-${suite.id}`}
            onClick={onToggle}
          >
            <Caret open={open} />
          </Button>
        </Table.Cell>
        <Table.Cell>
          <SuiteRunStatusBadge status={suite.status} />
        </Table.Cell>
        <Table.Cell className="whitespace-nowrap text-kumo-subtle">
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
            {suite.totalCount} test{suite.totalCount === 1 ? '' : 's'} · {suite.passedCount} passed
            · {suite.failedCount} failed
            {suite.errorCount > 0 ? ` · ${suite.errorCount} errored` : ''}
          </Text>
        </Table.Cell>
        <Table.Cell className="whitespace-nowrap text-kumo-subtle">
          {suite.environmentName}
        </Table.Cell>
        <Table.Cell className="whitespace-nowrap">
          <span className="flex items-center gap-1.5">
            {suite.trigger === 'schedule' ? (
              <span className="h-lh flex items-center text-kumo-subtle">
                <ClockIcon size={13} aria-label="Started by the schedule" />
              </span>
            ) : null}
            <Text as="span" variant="secondary" size="base">
              {TRIGGER_LABEL[suite.trigger] ?? suite.trigger}
            </Text>
          </span>
        </Table.Cell>
        <Table.Cell className="text-right whitespace-nowrap tabular-nums">
          <Duration ms={spanMs} />
        </Table.Cell>
      </Table.Row>
      {open ? (
        <Table.Row>
          <Table.Cell
            id={`suite-detail-${suite.id}`}
            colSpan={COLUMNS}
            className="bg-kumo-recessed"
          >
            <SuiteMembers projectId={projectId} suiteRunId={suite.id} />
          </Table.Cell>
        </Table.Row>
      ) : null}
    </Fragment>
  )
}

function SuiteMembers({ projectId, suiteRunId }: { projectId: string; suiteRunId: string }) {
  const { data, isPending, error } = useQuery({
    ...suiteRunQuery(suiteRunId),
    refetchInterval: (query) =>
      ['queued', 'running'].includes(query.state.data?.suiteRun.status ?? '') ? 2500 : false,
  })

  if (isPending) {
    return (
      <div className="flex items-center gap-2 py-2">
        <Loader size="sm" />
        <Text as="span" variant="secondary" size="base">
          Loading the suite…
        </Text>
      </div>
    )
  }

  if (error) return <InlineEmpty message={error.message} />

  return (
    <div className="grid gap-3 py-2">
      {data.suiteRun.errorMessage ? (
        <Text variant="error">{data.suiteRun.errorMessage}</Text>
      ) : null}
      {data.members.length === 0 ? (
        <InlineEmpty message="This suite has not started a test yet." />
      ) : null}
      <div className="flex flex-wrap gap-2">
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
    </div>
  )
}
