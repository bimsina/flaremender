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
import { projectQuery, testCasesQuery } from '#/lib/queries.ts'
import { deleteProject, updateProject } from '#/server/projects.ts'
import { createTestCase, regenerateAndRun, runTestCase } from '#/server/test-cases.ts'

export const Route = createFileRoute('/_app/projects/$projectId/')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData({
        ...projectQuery(params.projectId),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...testCasesQuery(params.projectId),
        revalidateIfStale: true,
      }),
    ])
  },
  component: ProjectDetail,
})

function ProjectDetail() {
  const { projectId } = Route.useParams()
  const { data: project } = useSuspenseQuery(projectQuery(projectId))
  const { data: testCases } = useSuspenseQuery(testCasesQuery(projectId))

  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [addingCase, setAddingCase] = useState(false)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const runnable = testCases.filter((testCase) => testCase.generatedCode !== null)

  const runAll = useMutation({
    mutationFn: async () => {
      let passed = 0
      for (const testCase of runnable) {
        const result = await runTestCase({ data: { testCaseId: testCase.id } })
        if (result.status === 'passed') passed++
      }
      return { passed, total: runnable.length }
    },
    onSuccess: async ({ passed, total }) => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: passed === total ? 'success' : 'error',
        title: `${passed}/${total} passed`,
        description:
          passed === total ? 'Suite is green.' : 'Regenerate the failing cases to repair them.',
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
        description={project.description ?? project.baseUrl}
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
              onClick={() => setAddingCase(true)}
            >
              New test case
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
          <Badge variant="neutral">{testCases.length} cases</Badge>
          <Text variant="mono-secondary">{project.baseUrl}</Text>
        </div>

        {testCases.length === 0 ? (
          <Empty
            icon={<TestTubeIcon size={48} className="text-kumo-inactive" />}
            title="No test cases yet"
            description="Describe what a user should be able to do and Flaremender writes the spec."
            contents={
              <Button
                variant="primary"
                icon={<PlusIcon size={16} />}
                onClick={() => setAddingCase(true)}
              >
                Describe a test case
              </Button>
            }
          />
        ) : (
          <LayerCard className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Test case</Table.Head>
                    <Table.Head>Status</Table.Head>
                    <Table.Head>Generations</Table.Head>
                    <Table.Head>Updated</Table.Head>
                    <Table.Head className="w-0" />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {testCases.map((testCase) => (
                    <Table.Row key={testCase.id}>
                      <Table.Cell>
                        <div className="grid gap-0.5">
                          <Link
                            to="/projects/$projectId/tests/$testCaseId"
                            params={{ projectId, testCaseId: testCase.id }}
                            className="text-kumo-link underline underline-offset-2"
                          >
                            {testCase.title}
                          </Link>
                          <Text variant="secondary" size="xs" truncate>
                            {testCase.prompt.split('\n')[0]}
                          </Text>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <TestCaseStatusBadge status={testCase.status} />
                      </Table.Cell>
                      <Table.Cell>
                        <Text as="span" variant="mono-secondary">
                          {testCase.generationCount}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <RelativeTime value={testCase.updatedAt} />
                      </Table.Cell>
                      <Table.Cell>
                        <RowActions projectId={projectId} testCaseId={testCase.id} />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          </LayerCard>
        )}
      </PageBody>

      <CreateTestCaseDialog projectId={projectId} open={addingCase} onOpenChange={setAddingCase} />
      <EditProjectDialog project={project} open={editing} onOpenChange={setEditing} />
      <DeleteProjectDialog project={project} open={deleting} onOpenChange={setDeleting} />
    </>
  )
}

function RowActions({ projectId, testCaseId }: { projectId: string; testCaseId: string }) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const repair = useMutation({
    mutationFn: () => regenerateAndRun({ data: { testCaseId } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: result.status === 'passed' ? 'success' : 'error',
        title: result.status === 'passed' ? 'Passed after repair' : 'Still failing',
        description: `Attempt #${result.attempt}`,
      })
    },
  })

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button variant="ghost" shape="square" size="sm" aria-label="Test case actions">
              <DotsThreeIcon size={16} weight="bold" />
            </Button>
          }
        />
        <DropdownMenu.Content>
          <DropdownMenu.LinkItem
            href={`/projects/${projectId}/tests/${testCaseId}`}
            icon={TestTubeIcon}
          >
            Open
          </DropdownMenu.LinkItem>
          <DropdownMenu.Item icon={PlayIcon} onClick={() => repair.mutate()}>
            Regenerate and run
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  )
}

const EXAMPLE_PROMPT = `Go to /pricing
Click "Start free trial"
Enter "ada@example.com" in the Email field
Click "Continue"
Should see "Check your inbox"`

function CreateTestCaseDialog({
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
        <CreateTestCaseForm projectId={projectId} onOpenChange={onOpenChange} />
      </Dialog>
    </Dialog.Root>
  )
}

function CreateTestCaseForm({
  projectId,
  onOpenChange,
}: {
  projectId: string
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')

  const mutation = useMutation({
    mutationFn: () => createTestCase({ data: { projectId, title: title.trim(), prompt } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      onOpenChange(false)
      await navigate({
        to: '/projects/$projectId/tests/$testCaseId',
        params: { projectId, testCaseId: result.id },
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
              Describe a test case
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
          title="Could not create test case"
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
          description="Plain English. This is the prompt the generator compiles."
          placeholder={EXAMPLE_PROMPT}
          autoResize
          minRows={8}
          maxRows={20}
          required
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-self-start"
          onClick={() => setPrompt(EXAMPLE_PROMPT)}
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
          disabled={!title.trim() || prompt.trim().length < 10}
        >
          Create test case
        </Button>
      </div>
    </form>
  )
}

type ProjectRow = {
  id: string
  name: string
  description: string | null
  baseUrl: string
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
  const [baseUrl, setBaseUrl] = useState(project.baseUrl)
  const [description, setDescription] = useState(project.description ?? '')

  const mutation = useMutation({
    mutationFn: () =>
      updateProject({
        data: {
          projectId: project.id,
          name: name.trim(),
          baseUrl,
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
        <Input
          label="Base URL"
          required
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
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
            Every test case and run history under {project.name} goes with it. This cannot be
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
