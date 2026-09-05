import { Button, LayerCard, LinkButton, Select, Text } from '@cloudflare/kumo'
import { PlayIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'

import { Section } from './list.tsx'
import { NewTestMenu } from './new-test-menu.tsx'
import { QuickTestBox } from './quick-test-box.tsx'
import { StatTile } from './page.tsx'
import { RelativeTime } from './relative-time.tsx'
import { RunStatusBadge } from './status-badge.tsx'
import { getProjectOverview } from '#/server/dashboard.ts'

export function ProjectOverview({
  projectId,
  tests,
  environmentId,
  environments,
  onEnvironmentChange,
  onCreateManual,
  onRun,
  running,
}: {
  projectId: string
  tests: Array<{ id: string; status: string; readiness: string; currentVersion: number }>
  environmentId: string | null
  environments: Array<{ id: string; name: string; baseUrl: string; isDefault: boolean }>
  onEnvironmentChange: (value: string | null) => void
  onCreateManual: () => void
  onRun: () => void
  running: boolean
}) {
  const { data, isPending, error } = useQuery({
    queryKey: ['project-overview', projectId, environmentId],
    queryFn: () =>
      getProjectOverview({ data: { projectId, ...(environmentId ? { environmentId } : {}) } }),
    refetchInterval: (query) =>
      query.state.data?.recent.some((row) => row.status === 'queued' || row.status === 'running')
        ? 2500
        : false,
  })
  const ready = tests.filter(
    (test) => test.readiness === 'ready' && test.currentVersion > 0 && test.status !== 'proposed',
  ).length
  const drafts = tests.filter(
    (test) => test.readiness === 'draft' && test.status !== 'proposed',
  ).length
  const target = environments.find((item) => item.id === environmentId)
  const latest = data?.recent.find((row) => row.status !== 'queued' && row.status !== 'running')
  const adopted = tests.filter((test) => test.status !== 'proposed')
  const scripted = adopted.find((test) => test.currentVersion > 0)
  const readyTest = adopted.find((test) => test.readiness === 'ready' && test.currentVersion > 0)
  const setupComplete = data?.hasCompletedRegression === true

  // One next step at a time, in plain words, instead of a checklist of chores.
  const nextStep =
    environments.length === 0
      ? {
          title: 'Point this project at your app',
          description: 'Add an environment with the URL a tester would open first.',
          action: (
            <div>
              <LinkButton
                href={`/projects/${projectId}?tab=environments`}
                variant="primary"
                size="sm"
              >
                Add an environment
              </LinkButton>
            </div>
          ),
        }
      : adopted.length === 0
        ? {
            title: 'What should this app be able to do?',
            description:
              'Say it in a sentence and the agent writes the test in a real browser. Or send it round the app first and let it propose a suite.',
            action: (
              <div className="grid gap-3">
                <QuickTestBox projectId={projectId} />
                <div>
                  <LinkButton href={`/projects/${projectId}?tab=intents`} variant="ghost" size="sm">
                    Or explore the app and write a suite
                  </LinkButton>
                </div>
              </div>
            ),
          }
        : readyTest === undefined
          ? {
              title: scripted
                ? 'Check the first script and mark it ready'
                : 'The first script is on its way',
              description: scripted
                ? 'Ready tests run in suites and on schedules. A generated script that verified is already ready; a hand-written one waits for you.'
                : 'Generated scripts arrive ready once they verify in a fresh browser.',
              action: scripted ? (
                <div>
                  <LinkButton
                    href={`/projects/${projectId}/intents/${scripted.id}`}
                    variant="primary"
                    size="sm"
                  >
                    Open the test
                  </LinkButton>
                </div>
              ) : null,
            }
          : {
              title: 'Run the suite once',
              description: `${ready} ready test${ready === 1 ? '' : 's'} against ${
                target?.name ?? 'the default environment'
              }. After that this card goes away.`,
              action: (
                <div>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<PlayIcon size={16} />}
                    loading={running}
                    disabled={!ready || !environmentId}
                    onClick={onRun}
                  >
                    Run {ready} test{ready === 1 ? '' : 's'}
                  </Button>
                </div>
              ),
            }
  return (
    <div className="grid gap-6">
      {data && !setupComplete ? (
        <LayerCard className="px-5 py-4">
          <div className="grid gap-3">
            <div className="grid gap-1">
              <Text as="h2" variant="heading">
                {nextStep.title}
              </Text>
              <Text variant="secondary">{nextStep.description}</Text>
            </div>
            {nextStep.action}
          </div>
        </LayerCard>
      ) : null}
      <LayerCard className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="grid gap-2">
            <Text as="h2" variant="heading">
              Build confidence in your next release
            </Text>
            <Text variant="secondary">
              Say what the app should be able to do and the agent writes the test. Or write the
              Playwright yourself.
            </Text>
            <div className="mt-2 flex flex-wrap gap-2">
              <NewTestMenu projectId={projectId} onCreateManual={onCreateManual} />
              <Button
                variant="secondary"
                icon={<PlayIcon size={16} />}
                loading={running}
                disabled={!ready || !environmentId}
                onClick={onRun}
              >
                Run {ready} test{ready === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
          <div className="grid min-w-0 gap-2">
            <Select
              aria-label="Overview environment"
              items={environments.map((item) => ({
                value: item.id,
                label: item.name + (item.isDefault ? ' (default)' : ''),
              }))}
              value={environmentId}
              onValueChange={onEnvironmentChange}
              placeholder="Add an environment"
            />
            <div className="break-all">
              <Text variant="secondary">
                {target?.baseUrl ?? 'Configure an environment before executing tests.'}
              </Text>
            </div>
            {!target ? (
              <LinkButton
                size="sm"
                variant="ghost"
                href={`/projects/${projectId}?tab=environments`}
              >
                Set up environment
              </LinkButton>
            ) : null}
          </div>
        </div>
      </LayerCard>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Ready tests" value={ready} hint="Included in suites and schedules" />
        <StatTile
          label="Drafts"
          value={drafts}
          hint="Check individually; excluded from regression results"
        />
        <StatTile
          label="Latest regression"
          value={latest ? <RunStatusBadge status={latest.status} /> : 'No results yet'}
          hint={
            latest ? (
              <RelativeTime value={latest.startedAt} />
            ) : (
              'Generation verification is tracked separately'
            )
          }
        />
      </div>
      {data && data.failures?.length > 0 ? (
        <Section
          title="Recent failures"
          description="Failed runs in this environment, including earlier versions. Open a report to inspect the recorded expectation and evidence."
          actions={
            <LinkButton href={`/projects/${projectId}?tab=runs`} variant="ghost" size="sm">
              View all runs
            </LinkButton>
          }
        >
          <LayerCard className="px-5 py-2">
            {data.failures.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-start justify-between gap-3 border-b border-kumo-hairline py-3 last:border-b-0"
              >
                <div className="grid min-w-0 flex-1 gap-1">
                  <a
                    className="font-medium text-kumo-link"
                    href={`/projects/${projectId}/runs/${row.id}`}
                  >
                    {row.title}
                  </a>
                  <Text variant="secondary">
                    {row.environmentName} · v{row.version} · <RelativeTime value={row.startedAt} />
                  </Text>
                  <div className="line-clamp-2 break-words">
                    <Text variant="error">
                      {row.errorMessage?.split('\n')[0] ??
                        'Open the report for recorded error details.'}
                    </Text>
                  </div>
                </div>
                <RunStatusBadge status={row.status} />
              </div>
            ))}
          </LayerCard>
        </Section>
      ) : null}
      {!data?.failures?.length ? (
        <Section
          title="Recent regression results"
          description="Results for the selected environment and the exact saved versions that ran. Draft checks and AI verification are excluded."
        >
          <LayerCard className="px-5 py-2">
            {isPending ? (
              <div className="py-4">
                <Text variant="secondary">Loading results…</Text>
              </div>
            ) : null}
            {error ? (
              <div className="py-4">
                <Text variant="error">{error.message}</Text>
              </div>
            ) : null}
            {data?.recent.length === 0 ? (
              <div className="py-4">
                <Text variant="secondary">
                  No regression runs yet. Save a test, check the draft and mark it ready.
                </Text>
              </div>
            ) : null}
            {data?.recent.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-hairline py-3 last:border-b-0"
              >
                <div className="grid min-w-0 gap-1">
                  <a
                    className="font-medium text-kumo-link"
                    href={`/projects/${projectId}/runs/${row.id}`}
                  >
                    {row.title}
                  </a>
                  <Text variant="secondary">
                    {row.environmentName} · v{row.version} · <RelativeTime value={row.startedAt} />
                  </Text>
                  {row.errorMessage ? (
                    <div className="line-clamp-2 break-words">
                      <Text variant="error">{row.errorMessage.split('\n')[0]}</Text>
                    </div>
                  ) : null}
                </div>
                <RunStatusBadge status={row.status} />
              </div>
            ))}
          </LayerCard>
        </Section>
      ) : null}
    </div>
  )
}
