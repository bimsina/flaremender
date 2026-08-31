import { Table, TablePagination, useTablePagination } from '#/components/table.tsx'
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

import { ListToolbar } from '#/components/list.tsx'
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
  empty: 'No tests yet',
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
  const pagination = useTablePagination(visible, `${search}:${filter}`)

  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project owns its environments, its tests and their run history."
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
            description="A project is a set of environments plus the tests that run against them."
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
              <StatTile label="Tests" value={totals.intents} />
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

            <Table
              label="Projects"
              footer={<TablePagination {...pagination} />}
              toolbar={
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
              }
            >
              <Table.Header>
                <Table.Row>
                  <Table.Head className="min-w-72">Project</Table.Head>
                  <Table.Head>Health</Table.Head>
                  <Table.Head className="text-right">Tests</Table.Head>
                  <Table.Head>Default environment</Table.Head>
                  <Table.Head>Updated</Table.Head>
                  <Table.Head className="w-0">
                    <span className="sr-only">Actions</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {pagination.items.map((project) => (
                  <Table.Row key={project.id}>
                    <Table.Cell className="max-w-md">
                      <div className="flex items-start gap-3">
                        <span className="flex h-lh shrink-0 items-center text-kumo-subtle">
                          <FolderIcon size={16} />
                        </span>
                        <div className="grid min-w-0 gap-1">
                          <Link
                            to="/projects/$projectId"
                            params={{ projectId: project.id }}
                            className="table-link"
                          >
                            {project.name}
                          </Link>
                          <Text variant="secondary" truncate>
                            {project.description ?? `/${project.slug}`}
                          </Text>
                        </div>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-wrap gap-1.5">
                        {project.passingCount > 0 ? (
                          <Badge variant="success" className="rounded-md text-base">
                            {project.passingCount} passing
                          </Badge>
                        ) : null}
                        {project.failingCount > 0 ? (
                          <Badge variant="error" className="rounded-md text-base">
                            {project.failingCount} failing
                          </Badge>
                        ) : null}
                        {project.proposedCount > 0 ? (
                          <Badge variant="secondary" className="rounded-md text-base">
                            {project.proposedCount} proposed
                          </Badge>
                        ) : null}
                        {project.passingCount === 0 &&
                        project.failingCount === 0 &&
                        project.proposedCount === 0 ? (
                          <Text variant="secondary">
                            {project.intentCount === 0 ? 'No tests' : 'Not run yet'}
                          </Text>
                        ) : null}
                      </div>
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {project.intentCount}
                    </Table.Cell>
                    <Table.Cell className="max-w-64">
                      <Text variant="secondary" truncate>
                        {project.defaultEnvironment?.baseUrl ?? 'No environment'}
                      </Text>
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap text-kumo-subtle">
                      <RelativeTime value={project.updatedAt} />
                    </Table.Cell>
                    <Table.Cell>
                      <ProjectActions projectId={project.id} />
                    </Table.Cell>
                  </Table.Row>
                ))}
                {pagination.items.length === 0 ? (
                  <Table.Empty
                    columns={6}
                    message="No projects match your filters"
                    onClear={() => {
                      setSearch('')
                      setFilter('all')
                    }}
                  />
                ) : null}
              </Table.Body>
            </Table>
          </>
        )}
      </PageBody>

      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}

function ProjectActions({ projectId }: { projectId: string }) {
  const navigate = useNavigate()

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
          Tests
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
