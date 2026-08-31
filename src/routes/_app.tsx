import { Button, DropdownMenu, Sidebar, Text, cn } from '@cloudflare/kumo'
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
        {/*
          Kumo pads the header for the expanded width; the collapsed rail is
          57px wide, so it gets the same 11px the nav viewport uses and the org
          button shrinks to an icon rather than being clipped in half.
        */}
        <Sidebar.Header
          className={cn(
            'group-not-data-[state=collapsed]/sidebar:px-3.5',
            'group-data-[state=collapsed]/sidebar:px-[11px]',
          )}
        >
          <OrgSwitcher session={session} />
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

        {/*
          One row of 34px controls that lines up with the nav above it, and a
          centred column of the same three controls in the rail — the collapse
          trigger is the last of them, so it is reachable in either state.
        */}
        <Sidebar.Footer
          className={cn(
            'gap-1.5 group-not-data-[state=collapsed]/sidebar:px-3.5',
            'group-data-[state=collapsed]/sidebar:h-auto group-data-[state=collapsed]/sidebar:flex-col',
            'group-data-[state=collapsed]/sidebar:gap-1 group-data-[state=collapsed]/sidebar:py-2',
          )}
        >
          <UserMenu user={session.user} />
          <ThemeToggle className="size-8.5 shrink-0" />
          <Sidebar.Trigger className="shrink-0" />
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
          // Sized and padded like a Sidebar.MenuButton so the user icon sits on
          // the same vertical line as the nav icons above it.
          <Button
            variant="ghost"
            aria-label={user.name}
            className={cn(
              'h-8.5 min-w-0 flex-1 justify-start gap-3 rounded-lg px-3 font-medium',
              'group-data-[state=collapsed]/sidebar:h-8.5 group-data-[state=collapsed]/sidebar:w-8.5',
              'group-data-[state=collapsed]/sidebar:flex-none group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0',
            )}
          >
            <UserIcon size={16} className="shrink-0 opacity-40" />
            <span className="truncate group-data-[state=collapsed]/sidebar:hidden">
              {user.name}
            </span>
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
