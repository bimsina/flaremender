import {
  Banner,
  Breadcrumbs,
  Button,
  DropdownMenu,
  LinkButton,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import {
  DownloadSimpleIcon,
  DotsThreeIcon,
  PencilSimpleIcon,
  PlayIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createLink, createFileRoute, useNavigate } from '@tanstack/react-router'

const RouterLinkButton = createLink(LinkButton)

import { PageBody, PageHeader } from '#/components/page.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { RunDetail } from '#/components/run-detail.tsx'
import { RunLivePanel } from '#/components/run-live-panel.tsx'
import { Section } from '#/components/list.tsx'
import type { RunStatus } from '#/db/schema/app.ts'
import { shortId } from '#/lib/ids.ts'
import { runQuery } from '#/lib/queries.ts'
import { runIntent } from '#/server/intents.ts'

const TERMINAL: ReadonlySet<RunStatus> = new Set(['passed', 'healed', 'failed', 'error'])

export const Route = createFileRoute('/_app/projects/$projectId/runs/$runId')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData({ ...runQuery(params.runId), revalidateIfStale: true }),
  component: RunPage,
})

function RunPage() {
  const { projectId, runId } = Route.useParams()
  const { data } = useSuspenseQuery(runQuery(runId))
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const live = !TERMINAL.has(data.run.status)
  const recordedError = data.attempts.at(-1)?.errorMessage ?? data.run.errorMessage ?? ''
  const traceKey = data.attempts.at(-1)?.artifactKeys?.trace
  const missingVariable = recordedError.match(
    /No environment variable named ["']([A-Z][A-Z0-9_]*)["']/i,
  )?.[1]
  const environmentProblem = /ERR_(?:CONNECTION|NAME)|ECONNREFUSED|unreachable|base URL/i.test(
    recordedError,
  )
  const testProblem = /locator|expect\(|assert|timeout/i.test(recordedError)

  const rerun = useMutation({
    mutationFn: () =>
      runIntent({
        data: {
          intentId: data.intent.id,
          scriptVersionId: data.scriptVersion.id,
          environmentId: data.environment.id,
        },
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      await navigate({
        to: '/projects/$projectId/runs/$runId',
        params: { projectId, runId: result.runId },
      })
    },
    onError: (error: Error) =>
      toast.add({
        variant: 'error',
        title: 'Could not run the test again',
        description: error.message,
      }),
  })

  return (
    <>
      <PageHeader
        breadcrumbs={
          <Breadcrumbs size="base">
            <Breadcrumbs.Link href="/projects">Projects</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Link href={`/projects/${projectId}`}>{data.project.name}</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Link href={`/projects/${projectId}?tab=runs`}>Runs</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Current>{shortId(data.run.id)}</Breadcrumbs.Current>
          </Breadcrumbs>
        }
        title={data.intent.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Text as="span" variant="secondary">
              Run {shortId(data.run.id)}
            </Text>
            <Text as="span" variant="secondary" size="base">
              · started <RelativeTime value={data.run.startedAt} />
            </Text>
          </span>
        }
        actions={
          <>
            <Button
              variant="primary"
              icon={<PlayIcon size={16} />}
              loading={rerun.isPending}
              disabled={live}
              onClick={() => rerun.mutate()}
            >
              Run again
            </Button>
            <RouterLinkButton
              to="/projects/$projectId/intents/$intentId"
              params={{ projectId, intentId: data.intent.id }}
              variant="secondary"
              icon={PencilSimpleIcon}
            >
              Edit test
            </RouterLinkButton>
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <Button variant="secondary" shape="square" aria-label="Download run report">
                    <DotsThreeIcon size={16} weight="bold" />
                  </Button>
                }
              />
              <DropdownMenu.Content>
                <DropdownMenu.LinkItem
                  href={`/api/reports/runs/${data.run.id}?format=json`}
                  icon={DownloadSimpleIcon}
                >
                  Export JSON
                </DropdownMenu.LinkItem>
                <DropdownMenu.LinkItem
                  href={`/api/reports/runs/${data.run.id}?format=junit`}
                  icon={DownloadSimpleIcon}
                >
                  Export JUnit
                </DropdownMenu.LinkItem>
              </DropdownMenu.Content>
            </DropdownMenu>
          </>
        }
      />

      <PageBody className="grid gap-6">
        {missingVariable ? (
          <Banner
            variant="alert"
            icon={<WarningCircleIcon weight="fill" />}
            title={`Add ${missingVariable} to ${data.environment.name}`}
            description="This run stopped before the test could continue because the selected environment does not have the required value."
            action={
              <RouterLinkButton
                to="/projects/$projectId"
                params={{ projectId }}
                search={{
                  tab: 'environments',
                  environmentId: data.environment.id,
                  variable: missingVariable,
                }}
                variant="secondary"
                size="sm"
              >
                Add variable
              </RouterLinkButton>
            }
          />
        ) : environmentProblem ? (
          <Banner
            variant="alert"
            icon={<WarningCircleIcon weight="fill" />}
            title="Check this environment's base URL"
            description="The browser could not reach the recorded target. Confirm that it is available from the runner."
            action={
              <RouterLinkButton
                to="/projects/$projectId"
                params={{ projectId }}
                search={{
                  tab: 'environments',
                  environmentId: data.environment.id,
                  editEnvironment: 'edit',
                }}
                variant="secondary"
                size="sm"
              >
                Edit environment
              </RouterLinkButton>
            }
          />
        ) : testProblem ? (
          <Banner
            variant="alert"
            icon={<WarningCircleIcon weight="fill" />}
            title="Review the failing step"
            description="The recorded locator or expectation did not complete. Inspect the trace, then update the test if the application changed."
            action={
              traceKey ? (
                <RouterLinkButton
                  to="/projects/$projectId/runs/$runId/trace"
                  params={{ projectId, runId }}
                  search={{ key: traceKey }}
                  variant="secondary"
                  size="sm"
                >
                  Open trace
                </RouterLinkButton>
              ) : undefined
            }
          />
        ) : null}
        {live ? (
          <Section title="Live" description="Steps appear as the browser makes them.">
            <RunLivePanel key={data.run.id} runId={data.run.id} intentId={data.intent.id} />
          </Section>
        ) : null}

        <RunDetail data={data} projectId={projectId} variant="page" />
      </PageBody>
    </>
  )
}
