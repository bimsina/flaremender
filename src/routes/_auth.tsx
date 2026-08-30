import { Text } from '@cloudflare/kumo'
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'

import { ThemeToggle } from '#/components/theme-toggle.tsx'

export const Route = createFileRoute('/_auth')({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  beforeLoad: ({ context, search }) => {
    if (context.session) throw redirect({ to: search.redirect ?? '/dashboard' })
  },
  component: AuthLayout,
})

function AuthLayout() {
  return (
    <div className="min-h-dvh bg-kumo-canvas">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-5 py-12">
        <div className="grid gap-1.5 text-center">
          <Text variant="secondary">
            Plain-English tests that compile to Playwright and repair themselves.
          </Text>
        </div>

        <Outlet />
      </div>
    </div>
  )
}
