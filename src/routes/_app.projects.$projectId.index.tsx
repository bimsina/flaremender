import {
  Banner,
  Breadcrumbs,
  Button,
  Dialog,
  DropdownMenu,
  Empty,
  Input,
  InputArea,
  LayerCard,
  Select,
  Tabs,
  Text,
  Tooltip,
  useKumoToastManager,
} from '@cloudflare/kumo'
import {
  BinocularsIcon,
  ClockIcon,
  DotsThreeIcon,
  ListChecksIcon,
  PlayIcon,
  PlusIcon,
  SparkleIcon,
  TestTubeIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { EnvironmentsPanel } from '#/components/environments-panel.tsx'
import { InlineEmpty, ListRow, ListToolbar, Section, SettingRow } from '#/components/list.tsx'
import { PageBody, PageHeader } from '#/components/page.tsx'
import { ProjectOverview } from '#/components/project-overview.tsx'
import { ProjectChatTab } from '#/components/project-chat.tsx'
import { ProjectRunsTab } from '#/components/project-runs.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { IntentStatusBadge } from '#/components/status-badge.tsx'
import { SuiteProgress } from '#/components/suite-progress.tsx'
import type { IntentStatus } from '#/db/schema/app.ts'
import { describeCron } from '#/lib/cron.ts'
import {
  allowedModelsQuery,
  chatMessagesQuery,
  environmentsQuery,
  intentsQuery,
  projectQuery,
  projectRunsQuery,
  runTrendQuery,
  suiteRunsQuery,
} from '#/lib/queries.ts'
import {
  approveProposedIntents,
  dismissProposedIntent,
  exploreProject,
  setProjectContext,
} from '#/server/explore.ts'
import { createIntent, deleteIntent, runIntent } from '#/server/intents.ts'
import { deleteProject, setProjectModel, updateProject } from '#/server/projects.ts'
import { runSuite } from '#/server/suites.ts'

const TABS = ['overview', 'chat', 'intents', 'runs', 'environments', 'settings'] as const
type Tab = (typeof TABS)[number]

function isTab(value: unknown): value is Tab {
  return typeof value === 'string' && (TABS as ReadonlyArray<string>).includes(value)
}

export const Route = createFileRoute('/_app/projects/$projectId/')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    isTab(search.tab) ? { tab: search.tab } : {},
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
      context.queryClient.ensureQueryData({
        ...environmentsQuery(params.projectId),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...suiteRunsQuery(params.projectId),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...projectRunsQuery(params.projectId),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...runTrendQuery(params.projectId),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...chatMessagesQuery(params.projectId),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({ ...allowedModelsQuery(), revalidateIfStale: true }),
    ])
  },
  component: ProjectDetail,
})

function ProjectDetail() {
  const { projectId } = Route.useParams()
  const search = Route.useSearch()
  const tab = search.tab ?? 'overview'
  const navigate = useNavigate({ from: Route.fullPath })

  const { data: project } = useSuspenseQuery(projectQuery(projectId))
  const { data: intents } = useSuspenseQuery(intentsQuery(projectId))
  const { data: environments } = useSuspenseQuery(environmentsQuery(projectId))
  const { data: suiteRuns } = useSuspenseQuery(suiteRunsQuery(projectId))

  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [addingIntent, setAddingIntent] = useState(false)
  const [environmentId, setEnvironmentId] = useState<string | null>(null)
  const [watchingSuite, setWatchingSuite] = useState<string | null>(null)

  const runnableCount = intents.filter(
    (row) => row.currentVersion > 0 && row.readiness === 'ready' && row.status !== 'proposed',
  ).length

  const defaultEnvironment = environments.find((row) => row.isDefault) ?? environments[0] ?? null
  const targetEnvironmentId = environmentId ?? defaultEnvironment?.id ?? null

  const inFlightSuite = suiteRuns.find((row) => row.status === 'queued' || row.status === 'running')
  const liveSuiteRunId = watchingSuite ?? inFlightSuite?.id ?? null

  const suite = useMutation({
    mutationFn: () =>
      runSuite({
        data: {
          projectId,
          ...(targetEnvironmentId ? { environmentId: targetEnvironmentId } : {}),
        },
      }),
    onSuccess: async (result) => {
      setWatchingSuite(result.suiteRunId)
      await queryClient.invalidateQueries()
      if (tab !== 'intents') void navigate({ search: { tab: 'intents' }, replace: true })
      toast.add({
        variant: 'info',
        title: 'Suite queued',
        description: `${runnableCount} test${runnableCount === 1 ? '' : 's'} will run one after another.`,
      })
    },
    onError: (error: Error) => {
      toast.add({
        variant: 'error',
        title: 'Could not start the suite',
        description: error.message,
      })
    },
  })

  const environmentItems = useMemo(
    () =>
      environments.map((row) => ({
        label: row.isDefault ? `${row.name} (default)` : row.name,
        value: row.id,
      })),
    [environments],
  )

  const runAllDisabled = runnableCount === 0 || targetEnvironmentId === null

  const runAllButton = (
    <Button
      variant="secondary"
      icon={<PlayIcon size={16} />}
      loading={suite.isPending}
      disabled={runAllDisabled}
      onClick={() => suite.mutate()}
    >
      Run suite
    </Button>
  )

  return (
    <>
      <PageHeader
        breadcrumbs={
          <Breadcrumbs size="base">
            <Breadcrumbs.Link href="/projects">Projects</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Current>{project.name}</Breadcrumbs.Current>
          </Breadcrumbs>
        }
        title={project.name}
        description={project.description ?? project.defaultEnvironment?.baseUrl ?? undefined}
        tabs={
          <Tabs
            labels={{ scrollStart: 'Scroll tabs left', scrollEnd: 'Scroll tabs right' }}
            variant="segmented"
            tabs={[
              { value: 'overview', label: 'Overview' },
              { value: 'chat', label: 'Chat' },
              { value: 'intents', label: 'Tests' },
              { value: 'runs', label: 'Runs' },
              { value: 'environments', label: 'Environments' },
              { value: 'settings', label: 'Settings' },
            ]}
            value={tab}
            onValueChange={(value) => {
              if (isTab(value)) void navigate({ search: { tab: value }, replace: true })
            }}
          />
        }
        tabActions={
          tab === 'intents' ? (
            <>
              {environments.length > 1 ? (
                <Select
                  aria-label="Environment"
                  className="w-52"
                  placeholder="No environment"
                  items={environmentItems}
                  value={targetEnvironmentId}
                  onValueChange={(value: string | null) => setEnvironmentId(value)}
                />
              ) : null}
              {runAllDisabled ? (
                <Tooltip
                  content={
                    runnableCount === 0
                      ? 'Mark at least one saved test ready first.'
                      : 'Add an environment before running anything.'
                  }
                  render={<span className="inline-flex" />}
                >
                  {runAllButton}
                </Tooltip>
              ) : (
                runAllButton
              )}
              <Button
                variant="primary"
                icon={<PlusIcon size={16} />}
                onClick={() => setAddingIntent(true)}
              >
                New test
              </Button>
            </>
          ) : null
        }
      />

      <PageBody className={tab === 'chat' ? 'flex min-h-0 flex-col' : 'grid gap-6'}>
        {tab === 'overview' ? (
          <ProjectOverview
            projectId={projectId}
            tests={intents}
            environments={environments}
            environmentId={targetEnvironmentId}
            onEnvironmentChange={setEnvironmentId}
            onCreateManual={() => setAddingIntent(true)}
            onRun={() => suite.mutate()}
            running={suite.isPending}
          />
        ) : null}
        {tab === 'chat' ? <ProjectChatTab projectId={projectId} /> : null}
        {tab === 'intents' ? (
          <IntentsTab
            projectId={projectId}
            intents={intents}
            liveSuiteRunId={liveSuiteRunId}
            onCreate={() => setAddingIntent(true)}
          />
        ) : null}
        {tab === 'runs' ? (
          <ProjectRunsTab
            projectId={projectId}
            environments={environments}
            liveSuiteRunId={liveSuiteRunId}
          />
        ) : null}
        {tab === 'environments' ? <EnvironmentsPanel projectId={projectId} /> : null}
        {tab === 'settings' ? <SettingsTab project={project} /> : null}
      </PageBody>

      <CreateIntentDialog
        projectId={projectId}
        open={addingIntent}
        onOpenChange={setAddingIntent}
      />
    </>
  )
}

type IntentRow = {
  id: string
  title: string
  description: string
  status: IntentStatus
  schedule: string | null
  currentVersion: number
  updatedAt: Date
  lastRunEnvironmentName: string | null
  lastRunAt: Date | null
}

const STATUS_FILTERS = {
  all: 'Any status',
  proposed: 'Proposed',
  draft: 'Draft',
  generating: 'Generating',
  ready: 'Ready to run',
  passing: 'Passing',
  failing: 'Failing',
} as const

type StatusFilter = keyof typeof STATUS_FILTERS

function IntentsTab({
  projectId,
  intents,
  liveSuiteRunId,
  onCreate,
}: {
  projectId: string
  intents: Array<IntentRow>
  liveSuiteRunId: string | null
  onCreate: () => void
}) {
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return intents.filter((row) => {
      if (status !== 'all' && row.status !== status) return false
      if (!needle) return true
      return `${row.title} ${row.description}`.toLowerCase().includes(needle)
    })
  }, [intents, search, status])

  if (intents.length === 0) {
    return (
      <Empty
        icon={<TestTubeIcon size={48} className="text-kumo-inactive" />}
        title="No tests found"
        description="Describe what a user should be able to do — or let the assistant go round your app and suggest what is worth testing."
        contents={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" icon={<PlusIcon size={16} />} onClick={onCreate}>
              Describe a test
            </Button>
            <ExploreButton projectId={projectId} />
          </div>
        }
      />
    )
  }

  const proposedCount = intents.filter((row) => row.status === 'proposed').length

  return (
    <div className="grid gap-4">
      {liveSuiteRunId ? (
        <SuiteProgress key={liveSuiteRunId} suiteRunId={liveSuiteRunId} projectId={projectId} />
      ) : null}

      {proposedCount > 0 && status !== 'proposed' ? (
        <Banner
          variant="default"
          icon={<ListChecksIcon weight="fill" />}
          title={`${proposedCount} proposed test${proposedCount === 1 ? '' : 's'} to review`}
          description="Proposals do not run and are not counted until you approve them."
          action={<Banner.Action onClick={() => setStatus('proposed')}>Review them</Banner.Action>}
        />
      ) : null}

      <ListToolbar
        value={search}
        onValueChange={setSearch}
        placeholder="Search tests"
        onRefresh={() => {
          void queryClient.invalidateQueries({ queryKey: intentsQuery(projectId).queryKey })
        }}
      >
        <Select
          aria-label="Filter by status"
          className="w-40"
          items={STATUS_FILTERS}
          value={status}
          onValueChange={(value: StatusFilter | null) => setStatus(value ?? 'all')}
        />
      </ListToolbar>

      {visible.length === 0 ? (
        <LayerCard className="px-5 py-4">
          <InlineEmpty message="No tests match this search." />
        </LayerCard>
      ) : (
        <ul className="grid gap-3">
          {visible.map((row) => (
            <li key={row.id}>
              <ListRow
                icon={<TestTubeIcon size={18} />}
                title={
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Link
                      to="/projects/$projectId/intents/$intentId"
                      params={{ projectId, intentId: row.id }}
                      className="truncate font-medium text-kumo-default hover:text-kumo-link"
                    >
                      {row.title}
                    </Link>
                    <IntentStatusBadge status={row.status} />
                  </div>
                }
                subtitle={
                  <Text variant="secondary" size="base" truncate>
                    {row.description.split('\n')[0]}
                  </Text>
                }
                meta={
                  <>
                    {row.schedule ? <ScheduleHint schedule={row.schedule} /> : null}
                    <Text as="span" variant="secondary" size="base">
                      {row.lastRunAt ? (
                        <>
                          v{row.currentVersion} · {row.lastRunEnvironmentName ?? 'Regression'} ·{' '}
                          <RelativeTime value={row.lastRunAt} />
                        </>
                      ) : (
                        'No regression result'
                      )}
                    </Text>
                  </>
                }
                actions={
                  <IntentActions
                    projectId={projectId}
                    intent={row}
                    runnable={row.currentVersion > 0}
                  />
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ExploreButton({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const explore = useMutation({
    mutationFn: () => exploreProject({ data: { projectId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      await navigate({
        to: '/projects/$projectId',
        params: { projectId },
        search: { tab: 'chat' },
      })
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not explore', description: error.message }),
  })

  return (
    <Button
      variant="secondary"
      icon={<BinocularsIcon size={16} />}
      loading={explore.isPending}
      onClick={() => explore.mutate()}
    >
      Explore my app
    </Button>
  )
}

function ScheduleHint({ schedule }: { schedule: string }) {
  return (
    <Tooltip
      content={`${describeCron(schedule)}, UTC`}
      render={<span className="inline-flex text-kumo-subtle" />}
    >
      <ClockIcon size={16} aria-label="Scheduled" />
    </Tooltip>
  )
}

function IntentActions({
  projectId,
  intent,
  runnable,
}: {
  projectId: string
  intent: IntentRow
  runnable: boolean
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const [deleting, setDeleting] = useState(false)

  const run = useMutation({
    mutationFn: () => runIntent({ data: { intentId: intent.id } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'info', title: 'Run queued', description: result.runId })
    },
    onError: (error: Error) => {
      toast.add({ variant: 'error', title: 'Could not queue the run', description: error.message })
    },
  })

  const remove = useMutation({
    mutationFn: () => deleteIntent({ data: { intentId: intent.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      setDeleting(false)
      toast.add({ variant: 'success', title: 'Intent deleted', description: intent.title })
    },
  })

  const approve = useMutation({
    mutationFn: () => approveProposedIntents({ data: { projectId, intentIds: [intent.id] } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: 'info',
        title: 'Generating',
        description: `Writing the script for “${intent.title}”.`,
      })
    },
    onError: (error: Error) => {
      toast.add({ variant: 'error', title: 'Could not approve', description: error.message })
    },
  })

  const dismiss = useMutation({
    mutationFn: () => dismissProposedIntent({ data: { intentId: intent.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Proposal dismissed', description: intent.title })
    },
    onError: (error: Error) => {
      toast.add({ variant: 'error', title: 'Could not dismiss', description: error.message })
    },
  })

  const proposed = intent.status === 'proposed'

  return (
    <>
      {proposed ? (
        <>
          <Button
            variant="secondary"
            size="sm"
            icon={<SparkleIcon size={14} />}
            loading={approve.isPending}
            onClick={() => approve.mutate()}
          >
            Approve
          </Button>
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label={`Dismiss ${intent.title}`}
            loading={dismiss.isPending}
            onClick={() => dismiss.mutate()}
          >
            <XIcon size={16} />
          </Button>
        </>
      ) : null}

      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              aria-label={`Actions for ${intent.title}`}
            >
              <DotsThreeIcon size={16} weight="bold" />
            </Button>
          }
        />
        <DropdownMenu.Content>
          <DropdownMenu.LinkItem
            href={`/projects/${projectId}/intents/${intent.id}`}
            icon={TestTubeIcon}
          >
            Open
          </DropdownMenu.LinkItem>
          <DropdownMenu.Item
            icon={PlayIcon}
            disabled={!runnable || proposed || run.isPending}
            onClick={() => run.mutate()}
          >
            Run
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item icon={TrashIcon} variant="danger" onClick={() => setDeleting(true)}>
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>

      <Dialog.Root open={deleting} onOpenChange={setDeleting}>
        <Dialog className="px-6 py-5">
          <div className="grid gap-5">
            <div className="grid gap-1.5">
              <Dialog.Title>
                <Text as="span" variant="heading">
                  Delete this test?
                </Text>
              </Dialog.Title>
              <Dialog.Description>
                <Text as="span" variant="secondary">
                  {intent.title}, its script history and its runs will be removed. This cannot be
                  undone.
                </Text>
              </Dialog.Description>
            </div>

            {remove.error ? (
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" />}
                title="Could not delete"
                description={remove.error.message}
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
                loading={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Delete test
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  )
}

type ProjectRow = {
  id: string
  name: string
  slug: string
  description: string | null
  context: string | null
  modelId: string | null
  effectiveModel: { modelId: string; displayName: string; origin: string }
  defaultEnvironment: { id: string; name: string; baseUrl: string } | null
}

function SettingsTab({ project }: { project: ProjectRow }) {
  return (
    <div className="grid max-w-3xl gap-8">
      <Section title="Project details" description="How this project is named and described.">
        <ProjectDetailsCard project={project} />
      </Section>

      <Section
        title="What the assistant knows"
        description="Background about this app, read by every exploration and every generated script."
      >
        <ProjectContextCard project={project} />
      </Section>

      <Section
        title="Model"
        description="Which model generates and repairs scripts in this project."
      >
        <ProjectModelCard project={project} />
      </Section>

      <Section
        title="Danger zone"
        description="Destructive and permanent. There is no undo and no export."
      >
        <DeleteProjectCard project={project} />
      </Section>
    </div>
  )
}

function ProjectDetailsCard({ project }: { project: ProjectRow }) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')

  const dirty = name !== project.name || description !== (project.description ?? '')

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
    },
  })

  return (
    <LayerCard className="px-5 py-4">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          mutation.mutate()
        }}
      >
        {mutation.error ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="Could not save"
            description={mutation.error.message}
          />
        ) : null}

        <Input
          label="Name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <InputArea
          label="Description"
          description="Optional. What this suite covers."
          autoResize
          minRows={3}
          maxRows={8}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />

        <div className="flex items-center justify-between gap-3">
          <Text variant="secondary" size="base">
            Base URLs live on environments, not here.
          </Text>
          <Button
            type="submit"
            variant="primary"
            loading={mutation.isPending}
            disabled={!name.trim() || !dirty}
          >
            Save changes
          </Button>
        </div>
      </form>
    </LayerCard>
  )
}

function ProjectContextCard({ project }: { project: ProjectRow }) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [context, setContext] = useState(project.context ?? '')

  const [seen, setSeen] = useState(project.context ?? '')
  if (seen !== (project.context ?? '')) {
    setSeen(project.context ?? '')
    setContext(project.context ?? '')
  }

  const dirty = context !== (project.context ?? '')

  const mutation = useMutation({
    mutationFn: () =>
      setProjectContext({ data: { projectId: project.id, context: context.trim() || null } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: projectQuery(project.id).queryKey })
      toast.add({ variant: 'success', title: 'Saved' })
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not save', description: error.message }),
  })

  return (
    <LayerCard className="px-5 py-4">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          mutation.mutate()
        }}
      >
        <InputArea
          label="Context"
          description="What this app is, how to sign in, anything a test author would need. Refer to credentials by variable name — never paste a value."
          placeholder="Taskbox is a task manager. Sign in from the landing page with TASKBOX_EMAIL and TASKBOX_PASSWORD."
          autoResize
          minRows={4}
          maxRows={16}
          value={context}
          onChange={(event) => setContext(event.target.value)}
        />

        <div className="flex items-center justify-between gap-3">
          <Text variant="secondary" size="base">
            {context.length} characters
          </Text>
          <Button type="submit" variant="primary" loading={mutation.isPending} disabled={!dirty}>
            Save context
          </Button>
        </div>
      </form>
    </LayerCard>
  )
}

const INSTANCE_DEFAULT = '__instance-default'

function ProjectModelCard({ project }: { project: ProjectRow }) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const { data: allowed } = useSuspenseQuery(allowedModelsQuery())

  const mutation = useMutation({
    mutationFn: (modelId: string | null) =>
      setProjectModel({ data: { projectId: project.id, modelId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Model updated' })
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not save', description: error.message }),
  })

  const items = useMemo(() => {
    const entries: Record<string, string> = { [INSTANCE_DEFAULT]: 'Instance default' }
    for (const model of allowed) entries[model.modelId] = model.displayName
    return entries
  }, [allowed])

  return (
    <SettingRow
      label="Model"
      hint={
        project.effectiveModel.origin === 'project'
          ? `Runs use ${project.effectiveModel.displayName}.`
          : project.effectiveModel.origin === 'instance'
            ? `Runs use ${project.effectiveModel.displayName}, this instance's default.`
            : `Runs use ${project.effectiveModel.displayName}, the Workers AI fallback.`
      }
    >
      <Select
        aria-label="Model"
        className="w-64"
        items={items}
        loading={mutation.isPending}
        value={project.modelId ?? INSTANCE_DEFAULT}
        onValueChange={(value: string | null) =>
          mutation.mutate(!value || value === INSTANCE_DEFAULT ? null : value)
        }
      />
    </SettingRow>
  )
}

function DeleteProjectCard({ project }: { project: ProjectRow }) {
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
      await navigate({ to: '/projects' })
    },
  })

  return (
    <LayerCard className="px-5 py-4 ring ring-kumo-danger/30">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          mutation.mutate()
        }}
      >
        <div className="grid gap-1.5">
          <Text as="h3" bold>
            Delete this project
          </Text>
          <Text variant="secondary" size="base">
            Every environment, intent, script version and run under {project.name} goes with it.
          </Text>
        </div>

        {mutation.error ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="Could not delete"
            description={mutation.error.message}
          />
        ) : null}

        <div className="flex flex-wrap items-end justify-between gap-3">
          <Input
            className="min-w-64"
            label={`Type "${project.name}" to confirm`}
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
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
    </LayerCard>
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
        search: { mode: 'manual' },
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
              Describe a test
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
          title="Could not create test"
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
          Create test
        </Button>
      </div>
    </form>
  )
}
