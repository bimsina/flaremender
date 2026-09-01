import { Button, CommandPalette, useSidebar } from '@cloudflare/kumo'
import {
  BuildingsIcon,
  FolderIcon,
  GaugeIcon,
  GearIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { linkOptions, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { projectsQuery } from '#/lib/queries.ts'

export function QuickSearch({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter()
  const { setOpenMobile } = useSidebar()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const {
    data: projects = [],
    isPending,
    isError,
  } = useQuery({ ...projectsQuery(), enabled: open })

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const pages = [
    {
      title: 'Dashboard',
      group: 'Overview',
      icon: GaugeIcon,
      options: linkOptions({ to: '/dashboard' }),
    },
    {
      title: 'Projects',
      group: 'Build',
      icon: FolderIcon,
      options: linkOptions({ to: '/projects' }),
    },
    {
      title: 'Members',
      group: 'Manage account',
      icon: BuildingsIcon,
      options: linkOptions({ to: '/organization' }),
    },
    {
      title: 'Settings',
      group: 'Manage account',
      icon: GearIcon,
      options: linkOptions({ to: '/settings' }),
    },
    ...(isAdmin
      ? [
          {
            title: 'Administration',
            group: 'Manage account',
            icon: ShieldCheckIcon,
            options: linkOptions({ to: '/admin' }),
          },
        ]
      : []),
    ...projects.map((project) => ({
      title: project.name,
      group: 'Projects',
      icon: FolderIcon,
      options: linkOptions({
        to: '/projects/$projectId',
        params: { projectId: project.id },
        search: { tab: 'overview' },
      }),
    })),
  ]
  const results = pages.filter((page) =>
    `${page.group} ${page.title}`.toLowerCase().includes(query.trim().toLowerCase()),
  )

  function select(item: (typeof pages)[number], newTab = false) {
    if (newTab) {
      window.open(router.buildLocation(item.options).href, '_blank', 'noopener,noreferrer')
    } else {
      void router.navigate(item.options)
      setOpenMobile(false)
    }
    setOpen(false)
    setQuery('')
  }

  return (
    <>
      <Button
        variant="secondary"
        aria-label="Quick search"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => setOpen(true)}
        className="h-8.5 w-full justify-start gap-2 px-3 font-normal text-kumo-subtle group-data-[state=collapsed]/sidebar:w-8.5 group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0"
      >
        <MagnifyingGlassIcon size={16} className="shrink-0" />
        <span className="truncate group-data-[state=collapsed]/sidebar:hidden">
          Quick search...
        </span>
        <kbd className="ml-auto whitespace-nowrap text-base group-data-[state=collapsed]/sidebar:hidden">
          ⌘K
        </kbd>
      </Button>
      <CommandPalette.Root
        open={open}
        onOpenChange={(value) => {
          setOpen(value)
          if (!value) setQuery('')
        }}
        items={results}
        value={query}
        onValueChange={setQuery}
        itemToStringValue={(item) => item.title}
        onSelect={(item, { newTab }) => select(item, newTab)}
      >
        <CommandPalette.Input
          aria-label="Search pages and projects"
          placeholder="Search pages and projects..."
        />
        <CommandPalette.List>
          <CommandPalette.Results>
            {(item) => (
              <CommandPalette.ResultItem
                value={item}
                title={item.title}
                breadcrumbs={[item.group]}
                icon={<item.icon size={16} />}
                onClick={(event) => select(item, event.metaKey || event.ctrlKey)}
              />
            )}
          </CommandPalette.Results>
          <CommandPalette.Empty>No matching pages or projects.</CommandPalette.Empty>
          {isPending ? <CommandPalette.Loading>Loading projects...</CommandPalette.Loading> : null}
          {isError ? (
            <p className="px-4 py-3 text-base text-kumo-subtle">
              Projects could not be loaded. You can still search pages.
            </p>
          ) : null}
        </CommandPalette.List>
        <CommandPalette.Footer>
          <span className="text-base text-kumo-subtle">
            <kbd>↑ ↓</kbd> to navigate{' '}
            <span className="ml-3">
              <kbd>↵</kbd> to select
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpen(false)
              setQuery('')
            }}
          >
            Esc
          </Button>
        </CommandPalette.Footer>
      </CommandPalette.Root>
    </>
  )
}
