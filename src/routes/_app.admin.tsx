import { Tabs } from '@cloudflare/kumo'
import { Outlet, createFileRoute, redirect, useLocation, useNavigate } from '@tanstack/react-router'

import { PageHeader } from '#/components/page.tsx'

export const Route = createFileRoute('/_app/admin')({
  beforeLoad: ({ context }) => {
    if (context.session?.user.role !== 'admin') throw redirect({ to: '/dashboard' })
  },
  component: AdminLayout,
})

const TABS = [
  { value: '/admin', label: 'Users' },
  { value: '/admin/organizations', label: 'Organizations' },
]

function AdminLayout() {
  const location = useLocation()
  const navigate = useNavigate()

  const current = location.pathname.startsWith('/admin/organizations')
    ? '/admin/organizations'
    : '/admin'

  return (
    <>
      <PageHeader
        title="Administration"
        description="Instance-wide view across every user and organization."
        actions={
          <Tabs
            variant="segmented"
            tabs={TABS}
            value={current}
            onValueChange={(value) => void navigate({ to: value })}
          />
        }
      />
      <Outlet />
    </>
  )
}
