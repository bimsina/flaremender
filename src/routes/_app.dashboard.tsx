import { Button, Empty, LayerCard, Table, Text } from '@cloudflare/kumo'
import { ArrowRightIcon, FolderIcon, PlusIcon } from '@phosphor-icons/react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'

import { PageBody, PageHeader, StatTile } from '#/components/page.tsx'
import { RunStatusBadge } from '#/components/status-badge.tsx'
import { formatDuration } from '#/lib/format.ts'
import { RelativeTime } from '#/components/relative-time.tsx'
import { overviewQuery } from '#/lib/queries.ts'

export const Route = createFileRoute('/_app/dashboard')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({ ...overviewQuery(), revalidateIfStale: true }),
  component: Dashboard,
})

function Dashboard() {
  const { session } = Route.useRouteContext()
  const { data } = useSuspenseQuery(overviewQuery())

  const activeOrg = session.organizations.find((org) => org.id === session.activeOrganizationId)
  const passRate = data.tests > 0 ? Math.round((data.passing / data.tests) * 100) : null

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
            label="Test cases"
            value={data.tests}
            hint={passRate === null ? 'No tests yet' : `${passRate}% passing`}
          />
          <StatTile label="Failing" value={data.failing} hint="Need a repair pass" />
          <StatTile label="Total runs" value={data.runs} hint={`${data.pending} not yet run`} />
        </section>

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
              description="Create a project, describe a test case, then generate and run it."
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
                      <Table.Head>Test case</Table.Head>
                      <Table.Head>Project</Table.Head>
                      <Table.Head>Status</Table.Head>
                      <Table.Head>Attempt</Table.Head>
                      <Table.Head>Duration</Table.Head>
                      <Table.Head>When</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {data.recentRuns.map((run) => (
                      <Table.Row key={run.id}>
                        <Table.Cell>
                          <Link
                            to="/projects/$projectId/tests/$testCaseId"
                            params={{ projectId: run.projectId, testCaseId: run.testCaseId }}
                            className="text-kumo-link underline underline-offset-2"
                          >
                            {run.testCaseTitle}
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
                          <RunStatusBadge status={run.status} />
                        </Table.Cell>
                        <Table.Cell>
                          <Text as="span" variant="mono-secondary">
                            #{run.attempt}
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
