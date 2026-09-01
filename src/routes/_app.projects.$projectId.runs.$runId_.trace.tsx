import { Banner, Breadcrumbs, LinkButton, Loader, Text } from '@cloudflare/kumo'
import { DownloadSimpleIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'

import { PageHeader } from '#/components/page.tsx'
import { shortId } from '#/lib/ids.ts'
import { type ResolvedTheme, useTheme } from '#/lib/theme.tsx'
import { getSignedArtifactUrl } from '#/server/runs.ts'

export const Route = createFileRoute('/_app/projects/$projectId/runs/$runId_/trace')({
  validateSearch: (search: Record<string, unknown>) => ({
    key: typeof search.key === 'string' ? search.key : '',
  }),
  component: TracePage,
})

const VIEWER_THEME: Record<ResolvedTheme, string> = {
  light: 'light-mode',
  dark: 'dark-mode',
}

const VIEWER_VARS: Record<string, string> = {
  '--vscode-editor-background': '--color-kumo-base',
  '--vscode-sideBar-background': '--color-kumo-canvas',
  '--vscode-panel-background': '--color-kumo-base',
  '--vscode-titleBar-activeBackground': '--color-kumo-canvas',
  '--vscode-titleBar-inactiveBackground': '--color-kumo-canvas',
  '--vscode-titleBar-activeForeground': '--text-color-kumo-default',
  '--vscode-titleBar-inactiveForeground': '--text-color-kumo-subtle',
  '--vscode-foreground': '--text-color-kumo-default',
  '--vscode-editor-foreground': '--text-color-kumo-default',
  '--vscode-descriptionForeground': '--text-color-kumo-subtle',
  '--vscode-panel-border': '--color-kumo-line',
  '--vscode-sideBar-border': '--color-kumo-line',
  '--vscode-editorGroup-border': '--color-kumo-line',
  '--vscode-titleBar-border': '--color-kumo-line',
  '--vscode-focusBorder': '--color-kumo-brand',
  '--vscode-progressBar-background': '--color-kumo-brand',
  '--vscode-button-background': '--color-kumo-brand',
  '--vscode-button-hoverBackground': '--color-kumo-brand',
  '--vscode-list-hoverBackground': '--color-kumo-tint',
  '--vscode-list-activeSelectionBackground': '--color-kumo-tint',
  '--vscode-list-activeSelectionForeground': '--text-color-kumo-default',
  '--vscode-list-inactiveSelectionBackground': '--color-kumo-tint',
  '--vscode-toolbar-hoverBackground': '--color-kumo-tint',
  '--vscode-input-background': '--color-kumo-base',
  '--vscode-input-border': '--color-kumo-line',
}

/** Resolve light-dark() using an explicit color-scheme; the parent theme effect may not have run yet. */
function resolveKumoColors(theme: ResolvedTheme): Record<string, string> {
  const probe = document.createElement('div')
  probe.style.display = 'none'
  probe.style.colorScheme = theme
  document.body.appendChild(probe)

  const resolved: Record<string, string> = {}
  try {
    for (const token of new Set(Object.values(VIEWER_VARS))) {
      probe.style.backgroundColor = `var(${token})`
      resolved[token] = getComputedStyle(probe).backgroundColor
    }
  } finally {
    probe.remove()
  }
  return resolved
}

function themeViewer(doc: Document, theme: ResolvedTheme) {
  const root = doc.documentElement
  root.classList.remove('light-mode', 'dark-mode')
  root.classList.add(VIEWER_THEME[theme])

  const colors = resolveKumoColors(theme)
  const css = [
    ':root.light-mode, :root.dark-mode {',
    ...Object.entries(VIEWER_VARS).map(([name, token]) => `  ${name}: ${colors[token]};`),
    '}',
    `.header { background-color: ${colors['--color-kumo-canvas']} !important;`,
    `  color: ${colors['--text-color-kumo-default']} !important;`,
    `  border-bottom: 1px solid ${colors['--color-kumo-line']}; }`,
  ].join('\n')

  const existing = doc.getElementById('kumo-theme')
  if (existing) {
    existing.textContent = css
  } else {
    const style = doc.createElement('style')
    style.id = 'kumo-theme'
    style.textContent = css
    doc.head.appendChild(style)
  }
}

function TracePage() {
  const { projectId, runId } = Route.useParams()
  const { key } = Route.useSearch()
  const { resolved: theme } = useTheme()
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const signed = useQuery({
    queryKey: ['signed-artifact', runId, key] as const,
    queryFn: () => getSignedArtifactUrl({ data: { runId, key } }),
    enabled: key.length > 0,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

  useEffect(() => {
    localStorage.setItem('theme', VIEWER_THEME[theme])
    const doc = iframeRef.current?.contentDocument
    if (doc?.head) themeViewer(doc, theme)
  }, [theme])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        title="Trace"
        breadcrumbs={
          <Breadcrumbs size="base">
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
        headerActions={
          key.length > 0 ? (
            <LinkButton
              href={`/api/artifacts/${key}`}
              download={`trace-${shortId(runId)}.zip`}
              variant="secondary"
              size="sm"
              icon={<DownloadSimpleIcon size={14} />}
              aria-label="Download trace"
            >
              <span className="hidden sm:inline">Download</span>
            </LinkButton>
          ) : undefined
        }
      />

      {key.length === 0 ? (
        <div className="flex-1 p-4 sm:p-6 lg:p-8">
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="No trace to show"
            description="This link is missing its trace reference. Open the run and use its Trace button."
          />
        </div>
      ) : signed.isPending ? (
        <div className="flex flex-1 items-center justify-center gap-2 bg-kumo-canvas">
          <Loader size="sm" />
          <Text as="span" variant="secondary" size="base">
            Preparing the trace…
          </Text>
        </div>
      ) : signed.error ? (
        <div className="flex-1 p-4 sm:p-6 lg:p-8">
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="Could not open this trace"
            description={signed.error.message}
            action={<Banner.Action onClick={() => void signed.refetch()}>Try again</Banner.Action>}
          />
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={`/pw-trace/index.html?trace=${encodeURIComponent(signed.data.url)}`}
          title="Playwright trace viewer"
          className="min-h-0 w-full flex-1 border-0 bg-kumo-canvas"
          onLoad={() => {
            const doc = iframeRef.current?.contentDocument
            if (doc?.head) themeViewer(doc, theme)
          }}
        />
      )}
    </div>
  )
}
