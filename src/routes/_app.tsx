import { Button, DropdownMenu, LinkButton, Sidebar, Text, useSidebar } from '@cloudflare/kumo'
import {
  BookOpenTextIcon,
  DesktopIcon,
  FolderIcon,
  GaugeIcon,
  GearIcon,
  GithubLogoIcon,
  MoonIcon,
  ShieldCheckIcon,
  SignOutIcon,
  SunIcon,
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

import { Logo } from '#/components/logo.tsx'
import { MenuRadioItem } from '#/components/menu-radio-item.tsx'
import { OrgSwitcher } from '#/components/org-switcher.tsx'
import { PageHeaderControls } from '#/components/page.tsx'
import { QuickSearch } from '#/components/quick-search.tsx'
import { authClient } from '#/lib/auth-client.ts'
import { type ThemePreference, useTheme } from '#/lib/theme.tsx'
import type { AppSession } from '#/server/session.ts'

const DOCS_URL = 'https://github.com/bimsina/flaremender#readme'
const REPO_URL = 'https://github.com/bimsina/flaremender'
const ISSUES_URL = 'https://github.com/bimsina/flaremender/issues/new'

const THEMES: Array<{ value: ThemePreference; label: string; icon: typeof SunIcon }> = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: DesktopIcon },
]

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
            <LinkButton
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              variant="ghost"
              icon={BookOpenTextIcon}
              className="hidden sm:inline-flex"
            >
              Docs
            </LinkButton>
            <UserMenu user={session.user} />
          </>
        }
      >
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-kumo-canvas">
          <Outlet />
          <AppFooter />
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
          className="flex size-8.5 shrink-0 items-center justify-center rounded-lg hover:bg-kumo-tint group-data-[state=collapsed]/sidebar:hidden"
        >
          <Logo size={26} />
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

/** The dashboard's footer bar: a row of quiet links and the copyright. */
function AppFooter() {
  const links = [
    { label: 'Docs', href: DOCS_URL },
    { label: 'GitHub', href: REPO_URL },
    { label: 'Report an issue', href: ISSUES_URL },
    { label: 'Security', href: `${REPO_URL}/blob/main/SECURITY.md` },
  ]
  return (
    <footer className="mt-auto flex min-h-12 shrink-0 flex-wrap items-center justify-center gap-y-2 border-t border-kumo-line bg-kumo-canvas px-4 py-2.5 text-sm">
      {links.map((link, index) => (
        <span key={link.href} className="flex items-center">
          {index > 0 ? <span className="mx-4 h-4 w-px bg-kumo-line" aria-hidden /> : null}
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className="text-kumo-strong no-underline transition-colors hover:text-kumo-default"
          >
            {link.label}
          </a>
        </span>
      ))}
      <span className="ml-4 text-kumo-subtle">© {new Date().getFullYear()} Flaremender</span>
    </footer>
  )
}

function UserMenu({ user }: { user: AppSession['user'] }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { preference, setPreference } = useTheme()

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
        <DropdownMenu.LinkItem href={REPO_URL} icon={GithubLogoIcon}>
          GitHub
        </DropdownMenu.LinkItem>
        <DropdownMenu.Separator />
        <DropdownMenu.RadioGroup
          value={preference}
          onValueChange={(value) => setPreference(value as ThemePreference)}
        >
          {THEMES.map((option) => (
            <MenuRadioItem key={option.value} value={option.value} icon={option.icon}>
              {option.label}
            </MenuRadioItem>
          ))}
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={SignOutIcon} variant="danger" onClick={() => void onSignOut()}>
          Sign out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
