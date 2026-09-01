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
  { value: '/admin/settings', label: 'Settings' },
]

function AdminLayout() {
  const location = useLocation()
  const navigate = useNavigate()

  const current =
    TABS.map((tab) => tab.value)
      .filter((value) => value !== '/admin')
      .find((value) => location.pathname.startsWith(value)) ?? '/admin'

  return (
    <>
      <PageHeader
        title="Administration"
        description="Instance-wide view across every user and organization."
        tabs={
          <Tabs
            labels={{ scrollStart: 'Scroll tabs left', scrollEnd: 'Scroll tabs right' }}
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
