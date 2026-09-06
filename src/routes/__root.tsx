import { Toasty } from '@cloudflare/kumo'
import { HeadContent, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'

import type { QueryClient } from '@tanstack/react-query'

import { AppLinkProvider } from '#/components/app-link.tsx'
import { NotFound, RouteError } from '#/components/route-fallbacks.tsx'
import TanStackQueryDevtools from '#/integrations/tanstack-query/devtools.tsx'
import { sessionQuery, siteOriginQuery, themeQuery } from '#/lib/queries.ts'
import { ThemeProvider, themeInitScript, type ThemePreference } from '#/lib/theme.tsx'
import appCss from '#/styles.css?url'

interface RouterContext {
  queryClient: QueryClient
}

const TITLE = 'Flaremender'
const DESCRIPTION =
  'Describe a test in plain English, generate Playwright code, and run it in a real browser.'
const OG_ALT = 'Flaremender: give it a URL, watch it write your test suite'

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context }) => {
    const [session, theme, origin] = await Promise.all([
      context.queryClient.fetchQuery(sessionQuery()),
      context.queryClient.ensureQueryData({ ...themeQuery(), revalidateIfStale: true }),
      context.queryClient.ensureQueryData(siteOriginQuery()),
    ])
    return { session, theme, origin }
  },
  head: ({ match }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: TITLE },
      { name: 'description', content: DESCRIPTION },
      { name: 'theme-color', content: '#f4811f' },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Flaremender' },
      { property: 'og:title', content: TITLE },
      { property: 'og:description', content: DESCRIPTION },
      { property: 'og:image', content: `${match.context.origin}/og.png` },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'og:image:alt', content: OG_ALT },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: TITLE },
      { name: 'twitter:description', content: DESCRIPTION },
      { name: 'twitter:image', content: `${match.context.origin}/og.png` },
      { name: 'twitter:image:alt', content: OG_ALT },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.ico', sizes: '32x32' },
      { rel: 'icon', href: '/icon.svg', type: 'image/svg+xml' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      { rel: 'manifest', href: '/site.webmanifest' },
    ],
  }),
  notFoundComponent: NotFound,
  errorComponent: RouteError,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const { theme } = Route.useRouteContext()
  const initialMode = theme === 'dark' ? 'dark' : 'light'

  return (
    <html lang="en" data-mode={initialMode} data-theme-preference={theme} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <HeadContent />
      </head>
      <body className="bg-kumo-canvas text-kumo-default">
        <ThemeProvider initialPreference={theme as ThemePreference}>
          <AppLinkProvider>
            <Toasty>{children}</Toasty>
          </AppLinkProvider>
        </ThemeProvider>
        <TanStackDevtools
          config={{ position: 'bottom-right', triggerMode: 'fixed' }}
          plugins={[
            { name: 'Tanstack Router', render: <TanStackRouterDevtoolsPanel /> },
            TanStackQueryDevtools,
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
