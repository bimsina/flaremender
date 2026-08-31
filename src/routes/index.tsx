import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  beforeLoad: ({ context }) => {
    if (context.session) throw redirect({ to: '/dashboard' })
    throw redirect({ to: '/signin', search: { redirect: undefined } })
  },
})
