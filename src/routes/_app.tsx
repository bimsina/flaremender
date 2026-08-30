import { Button, DropdownMenu, Sidebar, Text } from '@cloudflare/kumo'
import {
  BuildingsIcon,
  FolderIcon,
  GaugeIcon,
  GearIcon,
  ShieldCheckIcon,
  SignOutIcon,
  UserIcon,
} from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { Outlet, createFileRoute, redirect, useLocation, useNavigate } from '@tanstack/react-router'

import { OrgSwitcher } from '#/components/org-switcher.tsx'
import { ThemeToggle } from '#/components/theme-toggle.tsx'
import { authClient } from '#/lib/auth-client.ts'
import type { AppSession } from '#/server/session.ts'

export const Route = createFileRoute('/_app')({
  beforeLoad: ({ context, location }) => {
    if (!context.session) {
      throw redirect({ to: '/signin', search: { redirect: location.href } })
    }
    // Everything below this layout is organization-scoped, so a member of no
    // organization has to make one before any of it can render.
    if (context.session.organizations.length === 0) {
      throw redirect({ to: '/onboarding' })
    }
    return { session: context.session }
  },
  component: AppLayout,
})

function AppLayout() {
  const { session } = Route.useRouteContext()
  const location = useLocation()
  const isAdmin = session.user.role === 'admin'

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`)

  return (
    <Sidebar.Provider defaultOpen className="h-svh">
      <Sidebar>
        <Sidebar.Header>
          <div className="px-1 py-1">
            <OrgSwitcher session={session} />
          </div>
        </Sidebar.Header>

        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.GroupLabel>Overview</Sidebar.GroupLabel>
            <Sidebar.Menu>
              <Sidebar.MenuButton
                icon={GaugeIcon}
                href="/dashboard"
                active={isActive('/dashboard')}
                tooltip="Dashboard"
              >
                Dashboard
              </Sidebar.MenuButton>
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
            <Sidebar.GroupLabel>Organization</Sidebar.GroupLabel>
            <Sidebar.Menu>
              <Sidebar.MenuButton
                icon={BuildingsIcon}
                href="/organization"
                active={isActive('/organization')}
                tooltip="Members"
              >
                Members
              </Sidebar.MenuButton>
              <Sidebar.MenuButton
                icon={GearIcon}
                href="/settings"
                active={isActive('/settings')}
                tooltip="Settings"
              >
                Settings
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>

          {isAdmin ? (
            <Sidebar.Group>
              <Sidebar.GroupLabel>Administration</Sidebar.GroupLabel>
              <Sidebar.Menu>
                <Sidebar.MenuButton
                  icon={ShieldCheckIcon}
                  href="/admin"
                  active={isActive('/admin')}
                  tooltip="Admin"
                >
                  Admin
                </Sidebar.MenuButton>
              </Sidebar.Menu>
            </Sidebar.Group>
          ) : null}
        </Sidebar.Content>

        <Sidebar.Footer>
          <div className="flex items-center gap-1">
            <UserMenu user={session.user} />
            <ThemeToggle />
            <Sidebar.Trigger />
          </div>
        </Sidebar.Footer>
      </Sidebar>

      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-kumo-canvas">
        <Outlet />
      </main>
    </Sidebar.Provider>
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
          <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start gap-2">
            <UserIcon size={16} className="shrink-0" />
            <span className="truncate">{user.name}</span>
          </Button>
        }
      />
      <DropdownMenu.Content className="min-w-56">
        <div className="grid gap-0.5 px-2 py-1.5">
          <Text as="span" bold>
            {user.name}
          </Text>
          <Text as="span" variant="secondary" size="xs">
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
