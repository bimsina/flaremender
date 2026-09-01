import { Button, DropdownMenu, Sidebar, Text, useSidebar } from '@cloudflare/kumo'
import {
  FolderIcon,
  FlameIcon,
  GaugeIcon,
  GearIcon,
  ShieldCheckIcon,
  SignOutIcon,
  UserIcon,
} from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'

import { OrgSwitcher } from '#/components/org-switcher.tsx'
import { PageHeaderControls } from '#/components/page.tsx'
import { QuickSearch } from '#/components/quick-search.tsx'
import { ThemeToggle } from '#/components/theme-toggle.tsx'
import { authClient } from '#/lib/auth-client.ts'
import type { AppSession } from '#/server/session.ts'

export const Route = createFileRoute('/_app')({
  beforeLoad: ({ context, location }) => {
    if (!context.session) {
      throw redirect({ to: '/signin', search: { redirect: location.href } })
    }
    if (context.session.organizations.length === 0) {
      throw redirect({ to: '/onboarding' })
    }
    return { session: context.session }
  },
  component: AppLayout,
})

function AppLayout() {
  const { session } = Route.useRouteContext()
  return (
    <Sidebar.Provider defaultOpen className="h-svh">
      <AppSidebar session={session} />
      <PageHeaderControls
        controls={
          <>
            <ThemeToggle className="size-8" />
            <UserMenu user={session.user} />
          </>
        }
      >
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-kumo-canvas">
          <Outlet />
        </main>
      </PageHeaderControls>
    </Sidebar.Provider>
  )
}

function AppSidebar({ session }: { session: AppSession }) {
  const location = useLocation()
  const { state, setOpen, setOpenMobile } = useSidebar()
  const isAdmin = session.user.role === 'admin'
  const [accountOpen, setAccountOpen] = useState(true)
  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`)

  useEffect(() => {
    setOpenMobile(false)
  }, [location.href, setOpenMobile])

  return (
    <Sidebar className="app-sidebar [--sidebar-active-bg:var(--color-kumo-recessed)] [--sidebar-bg:var(--color-kumo-canvas)] dark:[--sidebar-active-bg:var(--color-kumo-control)]">
      <Sidebar.Header className="h-[58px] gap-1 px-3 group-data-[state=collapsed]/sidebar:px-[11px]">
        <Link
          to="/dashboard"
          aria-label="Flaremender home"
          className="flex size-8.5 shrink-0 items-center justify-center rounded-lg text-kumo-warning hover:bg-kumo-tint group-data-[state=collapsed]/sidebar:hidden"
        >
          <FlameIcon size={26} weight="fill" />
        </Link>
        <OrgSwitcher session={session} />
      </Sidebar.Header>
      <Sidebar.Content>
        <div className="pb-2">
          <QuickSearch isAdmin={isAdmin} />
        </div>
        <Sidebar.Group>
          <Sidebar.Menu>
            <Sidebar.MenuButton
              icon={GaugeIcon}
              href="/dashboard"
              active={isActive('/dashboard')}
              tooltip="Dashboard"
            >
              Dashboard
            </Sidebar.MenuButton>
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Build</Sidebar.GroupLabel>
          <Sidebar.Menu>
            <Sidebar.MenuButton
              icon={FolderIcon}
              href="/projects"
              active={isActive('/projects')}
              tooltip="Projects"
            >
              Projects
            </Sidebar.MenuButton>
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.Separator />
          <Sidebar.Menu>
            <Sidebar.MenuItem>
              <Sidebar.Collapsible
                open={accountOpen}
                onOpenChange={(value) => setAccountOpen(state === 'collapsed' ? true : value)}
              >
                <Sidebar.CollapsibleTrigger
                  render={
                    <Sidebar.MenuButton
                      icon={GearIcon}
                      tooltip="Manage account"
                      active={
                        state === 'collapsed' &&
                        (isActive('/organization') || isActive('/settings'))
                      }
                      onClick={() => {
                        if (state === 'collapsed') setOpen(true)
                      }}
                    >
                      Manage account
                      <Sidebar.MenuChevron />
                    </Sidebar.MenuButton>
                  }
                />
                <Sidebar.CollapsibleContent>
                  <Sidebar.MenuSub>
                    <Sidebar.MenuSubButton href="/organization" active={isActive('/organization')}>
                      Members
                    </Sidebar.MenuSubButton>
                    <Sidebar.MenuSubButton href="/settings" active={isActive('/settings')}>
                      Settings
                    </Sidebar.MenuSubButton>
                  </Sidebar.MenuSub>
                </Sidebar.CollapsibleContent>
              </Sidebar.Collapsible>
            </Sidebar.MenuItem>
            {isAdmin ? (
              <Sidebar.MenuButton
                icon={ShieldCheckIcon}
                href="/admin"
                active={isActive('/admin')}
                tooltip="Administration"
              >
                Administration
              </Sidebar.MenuButton>
            ) : null}
          </Sidebar.Menu>
        </Sidebar.Group>
      </Sidebar.Content>
      <Sidebar.Footer className="px-3.5 group-data-[state=collapsed]/sidebar:px-[11px]">
        <Sidebar.Trigger />
      </Sidebar.Footer>
    </Sidebar>
  )
}

function UserMenu({ user }: { user: AppSession['user'] }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  async function onSignOut() {
    await authClient.signOut()
    queryClient.clear()
    await navigate({ to: '/signin', search: { redirect: undefined } })
  }

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            variant="ghost"
            aria-label="User menu"
            shape="square"
            className="size-8 shrink-0 text-kumo-subtle"
          >
            <UserIcon size={16} weight="fill" />
          </Button>
        }
      />
      <DropdownMenu.Content className="min-w-56">
        <div className="grid gap-0.5 px-2 py-1.5">
          <Text as="span" bold>
            {user.name}
          </Text>
          <Text as="span" variant="secondary" size="base">
            {user.email}
          </Text>
        </div>
        <DropdownMenu.Separator />
        <DropdownMenu.LinkItem href="/settings" icon={GearIcon}>
          Settings
        </DropdownMenu.LinkItem>
        <DropdownMenu.Item icon={SignOutIcon} variant="danger" onClick={() => void onSignOut()}>
          Sign out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
