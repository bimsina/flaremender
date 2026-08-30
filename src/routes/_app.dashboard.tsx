import { Button, Empty, LayerCard, Table, Text } from '@cloudflare/kumo'
import { ArrowRightIcon, FolderIcon, PlusIcon } from '@phosphor-icons/react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'

import { PageBody, PageHeader, StatTile } from '#/components/page.tsx'
import { RunTrend } from '#/components/run-trend.tsx'
import { RunStatusBadge } from '#/components/status-badge.tsx'
import { formatDuration } from '#/lib/format.ts'
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

  const activeOrg = session.organizations.find((org) => org.id === session.activeOrganizationId)

  // Healed runs went green, so they count towards the rate — but they are named
  // separately underneath it, because a suite that only passes after repairs is
  // not the same suite as one that passes outright.
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
          <Link to="/projects">
            <Button variant="primary" icon={<PlusIcon size={16} />}>
              New project
            </Button>
          </Link>
        }
      />

      <PageBody className="grid gap-8">
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Projects" value={data.projects} />
          <StatTile
            label="Intents"
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
                : `${data.failedRuns} failed · ${data.pending} never run`
            }
          />
        </section>

        <RunTrend days={trend} />

        <section className="grid gap-3">
          <div className="flex items-end justify-between gap-4">
            <div className="grid gap-1.5">
              <Text as="h2" variant="heading">
                Recent runs
              </Text>
              <Text variant="secondary">The last few executions across every project.</Text>
            </div>
            <Link to="/projects">
              <Button variant="ghost" size="sm" icon={<ArrowRightIcon size={14} />}>
                All projects
              </Button>
            </Link>
          </div>

          {data.recentRuns.length === 0 ? (
            <Empty
              size="sm"
              icon={<FolderIcon size={32} className="text-kumo-inactive" />}
              title="Nothing has run yet"
              description="Create a project, describe an intent, write its script, then run it."
              contents={
                <Link to="/projects">
                  <Button variant="primary" icon={<PlusIcon size={16} />}>
                    Create a project
                  </Button>
                </Link>
              }
            />
          ) : (
            <LayerCard className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Intent</Table.Head>
                      <Table.Head>Project</Table.Head>
                      <Table.Head>Environment</Table.Head>
                      <Table.Head>Status</Table.Head>
                      <Table.Head>Attempts</Table.Head>
                      <Table.Head>Duration</Table.Head>
                      <Table.Head>When</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {data.recentRuns.map((run) => (
                      <Table.Row key={run.id}>
                        <Table.Cell>
                          <Link
                            to="/projects/$projectId/intents/$intentId"
                            params={{ projectId: run.projectId, intentId: run.intentId }}
                            className="text-kumo-link underline underline-offset-2"
                          >
                            {run.intentTitle}
                          </Link>
                        </Table.Cell>
                        <Table.Cell>
                          <Link
                            to="/projects/$projectId"
                            params={{ projectId: run.projectId }}
                            className="text-kumo-link underline underline-offset-2"
                          >
                            {run.projectName}
                          </Link>
                        </Table.Cell>
                        <Table.Cell>
                          <Text as="span" variant="mono-secondary">
                            {run.environmentName}
                          </Text>
                        </Table.Cell>
                        <Table.Cell>
                          <RunStatusBadge status={run.status} />
                        </Table.Cell>
                        <Table.Cell>
                          <Text as="span" variant="mono-secondary">
                            {run.attemptCount}
                          </Text>
                        </Table.Cell>
                        <Table.Cell>{formatDuration(run.durationMs)}</Table.Cell>
                        <Table.Cell>
                          <RelativeTime value={run.startedAt} />
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            </LayerCard>
          )}
        </section>
      </PageBody>
    </>
  )
}
