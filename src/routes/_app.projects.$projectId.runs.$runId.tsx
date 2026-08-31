/**
 * One run, at its own URL.
 *
 * A run is the thing people send each other — "this is the one that broke" —
 * and a drill-down inside a table row cannot be sent. This page shows exactly
 * what that drill-down shows, from the same component, plus the run-level facts
 * the table row was carrying: which environment, which trigger, which script
 * version, which intent.
 */
import { Breadcrumbs, LinkButton, Text } from '@cloudflare/kumo'
import { TestTubeIcon } from '@phosphor-icons/react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { createLink, createFileRoute } from '@tanstack/react-router'

const RouterLinkButton = createLink(LinkButton)

import { PageBody, PageHeader } from '#/components/page.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { RunDetail } from '#/components/run-detail.tsx'
import { RunLivePanel } from '#/components/run-live-panel.tsx'
import { Section } from '#/components/list.tsx'
import type { RunStatus } from '#/db/schema/app.ts'
import { shortId } from '#/lib/ids.ts'
import { runQuery } from '#/lib/queries.ts'

const TERMINAL: ReadonlySet<RunStatus> = new Set(['passed', 'healed', 'failed', 'error'])

export const Route = createFileRoute('/_app/projects/$projectId/runs/$runId')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData({ ...runQuery(params.runId), revalidateIfStale: true }),
  component: RunPage,
})

function RunPage() {
  const { projectId, runId } = Route.useParams()
  const { data } = useSuspenseQuery(runQuery(runId))

  // A link to a run that is still going should show it going, not a snapshot of
  // the moment the page happened to load.
  const live = !TERMINAL.has(data.run.status)

  return (
    <>
      <PageHeader
        breadcrumbs={
          <Breadcrumbs size="sm">
            <Breadcrumbs.Link href="/projects">Projects</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Link href={`/projects/${projectId}`}>{data.project.name}</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Link href={`/projects/${projectId}?tab=runs`}>Runs</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Current>{shortId(data.run.id)}</Breadcrumbs.Current>
          </Breadcrumbs>
        }
        title={`Run ${shortId(data.run.id)}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Text as="span" variant="secondary">
              {data.intent.title}
            </Text>
            <Text as="span" variant="secondary" size="base">
              · started <RelativeTime value={data.run.startedAt} />
            </Text>
          </span>
        }
        actions={
          <RouterLinkButton
            to="/projects/$projectId/intents/$intentId"
            params={{ projectId, intentId: data.intent.id }}
            variant="secondary"
            icon={TestTubeIcon}
          >
            Open test
          </RouterLinkButton>
        }
      />

      <PageBody className="grid gap-6">
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
