import {
  Badge,
  Banner,
  Button,
  Dialog,
  DropdownMenu,
  Empty,
  Input,
  InputArea,
  LayerCard,
  Table,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import {
  CaretRightIcon,
  DotsThreeIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  TestTubeIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { PageBody, PageHeader } from '#/components/page.tsx'
import { TestCaseStatusBadge } from '#/components/status-badge.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { intentsQuery, projectQuery } from '#/lib/queries.ts'
import { createIntent, runIntent } from '#/server/intents.ts'
import { deleteProject, updateProject } from '#/server/projects.ts'

export const Route = createFileRoute('/_app/projects/$projectId/')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData({
        ...projectQuery(params.projectId),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...intentsQuery(params.projectId),
        revalidateIfStale: true,
      }),
    ])
  },
  component: ProjectDetail,
})

function ProjectDetail() {
  const { projectId } = Route.useParams()
  const { data: project } = useSuspenseQuery(projectQuery(projectId))
  const { data: intents } = useSuspenseQuery(intentsQuery(projectId))

  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [addingIntent, setAddingIntent] = useState(false)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Only intents with a saved script have anything to execute.
  const runnable = intents.filter((row) => row.currentVersion > 0)

  const runAll = useMutation({
    mutationFn: async () => {
      // Queued, not awaited: each run is a Workflow instance that outlives this
      // request. M6 replaces the refetch below with live progress.
      for (const row of runnable) await runIntent({ data: { intentId: row.id } })
      return { total: runnable.length }
    },
    onSuccess: async ({ total }) => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: 'info',
        title: `${total} run${total === 1 ? '' : 's'} queued`,
        description: 'Results appear in each intent as they finish.',
      })
    },
  })

  return (
    <>
      <PageHeader
        breadcrumbs={
          <div className="flex items-center gap-1">
            <Link to="/projects" className="text-kumo-link underline underline-offset-2">
              <Text as="span" size="xs">
                Projects
              </Text>
            </Link>
            <CaretRightIcon size={12} className="text-kumo-subtle" />
            <Text as="span" variant="secondary" size="xs">
              {project.name}
            </Text>
          </div>
        }
        title={project.name}
        description={project.description ?? project.defaultEnvironment?.baseUrl ?? '—'}
        actions={
          <>
            <Button
              variant="secondary"
              icon={<PlayIcon size={16} />}
              loading={runAll.isPending}
              disabled={runnable.length === 0}
              onClick={() => runAll.mutate()}
            >
              Run all
            </Button>
            <Button
              variant="primary"
              icon={<PlusIcon size={16} />}
              onClick={() => setAddingIntent(true)}
            >
              New intent
            </Button>
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <Button variant="secondary" shape="square" aria-label="Project actions">
                    <DotsThreeIcon size={16} weight="bold" />
                  </Button>
                }
              />
              <DropdownMenu.Content>
                <DropdownMenu.Item icon={PencilSimpleIcon} onClick={() => setEditing(true)}>
                  Edit project
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  icon={TrashIcon}
                  variant="danger"
                  onClick={() => setDeleting(true)}
                >
                  Delete project
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          </>
        }
      />

      <PageBody className="grid gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="neutral">{intents.length} intents</Badge>
          {/* M7: this becomes the Environments section, listing every environment. */}
          <Text variant="mono-secondary">{project.defaultEnvironment?.baseUrl ?? '—'}</Text>
        </div>

        {intents.length === 0 ? (
          <Empty
            icon={<TestTubeIcon size={48} className="text-kumo-inactive" />}
            title="No intents yet"
            description="Describe what a user should be able to do, then write the script that proves it."
            contents={
              <Button
                variant="primary"
                icon={<PlusIcon size={16} />}
                onClick={() => setAddingIntent(true)}
              >
                Describe an intent
              </Button>
            }
          />
        ) : (
          <LayerCard className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Intent</Table.Head>
                    <Table.Head>Status</Table.Head>
                    <Table.Head>Version</Table.Head>
                    <Table.Head>Updated</Table.Head>
                    <Table.Head className="w-0" />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {intents.map((row) => (
                    <Table.Row key={row.id}>
                      <Table.Cell>
                        <div className="grid gap-0.5">
                          <Link
                            to="/projects/$projectId/intents/$intentId"
                            params={{ projectId, intentId: row.id }}
                            className="text-kumo-link underline underline-offset-2"
                          >
                            {row.title}
                          </Link>
                          <Text variant="secondary" size="xs" truncate>
                            {row.description.split('\n')[0]}
                          </Text>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <TestCaseStatusBadge status={row.status} />
                      </Table.Cell>
                      <Table.Cell>
                        <Text as="span" variant="mono-secondary">
                          {row.currentVersion === 0 ? '—' : `v${row.currentVersion}`}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <RelativeTime value={row.updatedAt} />
                      </Table.Cell>
                      <Table.Cell>
                        <RowActions
                          projectId={projectId}
                          intentId={row.id}
                          runnable={row.currentVersion > 0}
                        />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          </LayerCard>
        )}
      </PageBody>

      <CreateIntentDialog
        projectId={projectId}
        open={addingIntent}
        onOpenChange={setAddingIntent}
      />
      <EditProjectDialog project={project} open={editing} onOpenChange={setEditing} />
      <DeleteProjectDialog project={project} open={deleting} onOpenChange={setDeleting} />
    </>
  )
}

function RowActions({
  projectId,
  intentId,
  runnable,
}: {
  projectId: string
  intentId: string
  runnable: boolean
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const run = useMutation({
    mutationFn: () => runIntent({ data: { intentId } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'info', title: 'Run queued', description: result.runId })
    },
  })

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button variant="ghost" shape="square" size="sm" aria-label="Intent actions">
              <DotsThreeIcon size={16} weight="bold" />
            </Button>
          }
        />
        <DropdownMenu.Content>
          <DropdownMenu.LinkItem
            href={`/projects/${projectId}/intents/${intentId}`}
            icon={TestTubeIcon}
          >
            Open
          </DropdownMenu.LinkItem>
          <DropdownMenu.Item icon={PlayIcon} disabled={!runnable} onClick={() => run.mutate()}>
            Run
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  )
}

const EXAMPLE_DESCRIPTION = `Go to /pricing
Click "Start free trial"
Enter "ada@example.com" in the Email field
Click "Continue"
Should see "Check your inbox"`

function CreateIntentDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="px-6 py-5">
        <CreateIntentForm projectId={projectId} onOpenChange={onOpenChange} />
      </Dialog>
    </Dialog.Root>
  )
}

function CreateIntentForm({
  projectId,
  onOpenChange,
}: {
  projectId: string
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')

  const mutation = useMutation({
    mutationFn: () => createIntent({ data: { projectId, title: title.trim(), description } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      onOpenChange(false)
      await navigate({
        to: '/projects/$projectId/intents/$intentId',
        params: { projectId, intentId: result.id },
      })
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
              Describe an intent
            </Text>
          </Dialog.Title>
          <Dialog.Description>
            <Text as="span" variant="secondary">
              One instruction per line. Quote the exact label of anything you click or type into.
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
          title="Could not create intent"
          description={mutation.error.message}
        />
      ) : null}

      <div className="grid gap-4">
        <Input
          label="Title"
          placeholder="Visitor can start a free trial"
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <InputArea
          label="What should happen?"
          description="Plain English. This is the permanent source of truth."
          placeholder={EXAMPLE_DESCRIPTION}
          autoResize
          minRows={8}
          maxRows={20}
          required
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-self-start"
          onClick={() => setDescription(EXAMPLE_DESCRIPTION)}
        >
          Use the example
        </Button>
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
          disabled={!title.trim() || description.trim().length < 10}
        >
          Create intent
        </Button>
      </div>
    </form>
  )
}

type ProjectRow = {
  id: string
  name: string
  description: string | null
}

function EditProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: ProjectRow
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="px-6 py-5">
        <EditProjectForm project={project} onOpenChange={onOpenChange} />
      </Dialog>
    </Dialog.Root>
  )
}

function EditProjectForm({
  project,
  onOpenChange,
}: {
  project: ProjectRow
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')

  const mutation = useMutation({
    mutationFn: () =>
      updateProject({
        data: {
          projectId: project.id,
          name: name.trim(),
          description: description.trim() || null,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Project updated' })
      onOpenChange(false)
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
      <Dialog.Title>
        <Text as="span" variant="heading">
          Edit project
        </Text>
      </Dialog.Title>

      {mutation.error ? (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="Could not save"
          description={mutation.error.message}
        />
      ) : null}

      <div className="grid gap-4">
        <Input
          label="Name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {/* M7: base URLs are edited in the Environments section, not here. */}
        <InputArea
          label="Description"
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
        <Button type="submit" variant="primary" loading={mutation.isPending}>
          Save changes
        </Button>
      </div>
    </form>
  )
}

function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: ProjectRow
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="px-6 py-5">
        <DeleteProjectForm project={project} onOpenChange={onOpenChange} />
      </Dialog>
    </Dialog.Root>
  )
}

function DeleteProjectForm({
  project,
  onOpenChange,
}: {
  project: ProjectRow
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const toast = useKumoToastManager()
  const [confirmName, setConfirmName] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      deleteProject({ data: { projectId: project.id, confirmName: confirmName.trim() } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Project deleted', description: project.name })
      onOpenChange(false)
      await navigate({ to: '/projects' })
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
      <div className="grid gap-1.5">
        <Dialog.Title>
          <Text as="span" variant="heading">
            Delete this project?
          </Text>
        </Dialog.Title>
        <Dialog.Description>
          <Text as="span" variant="secondary">
            Every environment, intent and run under {project.name} goes with it. This cannot be
            undone.
          </Text>
        </Dialog.Description>
      </div>

      {mutation.error ? (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="Could not delete"
          description={mutation.error.message}
        />
      ) : null}

      <Input
        label={`Type "${project.name}" to confirm`}
        required
        value={confirmName}
        onChange={(event) => setConfirmName(event.target.value)}
      />

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
          variant="destructive"
          loading={mutation.isPending}
          disabled={confirmName.trim() !== project.name}
        >
          Delete project
        </Button>
      </div>
    </form>
  )
}
