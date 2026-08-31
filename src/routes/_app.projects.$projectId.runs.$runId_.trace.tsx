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

/** The viewer's own setting: `localStorage['theme']`, applied as a root class. */
const VIEWER_THEME: Record<ResolvedTheme, string> = {
  light: 'light-mode',
  dark: 'dark-mode',
}

/**
 * The viewer's chrome, translated into this app's palette.
 *
 * The viewer themes itself through ~500 VS Code-style variables scoped under
 * `:root.light-mode` / `:root.dark-mode`. Only the surfaces and accents are
 * overridden — backgrounds, borders, selection, buttons — so the viewer sits on
 * Kumo colors while its own syntax highlighting and semantics stay untouched.
 * Values are Kumo tokens; keys are the viewer's variables.
 */
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

/**
 * Kumo tokens hold unresolved `light-dark()` expressions, so they are read
 * through a probe element that forces resolution. The probe carries its own
 * `color-scheme` rather than inheriting the page's: React runs this from a
 * child effect that can fire before the ThemeProvider's own effect has updated
 * `data-mode` on <html>, and inheriting would resolve against the old mode.
 */
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

/** Applies mode class + Kumo palette to the viewer document, idempotently. */
function themeViewer(doc: Document, theme: ResolvedTheme) {
  const root = doc.documentElement
  root.classList.remove('light-mode', 'dark-mode')
  root.classList.add(VIEWER_THEME[theme])

  const colors = resolveKumoColors(theme)
  const css = [
    // Same specificity as the viewer's own scopes, later in the head — wins.
    ':root.light-mode, :root.dark-mode {',
    ...Object.entries(VIEWER_VARS).map(([name, token]) => `  ${name}: ${colors[token]};`),
    '}',
    // The top bar is hardcoded black in the viewer's stylesheet, not tokenized.
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
    // The signature is short-lived by design; don't reuse a stale one.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

  // The viewer boots from `localStorage['theme']` (shared origin), so writing
  // it before the iframe mounts — it only renders once the signed URL is back —
  // makes the first paint land in the right mode. The class/style pass in
  // `themeViewer` then keeps an already-open viewer in step with live flips.
  useEffect(() => {
    localStorage.setItem('theme', VIEWER_THEME[theme])
    const doc = iframeRef.current?.contentDocument
    if (doc?.head) themeViewer(doc, theme)
  }, [theme])

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
          <Text as="span" variant="secondary" size="base">
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
          ref={iframeRef}
          src={`/pw-trace/index.html?trace=${encodeURIComponent(signed.data.url)}`}
          title="Playwright trace viewer"
          className="w-full flex-1 border-0"
          onLoad={() => {
            const doc = iframeRef.current?.contentDocument
            if (doc?.head) themeViewer(doc, theme)
          }}
        />
      )}
    </div>
  )
}
