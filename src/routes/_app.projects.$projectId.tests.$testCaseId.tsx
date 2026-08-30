import {
  Badge,
  Banner,
  Button,
  Collapsible,
  Dialog,
  DropdownMenu,
  Empty,
  Input,
  InputArea,
  LayerCard,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { CodeHighlighted, ShikiProvider } from '@cloudflare/kumo/code'
import {
  ArrowsClockwiseIcon,
  CaretRightIcon,
  DotsThreeIcon,
  PlayIcon,
  SparkleIcon,
  TerminalWindowIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { PageBody, PageHeader } from '#/components/page.tsx'
import { RunStatusBadge, TestCaseStatusBadge } from '#/components/status-badge.tsx'
import { formatDuration } from '#/lib/format.ts'
import { RelativeTime } from '#/components/relative-time.tsx'
import { testCaseQuery } from '#/lib/queries.ts'
import {
  deleteTestCase,
  generateTestCase,
  regenerateAndRun,
  runTestCase,
  updateTestCase,
} from '#/server/test-cases.ts'

export const Route = createFileRoute('/_app/projects/$projectId/tests/$testCaseId')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData({
      ...testCaseQuery(params.testCaseId),
      revalidateIfStale: true,
    }),
  component: TestCaseDetail,
})

function TestCaseDetail() {
  const { projectId, testCaseId } = Route.useParams()
  const { data } = useSuspenseQuery(testCaseQuery(testCaseId))
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const { testCase, project, runs } = data
  const lastRun = runs[0]
  const hasCode = testCase.generatedCode !== null

  const generate = useMutation({
    mutationFn: () => generateTestCase({ data: { testCaseId } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: 'success',
        title: 'Playwright code generated',
        description: result.summary,
      })
    },
  })

  const run = useMutation({
    mutationFn: () => runTestCase({ data: { testCaseId } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: result.status === 'passed' ? 'success' : 'error',
        title: result.status === 'passed' ? 'Test passed' : 'Test failed',
        description: `Attempt #${result.attempt} in ${formatDuration(result.durationMs)}`,
      })
    },
  })

  const repair = useMutation({
    mutationFn: () => regenerateAndRun({ data: { testCaseId } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: result.status === 'passed' ? 'success' : 'error',
        title: result.status === 'passed' ? 'Repaired and passing' : 'Still failing',
        description: `Attempt #${result.attempt}`,
      })
    },
  })

  const busy = generate.isPending || run.isPending || repair.isPending
  const error = generate.error ?? run.error ?? repair.error

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
            <Link
              to="/projects/$projectId"
              params={{ projectId }}
              className="text-kumo-link underline underline-offset-2"
            >
              <Text as="span" size="xs">
                {project.name}
              </Text>
            </Link>
            <CaretRightIcon size={12} className="text-kumo-subtle" />
            <Text as="span" variant="secondary" size="xs">
              Test case
            </Text>
          </div>
        }
        title={testCase.title}
        description={`${project.baseUrl} · ${testCase.generationCount} generation${
          testCase.generationCount === 1 ? '' : 's'
        }`}
        actions={
          <>
            <Button
              variant={hasCode ? 'secondary' : 'primary'}
              icon={<SparkleIcon size={16} />}
              loading={generate.isPending}
              disabled={busy}
              onClick={() => generate.mutate()}
            >
              {hasCode ? 'Regenerate' : 'Generate code'}
            </Button>
            <Button
              variant={hasCode ? 'primary' : 'secondary'}
              icon={<PlayIcon size={16} />}
              loading={run.isPending}
              disabled={busy || !hasCode}
              onClick={() => run.mutate()}
            >
              Run test
            </Button>
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <Button variant="secondary" shape="square" aria-label="Test case actions">
                    <DotsThreeIcon size={16} weight="bold" />
                  </Button>
                }
              />
              <DropdownMenu.Content>
                <DropdownMenu.Item
                  icon={ArrowsClockwiseIcon}
                  disabled={busy || !hasCode}
                  onClick={() => repair.mutate()}
                >
                  Regenerate and run
                </DropdownMenu.Item>
                <DropdownMenu.Item icon={TerminalWindowIcon} onClick={() => setEditing(true)}>
                  Edit description
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  icon={TrashIcon}
                  variant="danger"
                  onClick={() => setDeleting(true)}
                >
                  Delete test case
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          </>
        }
      />

      <PageBody className="grid gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <TestCaseStatusBadge status={testCase.status} />
          {lastRun ? (
            <Text variant="secondary" size="xs">
              Last run <RelativeTime value={lastRun.startedAt} /> · attempt #{lastRun.attempt} ·{' '}
              {formatDuration(lastRun.durationMs)}
            </Text>
          ) : (
            <Text variant="secondary" size="xs">
              Never run
            </Text>
          )}
        </div>

        {error ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="Something went wrong"
            description={error.message}
          />
        ) : null}

        {testCase.status === 'failing' && lastRun?.errorMessage ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="The last run failed"
            description={lastRun.errorMessage.split('\n')[0]}
            action={
              <Button
                variant="secondary"
                size="sm"
                icon={<ArrowsClockwiseIcon size={14} />}
                loading={repair.isPending}
                disabled={busy}
                onClick={() => repair.mutate()}
              >
                Regenerate and run
              </Button>
            }
          />
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="grid gap-6">
            <section className="grid gap-3">
              <div className="flex items-end justify-between gap-4">
                <div className="grid gap-1.5">
                  <Text as="h2" variant="heading">
                    Description
                  </Text>
                  <Text variant="secondary">The prompt the generator compiles.</Text>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              </div>
              <LayerCard className="px-5 py-4">
                <pre className="font-mono text-[0.9em] whitespace-pre-wrap text-kumo-default">
                  {testCase.prompt}
                </pre>
              </LayerCard>
            </section>

            <section className="grid gap-3">
              <div className="grid gap-1.5">
                <Text as="h2" variant="heading">
                  Generated Playwright spec
                </Text>
                <Text variant="secondary">
                  Regenerating after a failure feeds the error back into the prompt.
                </Text>
              </div>

              {testCase.generatedCode ? (
                <ShikiProvider engine="javascript" languages={['ts']}>
                  <CodeHighlighted
                    code={testCase.generatedCode}
                    lang="ts"
                    showLineNumbers
                    showCopyButton
                  />
                </ShikiProvider>
              ) : (
                <Empty
                  size="sm"
                  icon={<SparkleIcon size={32} className="text-kumo-inactive" />}
                  title="No code yet"
                  description="Generate a spec from the description above."
                  contents={
                    <Button
                      variant="primary"
                      icon={<SparkleIcon size={16} />}
                      loading={generate.isPending}
                      onClick={() => generate.mutate()}
                    >
                      Generate code
                    </Button>
                  }
                />
              )}
            </section>
          </div>

          <section className="grid content-start gap-3">
            <div className="grid gap-1.5">
              <Text as="h2" variant="heading">
                Run history
              </Text>
              <Text variant="secondary">Every attempt, newest first.</Text>
            </div>

            {runs.length === 0 ? (
              <Empty
                size="sm"
                icon={<PlayIcon size={32} className="text-kumo-inactive" />}
                title="No runs yet"
                description="Generate the spec, then run it."
              />
            ) : (
              <ol className="grid gap-2">
                {runs.map((runRow) => (
                  <li key={runRow.id}>
                    <RunRow run={runRow} />
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </PageBody>

      <EditTestCaseDialog testCase={testCase} open={editing} onOpenChange={setEditing} />
      <DeleteTestCaseDialog
        testCase={testCase}
        projectId={projectId}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </>
  )
}

type RunRowData = {
  id: string
  status: 'queued' | 'running' | 'passed' | 'failed' | 'error'
  attempt: number
  trigger: 'manual' | 'regenerate' | 'suite'
  durationMs: number | null
  startedAt: Date
  logs: string | null
}

function RunRow({ run }: { run: RunRowData }) {
  const [open, setOpen] = useState(false)

  return (
    <LayerCard className="px-4 py-3">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <RunStatusBadge status={run.status} />
              <Text as="span" variant="mono-secondary">
                #{run.attempt}
              </Text>
            </div>
            <Text as="span" variant="secondary" size="xs">
              {formatDuration(run.durationMs)}
            </Text>
          </div>

          <div className="flex items-center justify-between gap-3">
            <Text as="span" variant="secondary" size="xs">
              <RelativeTime value={run.startedAt} />
            </Text>
            {run.trigger === 'regenerate' ? (
              <Badge variant="blue" appearance="dot">
                repair
              </Badge>
            ) : null}
          </div>

          <Collapsible.DefaultTrigger className="text-xs">
            {open ? 'Hide output' : 'Show output'}
          </Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel>
            <pre className="max-h-72 overflow-auto rounded-md bg-kumo-recessed p-3 font-mono text-xs whitespace-pre-wrap text-kumo-default">
              {run.logs ?? 'No output captured.'}
            </pre>
          </Collapsible.DefaultPanel>
        </div>
      </Collapsible.Root>
    </LayerCard>
  )
}

function EditTestCaseDialog({
  testCase,
  open,
  onOpenChange,
}: {
  testCase: { id: string; title: string; prompt: string }
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="px-6 py-5">
        <EditTestCaseForm testCase={testCase} onOpenChange={onOpenChange} />
      </Dialog>
    </Dialog.Root>
  )
}

function EditTestCaseForm({
  testCase,
  onOpenChange,
}: {
  testCase: { id: string; title: string; prompt: string }
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const [title, setTitle] = useState(testCase.title)
  const [prompt, setPrompt] = useState(testCase.prompt)

  const mutation = useMutation({
    mutationFn: () =>
      updateTestCase({ data: { testCaseId: testCase.id, title: title.trim(), prompt } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: 'success',
        title: 'Description updated',
        description: 'Regenerate to compile the new steps.',
      })
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
      <div className="flex items-start justify-between gap-4">
        <Dialog.Title>
          <Text as="span" variant="heading">
            Edit test case
          </Text>
        </Dialog.Title>
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
          title="Could not save"
          description={mutation.error.message}
        />
      ) : null}

      <div className="grid gap-4">
        <Input
          label="Title"
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <InputArea
          label="What should happen?"
          autoResize
          minRows={8}
          maxRows={20}
          required
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
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
          disabled={!title.trim() || prompt.trim().length < 10}
        >
          Save changes
        </Button>
      </div>
    </form>
  )
}

function DeleteTestCaseDialog({
  testCase,
  projectId,
  open,
  onOpenChange,
}: {
  testCase: { id: string; title: string }
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const toast = useKumoToastManager()

  const mutation = useMutation({
    mutationFn: () => deleteTestCase({ data: { testCaseId: testCase.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Test case deleted' })
      onOpenChange(false)
      await navigate({ to: '/projects/$projectId', params: { projectId } })
    },
  })

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="px-6 py-5">
        <div className="grid gap-5">
          <div className="grid gap-1.5">
            <Dialog.Title>
              <Text as="span" variant="heading">
                Delete this test case?
              </Text>
            </Dialog.Title>
            <Dialog.Description>
              <Text as="span" variant="secondary">
                {testCase.title} and its run history will be removed. This cannot be undone.
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

          <div className="flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button {...props} variant="secondary">
                  Cancel
                </Button>
              )}
            />
            <Button
              variant="destructive"
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              Delete test case
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
