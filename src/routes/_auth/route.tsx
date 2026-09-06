import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'

import { StandaloneShell } from '#/components/layout/standalone-shell.tsx'

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
    <StandaloneShell>
      <Outlet />
    </StandaloneShell>
  )
}
