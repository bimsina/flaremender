import { Toasty } from '@cloudflare/kumo'
import { HeadContent, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'

import type { QueryClient } from '@tanstack/react-query'

import { AppLinkProvider } from '#/components/app-link.tsx'
import { NotFound, RouteError } from '#/components/route-fallbacks.tsx'
import TanStackQueryDevtools from '#/integrations/tanstack-query/devtools.tsx'
import { sessionQuery, themeQuery } from '#/lib/queries.ts'
import { ThemeProvider, themeInitScript, type ThemePreference } from '#/lib/theme.tsx'
import appCss from '#/styles.css?url'

interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context }) => {
    const [session, theme] = await Promise.all([
      // fetchQuery, not ensureQueryData: guards below must see the current
      // session, never a stale one being revalidated in the background.
      context.queryClient.fetchQuery(sessionQuery()),
      context.queryClient.ensureQueryData({ ...themeQuery(), revalidateIfStale: true }),
    ])
    return { session, theme }
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Flaremender' },
      {
        name: 'description',
        content: 'Describe a test in plain English, get Playwright code that keeps itself green.',
      },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  notFoundComponent: NotFound,
  errorComponent: RouteError,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const { theme } = Route.useRouteContext()
  // `system` can only be resolved in the browser, so render light and let the
  // pre-paint script correct it before anything is visible.
  const initialMode = theme === 'dark' ? 'dark' : 'light'

  return (
    <html lang="en" data-mode={initialMode} data-theme-preference={theme}>
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
          config={{ position: 'bottom-right' }}
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
