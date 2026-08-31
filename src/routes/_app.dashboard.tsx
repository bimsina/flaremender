import { Table, TablePagination, useTablePagination } from '#/components/table.tsx'
import { LinkButton, Empty, Select, Text } from '@cloudflare/kumo'
import { ArrowRightIcon, FolderIcon, PlusIcon } from '@phosphor-icons/react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createLink, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

const RouterLinkButton = createLink(LinkButton)

import { PageBody, PageHeader, StatTile } from '#/components/page.tsx'
import { ListToolbar } from '#/components/list.tsx'
import { Duration } from '#/components/duration.tsx'
import { RunTrend } from '#/components/run-trend.tsx'
import { RunStatusBadge } from '#/components/status-badge.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { overviewQuery, runTrendQuery } from '#/lib/queries.ts'

export const Route = createFileRoute('/_app/dashboard')({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData({ ...overviewQuery(), revalidateIfStale: true }),
      context.queryClient.ensureQueryData({ ...runTrendQuery(), revalidateIfStale: true }),
    ])
  },
  component: Dashboard,
})

function Dashboard() {
  const { session } = Route.useRouteContext()
  const { data } = useSuspenseQuery(overviewQuery())
  const { data: trend } = useSuspenseQuery(runTrendQuery())
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [sort, setSort] = useState<{
    key: 'test' | 'duration' | 'started'
    direction: 'asc' | 'desc'
  }>({ key: 'started', direction: 'desc' })

  const visibleRuns = data.recentRuns
    .filter((run) => {
      const matchesSearch = `${run.intentTitle} ${run.projectName} ${run.environmentName}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
      return matchesSearch && (status === 'all' || run.status === status)
    })
    .sort((a, b) => {
      const result =
        sort.key === 'test'
          ? a.intentTitle.localeCompare(b.intentTitle)
          : sort.key === 'duration'
            ? (a.durationMs ?? -1) - (b.durationMs ?? -1)
            : new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
      return sort.direction === 'asc' ? result : -result
    })
  const pagination = useTablePagination(
    visibleRuns,
    `${search}:${status}:${sort.key}:${sort.direction}`,
  )
  const sortProps = (key: typeof sort.key) => ({
    direction: sort.key === key ? sort.direction : undefined,
    onSort: () =>
      setSort({ key, direction: sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc' }),
  })
  const clearFilters = () => {
    setSearch('')
    setStatus('all')
  }

  const activeOrg = session.organizations.find((org) => org.id === session.activeOrganizationId)

  const green = data.passedRuns + data.healedRuns
  const passRate = data.runs > 0 ? Math.round((green / data.runs) * 100) : null

  return (
    <>
      <PageHeader
        title={`Welcome back, ${session.user.name.split(' ')[0]}`}
        description={
          activeOrg ? `Suite health for ${activeOrg.name}.` : 'Suite health for this organization.'
        }
        actions={
          <RouterLinkButton to="/projects" variant="primary" icon={PlusIcon}>
            New project
          </RouterLinkButton>
        }
      />

      <PageBody className="grid gap-8">
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Projects" value={data.projects} />
          <StatTile
            label="Tests"
            value={data.intents}
            hint={`${data.passing} passing · ${data.failing} failing`}
          />
          <StatTile
            label="Pass rate"
            value={passRate === null ? '—' : `${passRate}%`}
            hint={
              data.runs === 0
                ? 'Nothing has run yet'
                : `${data.passedRuns} passed · ${data.healedRuns} healed`
            }
          />
          <StatTile
            label="Runs"
            value={data.runs}
            hint={
              data.pending === 0
                ? `${data.failedRuns} failed`
                : `${data.failedRuns} failed · ${data.pending} awaiting regression`
            }
          />
        </section>

        <RunTrend days={trend} />

        <section className="grid gap-3">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="grid gap-1.5">
              <Text as="h2" variant="heading">
                Recent runs
              </Text>
              <Text variant="secondary">The last few executions across every project.</Text>
            </div>
            <RouterLinkButton to="/projects" variant="ghost" size="sm" icon={ArrowRightIcon}>
              All projects
            </RouterLinkButton>
          </div>

          {data.recentRuns.length === 0 ? (
            <Empty
              size="sm"
              icon={<FolderIcon size={32} className="text-kumo-inactive" />}
              title="Nothing has run yet"
              description="Create a project, describe a test, write its script, then run it."
              contents={
                <RouterLinkButton to="/projects" variant="primary" icon={PlusIcon}>
                  Create a project
                </RouterLinkButton>
              }
            />
          ) : (
            <Table
              label="Recent runs"
              footer={<TablePagination {...pagination} />}
              toolbar={
                <ListToolbar
                  value={search}
                  onValueChange={setSearch}
                  placeholder="Search recent runs"
                >
                  <Select
                    aria-label="Filter recent runs by status"
                    className="w-40"
                    value={status}
                    onValueChange={(value: string | null) => setStatus(value ?? 'all')}
                    items={{
                      all: 'All statuses',
                      passed: 'Passed',
                      failed: 'Failed',
                      error: 'Errored',
                      healed: 'Healed',
                      running: 'Running',
                      queued: 'Queued',
                    }}
                  />
                </ListToolbar>
              }
            >
              <Table.Header>
                <Table.Row>
                  <Table.SortHead {...sortProps('test')} className="min-w-72">
                    Test
                  </Table.SortHead>
                  <Table.Head>Project</Table.Head>
                  <Table.Head>Environment</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head className="text-right">Attempts</Table.Head>
                  <Table.SortHead {...sortProps('duration')} className="text-right">
                    Duration
                  </Table.SortHead>
                  <Table.SortHead {...sortProps('started')}>Started</Table.SortHead>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {pagination.items.map((run) => (
                  <Table.Row key={run.id}>
                    <Table.Cell className="min-w-72 max-w-md">
                      <Link
                        to="/projects/$projectId/runs/$runId"
                        params={{ projectId: run.projectId, runId: run.id }}
                        className="table-link"
                      >
                        {run.intentTitle}
                      </Link>
                      <Text variant="secondary" DANGEROUS_className="mt-1">
                        {run.purpose === 'draft-check'
                          ? 'Draft check'
                          : run.purpose === 'generation-verification'
                            ? 'Verification'
                            : 'Regression'}{' '}
                        · v{run.version}
                      </Text>
                    </Table.Cell>
                    <Table.Cell className="min-w-40">
                      <Link
                        to="/projects/$projectId"
                        params={{ projectId: run.projectId }}
                        className="table-link"
                      >
                        {run.projectName}
                      </Link>
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap">
                      <Text as="span" variant="secondary">
                        {run.environmentName}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <RunStatusBadge status={run.status} />
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      <Text as="span" variant="secondary">
                        {run.attemptCount}
                      </Text>
                    </Table.Cell>
                    <Table.Cell className="text-right whitespace-nowrap tabular-nums">
                      <Duration ms={run.durationMs} />
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap text-kumo-subtle">
                      <RelativeTime value={run.startedAt} />
                    </Table.Cell>
                  </Table.Row>
                ))}
                {pagination.items.length === 0 ? (
                  <Table.Empty
                    columns={7}
                    message="No recent runs match your filters"
                    onClear={clearFilters}
                  />
                ) : null}
              </Table.Body>
            </Table>
          )}
        </section>
      </PageBody>
    </>
  )
}
