import {
  Badge,
  Banner,
  Button,
  Dialog,
  DropdownMenu,
  Empty,
  Input,
  InputArea,
  Select,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import {
  DotsThreeIcon,
  FolderIcon,
  GearIcon,
  PlusIcon,
  StackIcon,
  TestTubeIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { ListRow, ListToolbar } from '#/components/list.tsx'
import { PageBody, PageHeader, StatTile } from '#/components/page.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { projectsQuery } from '#/lib/queries.ts'
import { createProject } from '#/server/projects.ts'

export const Route = createFileRoute('/_app/projects/')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({ ...projectsQuery(), revalidateIfStale: true }),
  component: Projects,
})

const FILTERS = {
  all: 'All projects',
  failing: 'Has failures',
  passing: 'All passing',
  empty: 'No intents yet',
} as const

type Filter = keyof typeof FILTERS

function Projects() {
  const { data: projects } = useSuspenseQuery(projectsQuery())
  const queryClient = useQueryClient()

  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const totals = useMemo(
    () => ({
      intents: projects.reduce((sum, row) => sum + row.intentCount, 0),
      passing: projects.reduce((sum, row) => sum + row.passingCount, 0),
      failing: projects.reduce((sum, row) => sum + row.failingCount, 0),
    }),
    [projects],
  )

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return projects.filter((project) => {
      if (
        needle &&
        !`${project.name} ${project.description ?? ''} ${project.defaultEnvironment?.baseUrl ?? ''}`
          .toLowerCase()
          .includes(needle)
      ) {
        return false
      }
      if (filter === 'failing') return project.failingCount > 0
      if (filter === 'passing') return project.intentCount > 0 && project.failingCount === 0
      if (filter === 'empty') return project.intentCount === 0
      return true
    })
  }, [projects, search, filter])

  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project owns its environments, its intents and their run history."
        actions={
          <Button variant="primary" icon={<PlusIcon size={16} />} onClick={() => setCreating(true)}>
            Create project
          </Button>
        }
      />

      <PageBody className="grid gap-6">
        {projects.length === 0 ? (
          <Empty
            icon={<FolderIcon size={48} className="text-kumo-inactive" />}
            title="No projects found"
            description="A project is a set of environments plus the intents that run against them."
            contents={
              <Button
                variant="primary"
                icon={<PlusIcon size={16} />}
                onClick={() => setCreating(true)}
              >
                Create your first project
              </Button>
            }
          />
        ) : (
          <>
            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Projects" value={projects.length} />
              <StatTile label="Intents" value={totals.intents} />
              <StatTile
                label="Passing"
                value={totals.passing}
                hint={totals.intents === 0 ? 'Nothing has run yet' : 'Green on the last run'}
              />
              <StatTile
                label="Failing"
                value={totals.failing}
                hint={totals.failing === 0 ? 'Nothing to repair' : 'Need a look'}
              />
            </section>

            <ListToolbar
              value={search}
              onValueChange={setSearch}
              placeholder="Search projects"
              onRefresh={() => {
                void queryClient.invalidateQueries({ queryKey: projectsQuery().queryKey })
              }}
            >
              <Select
                aria-label="Filter projects"
                className="w-44"
                items={FILTERS}
                value={filter}
                onValueChange={(value: Filter | null) => setFilter(value ?? 'all')}
              />
            </ListToolbar>

            {visible.length === 0 ? (
              <Empty
                size="sm"
                icon={<FolderIcon size={32} className="text-kumo-inactive" />}
                title="No projects found"
                description="No project matches this search. Try different words or clear the filter."
              />
            ) : (
              <ul className="grid gap-3">
                {visible.map((project) => (
                  <li key={project.id}>
                    <ListRow
                      icon={<FolderIcon size={18} />}
                      title={
                        <Link
                          to="/projects/$projectId"
                          params={{ projectId: project.id }}
                          className="truncate font-medium text-kumo-default hover:text-kumo-link"
                        >
                          {project.name}
                        </Link>
                      }
                      subtitle={
                        <Text variant="secondary" size="xs" truncate>
                          {project.description ?? `/${project.slug}`}
                        </Text>
                      }
                      meta={
                        <Text as="span" variant="secondary" size="xs">
                          Updated <RelativeTime value={project.updatedAt} />
                        </Text>
                      }
                      actions={<ProjectActions projectId={project.id} />}
                      footer={
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Text as="span" variant="mono-secondary" truncate>
                            {project.defaultEnvironment?.baseUrl ?? 'No environment'}
                          </Text>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge variant="neutral">
                              {project.intentCount} intent{project.intentCount === 1 ? '' : 's'}
                            </Badge>
                            {project.passingCount > 0 ? (
                              <Badge variant="success" appearance="dot">
                                {project.passingCount} passing
                              </Badge>
                            ) : null}
                            {project.failingCount > 0 ? (
                              <Badge variant="error" appearance="dot">
                                {project.failingCount} failing
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </PageBody>

      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}

function ProjectActions({ projectId }: { projectId: string }) {
  const navigate = useNavigate()

  // Typed navigation rather than an href: the tab is a search param, and a
  // hand-written query string would bypass the router's own validation of it.
  const open = (tab: 'intents' | 'environments' | 'settings') => {
    void navigate({ to: '/projects/$projectId', params: { projectId }, search: { tab } })
  }

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button variant="ghost" shape="square" size="sm" aria-label="Project actions">
            <DotsThreeIcon size={16} weight="bold" />
          </Button>
        }
      />
      <DropdownMenu.Content>
        <DropdownMenu.Item icon={TestTubeIcon} onClick={() => open('intents')}>
          Intents
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={StackIcon} onClick={() => open('environments')}>
          Environments
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={GearIcon} onClick={() => open('settings')}>
          Settings
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="px-6 py-5">
        <CreateProjectForm onOpenChange={onOpenChange} />
      </Dialog>
    </Dialog.Root>
  )
}

function CreateProjectForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const toast = useKumoToastManager()

  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [description, setDescription] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      createProject({
        data: { name: name.trim(), baseUrl, description: description.trim() || null },
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Project created', description: name })
      onOpenChange(false)
      await navigate({ to: '/projects/$projectId', params: { projectId: result.id } })
    },
  })

  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        mutation.mutate()
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <Dialog.Title>
            <Text as="span" variant="heading">
              Create project
            </Text>
          </Dialog.Title>
          <Dialog.Description>
            <Text as="span" variant="secondary">
              The base URL becomes this project's first environment, named Production.
            </Text>
          </Dialog.Description>
        </div>
        <Dialog.Close
          aria-label="Close"
          render={(props) => (
            <Button {...props} variant="ghost" shape="square" size="sm" aria-label="Close">
              <XIcon size={16} />
            </Button>
          )}
        />
      </div>

      {mutation.error ? (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="Could not create project"
          description={mutation.error.message}
        />
      ) : null}

      <div className="grid gap-4">
        <Input
          label="Name"
          placeholder="Marketing site"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          label="Base URL"
          description="Relative URLs in a script resolve against this."
          placeholder="https://example.com"
          required
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <InputArea
          label="Description"
          description="Optional. What this suite covers."
          placeholder="Checkout and signup flows for the storefront."
          autoResize
          minRows={3}
          maxRows={8}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Dialog.Close
          render={(props) => (
            <Button {...props} variant="secondary">
              Cancel
            </Button>
          )}
        />
        <Button
          type="submit"
          variant="primary"
          loading={mutation.isPending}
          disabled={!name.trim() || !baseUrl.trim()}
        >
          Create project
        </Button>
      </div>
    </form>
  )
}
