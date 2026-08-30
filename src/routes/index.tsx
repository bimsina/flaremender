import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * No landing page — the whole app is auth-gated. The root URL just routes you
 * to the right door: the dashboard when signed in, sign-in when not.
 */
export const Route = createFileRoute('/')({
  beforeLoad: ({ context }) => {
    if (context.session) throw redirect({ to: '/dashboard' })
    throw redirect({ to: '/signin', search: { redirect: undefined } })
  },
})
