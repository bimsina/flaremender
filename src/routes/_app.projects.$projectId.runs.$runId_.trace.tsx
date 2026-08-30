/**
 * The Playwright trace viewer, full page.
 *
 * The viewer is Playwright's own prebuilt SPA, self-hosted under
 * `public/pw-trace` (synced by scripts/sync-trace-viewer.mjs) and embedded in
 * an iframe. It reads the zip entirely in the browser — nothing leaves this
 * app. The trace URL is signed rather than cookie-authenticated so the
 * viewer's fetches (including its service worker's) need no session context;
 * `getSignedArtifactUrl` re-checks that the key belongs to this run and this
 * organization before signing, so the `key` search param carries no authority
 * of its own.
 */
import { Banner, Breadcrumbs, Button, Loader, Text } from '@cloudflare/kumo'
import { DownloadSimpleIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '#/components/page.tsx'
import { shortId } from '#/lib/ids.ts'
import { getSignedArtifactUrl } from '#/server/runs.ts'

export const Route = createFileRoute('/_app/projects/$projectId/runs/$runId_/trace')({
  validateSearch: (search: Record<string, unknown>) => ({
    key: typeof search.key === 'string' ? search.key : '',
  }),
  component: TracePage,
})

function TracePage() {
  const { projectId, runId } = Route.useParams()
  const { key } = Route.useSearch()

  const signed = useQuery({
    queryKey: ['signed-artifact', runId, key] as const,
    queryFn: () => getSignedArtifactUrl({ data: { runId, key } }),
    enabled: key.length > 0,
    // The signature is short-lived by design; don't reuse a stale one.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Trace"
        description={`Run ${shortId(runId)}`}
        breadcrumbs={
          <Breadcrumbs size="sm">
            <Breadcrumbs.Link href="/projects">Projects</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Link href={`/projects/${projectId}?tab=runs`}>Runs</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Link href={`/projects/${projectId}/runs/${runId}`}>
              {shortId(runId)}
            </Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Current>Trace</Breadcrumbs.Current>
          </Breadcrumbs>
        }
        actions={
          key.length > 0 ? (
            <a href={`/api/artifacts/${key}`} target="_blank" rel="noreferrer">
              <Button variant="secondary" size="sm" icon={<DownloadSimpleIcon size={14} />}>
                Download
              </Button>
            </a>
          ) : undefined
        }
      />

      {key.length === 0 ? (
        <div className="p-6">
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="No trace to show"
            description="This link is missing its trace reference. Open the run and use its Trace button."
          />
        </div>
      ) : signed.isPending ? (
        <div className="flex flex-1 items-center justify-center gap-2">
          <Loader size="sm" />
          <Text as="span" variant="secondary" size="xs">
            Preparing the trace…
          </Text>
        </div>
      ) : signed.error ? (
        <div className="p-6">
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="Could not open this trace"
            description={signed.error.message}
          />
        </div>
      ) : (
        <iframe
          src={`/pw-trace/index.html?trace=${encodeURIComponent(signed.data.url)}`}
          title="Playwright trace viewer"
          className="w-full flex-1 border-0"
        />
      )}
    </div>
  )
}
