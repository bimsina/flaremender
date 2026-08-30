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
import {
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  DotsThreeIcon,
  FloppyDiskIcon,
  PlayIcon,
  TerminalWindowIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { PageBody, PageHeader } from '#/components/page.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { RunStatusBadge, TestCaseStatusBadge } from '#/components/status-badge.tsx'
import { formatDuration } from '#/lib/format.ts'
import { intentQuery, runsQuery, scriptVersionsQuery } from '#/lib/queries.ts'
import {
  deleteIntent,
  restoreScriptVersion,
  runIntent,
  saveScript,
  updateIntent,
} from '#/server/intents.ts'

export const Route = createFileRoute('/_app/projects/$projectId/intents/$intentId')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData({
        ...intentQuery(params.intentId),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...runsQuery(params.intentId),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...scriptVersionsQuery(params.intentId),
        revalidateIfStale: true,
      }),
    ])
  },
  component: IntentDetail,
})

const STARTER_SCRIPT = `import { expect, test } from '@playwright/test'

test('walks the happy path', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading')).toBeVisible()
})
`

function IntentDetail() {
  const { projectId, intentId } = Route.useParams()
  const { data } = useSuspenseQuery(intentQuery(intentId))
  const { data: runs } = useSuspenseQuery(runsQuery(intentId))
  const { data: versions } = useSuspenseQuery(scriptVersionsQuery(intentId))

  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [code, setCode] = useState(data.currentVersion?.code ?? STARTER_SCRIPT)

  const { intent, currentVersion, project } = data
  const lastRun = runs[0]
  const hasScript = currentVersion !== null
  const dirty = code !== (currentVersion?.code ?? STARTER_SCRIPT)

  const save = useMutation({
    mutationFn: () => saveScript({ data: { intentId, code } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: `Saved as v${result.version}` })
    },
  })

  // M7: an environment selector goes here; today the run targets the project's
  // default environment, which is what `runIntent` falls back to.
  //
  // The verdict no longer arrives with the response — a run is a Workflow now,
  // and this only queues it. M6 streams progress; until then the history table
  // catches up on the next refetch.
  const run = useMutation({
    mutationFn: () => runIntent({ data: { intentId } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'info', title: 'Run queued', description: result.runId })
    },
  })

  const busy = save.isPending || run.isPending
  const error = save.error ?? run.error

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
              Intent
            </Text>
          </div>
        }
        title={intent.title}
        description={currentVersion ? `Version ${currentVersion.version}` : 'No script saved yet'}
        actions={
          <>
            <Button
              variant={dirty ? 'primary' : 'secondary'}
              icon={<FloppyDiskIcon size={16} />}
              loading={save.isPending}
              disabled={busy || !dirty}
              onClick={() => save.mutate()}
            >
              Save script
            </Button>
            <Button
              variant={dirty ? 'secondary' : 'primary'}
              icon={<PlayIcon size={16} />}
              loading={run.isPending}
              disabled={busy || !hasScript}
              onClick={() => run.mutate()}
            >
              Run
            </Button>
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <Button variant="secondary" shape="square" aria-label="Intent actions">
                    <DotsThreeIcon size={16} weight="bold" />
                  </Button>
                }
              />
              <DropdownMenu.Content>
                <DropdownMenu.Item icon={TerminalWindowIcon} onClick={() => setEditing(true)}>
                  Edit description
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  icon={TrashIcon}
                  variant="danger"
                  onClick={() => setDeleting(true)}
                >
                  Delete intent
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          </>
        }
      />

      <PageBody className="grid gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <TestCaseStatusBadge status={intent.status} />
          {lastRun ? (
            <Text variant="secondary" size="xs">
              Last run <RelativeTime value={lastRun.startedAt} /> · {lastRun.environmentName} ·{' '}
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

        {intent.status === 'failing' && lastRun?.lastErrorMessage ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="The last run failed"
            description={lastRun.lastErrorMessage.split('\n')[0]}
          />
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="grid gap-6">
            <section className="grid gap-3">
              <div className="flex items-end justify-between gap-4">
                <div className="grid gap-1.5">
                  <Text as="h2" variant="heading">
                    Intent
                  </Text>
                  <Text variant="secondary">Plain English, and the permanent source of truth.</Text>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              </div>
              <LayerCard className="px-5 py-4">
                <pre className="font-mono text-[0.9em] whitespace-pre-wrap text-kumo-default">
                  {intent.description}
                </pre>
              </LayerCard>
            </section>

            <section className="grid gap-3">
              <div className="grid gap-1.5">
                <Text as="h2" variant="heading">
                  Playwright script
                </Text>
                <Text variant="secondary">
                  Every save is a new version in history. M7 replaces this box with a real editor.
                </Text>
              </div>
              <InputArea
                aria-label="Playwright script"
                className="font-mono"
                minRows={18}
                maxRows={40}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </section>
          </div>

          <div className="grid content-start gap-6">
            <section className="grid content-start gap-3">
              <div className="grid gap-1.5">
                <Text as="h2" variant="heading">
                  Version history
                </Text>
                <Text variant="secondary">Newest first.</Text>
              </div>

              {versions.length === 0 ? (
                <Empty
                  size="sm"
                  icon={<ClockCounterClockwiseIcon size={32} className="text-kumo-inactive" />}
                  title="No versions yet"
                  description="Save the script to start its history."
                />
              ) : (
                <ol className="grid gap-2">
                  {versions.map((version) => (
                    <li key={version.id}>
                      <VersionRow version={version} isCurrent={version.id === currentVersion?.id} />
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="grid content-start gap-3">
              <div className="grid gap-1.5">
                <Text as="h2" variant="heading">
                  Run history
                </Text>
                <Text variant="secondary">Every run, newest first.</Text>
              </div>

              {runs.length === 0 ? (
                <Empty
                  size="sm"
                  icon={<PlayIcon size={32} className="text-kumo-inactive" />}
                  title="No runs yet"
                  description="Save the script, then run it."
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
        </div>
      </PageBody>

      <EditIntentDialog intent={intent} open={editing} onOpenChange={setEditing} />
      <DeleteIntentDialog
        intent={intent}
        projectId={projectId}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </>
  )
}

type VersionRowData = {
  id: string
  version: number
  author: 'user' | 'agent'
  note: string | null
  createdByName: string
  createdAt: Date
  codeLength: number
}

function VersionRow({ version, isCurrent }: { version: VersionRowData; isCurrent: boolean }) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const restore = useMutation({
    mutationFn: () => restoreScriptVersion({ data: { versionId: version.id } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: `Restored as v${result.version}` })
    },
  })

  return (
    <LayerCard className="px-4 py-3">
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Text as="span" variant="mono-secondary">
              v{version.version}
            </Text>
            <Badge variant={version.author === 'agent' ? 'blue' : 'neutral'} appearance="dot">
              {version.author}
            </Badge>
            {isCurrent ? <Badge variant="success">current</Badge> : null}
          </div>
          <Text as="span" variant="secondary" size="xs">
            {version.codeLength} chars
          </Text>
        </div>

        <Text variant="secondary" size="xs">
          {version.note ?? 'No note'} · {version.createdByName} ·{' '}
          <RelativeTime value={version.createdAt} />
        </Text>

        {isCurrent ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            loading={restore.isPending}
            onClick={() => restore.mutate()}
          >
            Restore
          </Button>
        )}
      </div>
    </LayerCard>
  )
}

type RunRowData = {
  id: string
  status: 'queued' | 'running' | 'passed' | 'healed' | 'failed' | 'error'
  trigger: 'manual' | 'regenerate' | 'schedule'
  environmentName: string
  version: number
  durationMs: number | null
  startedAt: Date
  lastErrorMessage: string | null
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
                v{run.version}
              </Text>
            </div>
            <Text as="span" variant="secondary" size="xs">
              {formatDuration(run.durationMs)}
            </Text>
          </div>

          <div className="flex items-center justify-between gap-3">
            <Text as="span" variant="secondary" size="xs">
              <RelativeTime value={run.startedAt} /> · {run.environmentName}
            </Text>
            {run.trigger === 'schedule' ? (
              <Badge variant="blue" appearance="dot">
                scheduled
              </Badge>
            ) : null}
          </div>

          {/* M7: this drills into `getRun` for per-attempt logs and artifacts. */}
          <Collapsible.DefaultTrigger className="text-xs">
            {open ? 'Hide error' : 'Show error'}
          </Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel>
            <pre className="max-h-72 overflow-auto rounded-md bg-kumo-recessed p-3 font-mono text-xs whitespace-pre-wrap text-kumo-default">
              {run.lastErrorMessage ?? 'No error recorded.'}
            </pre>
          </Collapsible.DefaultPanel>
        </div>
      </Collapsible.Root>
    </LayerCard>
  )
}

function EditIntentDialog({
  intent,
  open,
  onOpenChange,
}: {
  intent: { id: string; title: string; description: string }
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="px-6 py-5">
        <EditIntentForm intent={intent} onOpenChange={onOpenChange} />
      </Dialog>
    </Dialog.Root>
  )
}

function EditIntentForm({
  intent,
  onOpenChange,
}: {
  intent: { id: string; title: string; description: string }
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const [title, setTitle] = useState(intent.title)
  const [description, setDescription] = useState(intent.description)

  const mutation = useMutation({
    mutationFn: () =>
      updateIntent({ data: { intentId: intent.id, title: title.trim(), description } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Intent updated' })
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
            Edit intent
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
          disabled={!title.trim() || description.trim().length < 10}
        >
          Save changes
        </Button>
      </div>
    </form>
  )
}

function DeleteIntentDialog({
  intent,
  projectId,
  open,
  onOpenChange,
}: {
  intent: { id: string; title: string }
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const toast = useKumoToastManager()

  const mutation = useMutation({
    mutationFn: () => deleteIntent({ data: { intentId: intent.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Intent deleted' })
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
                Delete this intent?
              </Text>
            </Dialog.Title>
            <Dialog.Description>
              <Text as="span" variant="secondary">
                {intent.title}, its script history and its runs will be removed. This cannot be
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
              Delete intent
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
