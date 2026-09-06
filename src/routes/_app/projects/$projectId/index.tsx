import {
  Banner,
  Breadcrumbs,
  Button,
  Dialog,
  DropdownMenu,
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
  FolderIcon,
  KeyIcon,
  ListChecksIcon,
  PlayIcon,
  SparkleIcon,
  TestTubeIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { EnvironmentsPanel } from '#/components/project/environments-panel.tsx'
import { InlineEmpty, ListRow, ListToolbar, Section, SettingRow } from '#/components/ui/list.tsx'
import { PageBody, PageHeader } from '#/components/layout/page.tsx'
import { NewTestMenu } from '#/components/project/new-test-menu.tsx'
import { NotificationsPanel } from '#/components/project/notifications-panel.tsx'
import { ProjectFilesCard } from '#/components/project/project-files-card.tsx'
import { QuickTestBox } from '#/components/project/quick-test-box.tsx'
import { MonoPanel } from '#/components/ui/mono-panel.tsx'
import { ProjectOverview } from '#/components/project/project-overview.tsx'
import { ProjectChatTab } from '#/components/project/project-chat.tsx'
import { ProjectRunsTab } from '#/components/project/project-runs.tsx'
import { RelativeTime } from '#/components/ui/relative-time.tsx'
import { IntentStatusBadge } from '#/components/ui/status-badge.tsx'
import { SuiteProgress } from '#/components/runs/suite-progress.tsx'
import type { IntentStatus, RunStatus } from '#/db/schema/app.ts'
import { describeCron } from '#/lib/cron.ts'
import { formatCount } from '#/lib/format.ts'
import {
  HEAL_POLICY_LABEL,
  HealPolicySelect,
  describeHealPolicy,
} from '#/components/org/heal-policy-select.tsx'
import type { HealPolicy, HealPolicyChoice } from '#/db/schema/app.ts'
import { setProjectHealPolicy } from '#/server/runs/repairs.ts'
import {
  allowedModelsQuery,
  chatMessagesQuery,
  environmentsQuery,
  intentsQuery,
  projectQuery,
  notificationDestinationsQuery,
  projectFilesQuery,
  projectWebhookSettingsQuery,
  projectRunsQuery,
  runTrendQuery,
  suiteRunsQuery,
} from '#/lib/queries.ts'
import {
  approveProposedIntents,
  dismissProposedIntent,
  exploreProject,
  setProjectContext,
} from '#/server/projects/explore.ts'
import { createIntent, deleteIntent, runIntent } from '#/server/runs/intents.ts'
import { deleteProject, setProjectModel, updateProject } from '#/server/projects/projects.ts'
import { runSuite } from '#/server/runs/suites.ts'
import { createProjectWebhookKey, revokeProjectWebhookKey } from '#/server/api/webhook-settings.ts'

const TABS = ['overview', 'chat', 'intents', 'runs', 'environments', 'settings'] as const
type Tab = (typeof TABS)[number]

const TEST_READINESS_FILTERS = ['all', 'proposed', 'draft', 'ready'] as const
type TestReadinessFilter = (typeof TEST_READINESS_FILTERS)[number]
const TEST_RESULT_FILTERS = ['all', 'passed', 'failed', 'error', 'not-run'] as const
type TestResultFilter = (typeof TEST_RESULT_FILTERS)[number]
const RUN_STATUS_FILTERS = ['all', 'passed', 'failed', 'error', 'running'] as const
type RunStatusFilter = (typeof RUN_STATUS_FILTERS)[number]
const RUN_TRIGGER_FILTERS = ['all', 'manual', 'regenerate', 'schedule', 'webhook'] as const
type RunTriggerFilter = (typeof RUN_TRIGGER_FILTERS)[number]

function isTab(value: unknown): value is Tab {
  return typeof value === 'string' && (TABS as ReadonlyArray<string>).includes(value)
}

function oneOf<const Values extends ReadonlyArray<string>>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === 'string' && values.includes(value)
}

type ProjectSearch = {
  tab?: Tab
  environmentId?: string
  variable?: string
  editEnvironment?: 'edit'
  testsQuery?: string
  testReadiness?: TestReadinessFilter
  testResult?: TestResultFilter
  runsQuery?: string
  runStatus?: RunStatusFilter
  runTrigger?: RunTriggerFilter
}

export const Route = createFileRoute('/_app/projects/$projectId/')({
  validateSearch: (search: Record<string, unknown>): ProjectSearch => ({
    ...(isTab(search.tab) ? { tab: search.tab } : {}),
    ...(typeof search.environmentId === 'string' ? { environmentId: search.environmentId } : {}),
    ...(typeof search.variable === 'string' ? { variable: search.variable } : {}),
    ...(search.editEnvironment === 'edit' ||
    search.editEnvironment === true ||
    search.editEnvironment === 'true'
      ? { editEnvironment: 'edit' as const }
      : {}),
    ...(typeof search.testsQuery === 'string' ? { testsQuery: search.testsQuery } : {}),
    ...(oneOf(TEST_READINESS_FILTERS, search.testReadiness)
      ? { testReadiness: search.testReadiness }
      : {}),
    ...(oneOf(TEST_RESULT_FILTERS, search.testResult) ? { testResult: search.testResult } : {}),
    ...(typeof search.runsQuery === 'string' ? { runsQuery: search.runsQuery } : {}),
    ...(oneOf(RUN_STATUS_FILTERS, search.runStatus) ? { runStatus: search.runStatus } : {}),
    ...(oneOf(RUN_TRIGGER_FILTERS, search.runTrigger) ? { runTrigger: search.runTrigger } : {}),
  }),
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
      context.queryClient.ensureQueryData({
        ...projectFilesQuery(params.projectId),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...notificationDestinationsQuery(params.projectId),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...projectWebhookSettingsQuery(params.projectId),
        revalidateIfStale: true,
      }),
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
  const [watchingSuite, setWatchingSuite] = useState<string | null>(null)

  const runnableCount = intents.filter(
    (row) => row.currentVersion > 0 && row.readiness === 'ready' && row.status !== 'proposed',
  ).length

  const defaultEnvironment = environments.find((row) => row.isDefault) ?? environments[0] ?? null
  const requestedEnvironment = environments.find((row) => row.id === search.environmentId)
  const targetEnvironmentId = requestedEnvironment?.id ?? defaultEnvironment?.id ?? null

  const updateSearch = (patch: Partial<ProjectSearch>) =>
    void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true })

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
      if (tab !== 'intents') updateSearch({ tab: 'intents' })
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
      Run {runnableCount} test{runnableCount === 1 ? '' : 's'}
    </Button>
  )

  return (
    <>
      <PageHeader
        compact
        breadcrumbs={
          <Breadcrumbs size="base">
            <Breadcrumbs.Link href="/projects">
              <span className="inline-flex items-center gap-1.5">
                <FolderIcon size={16} className="text-kumo-subtle" />
                Projects
              </span>
            </Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Current>{project.name}</Breadcrumbs.Current>
          </Breadcrumbs>
        }
        title={project.name}
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
              if (isTab(value)) updateSearch({ tab: value })
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
                  onValueChange={(value: string | null) =>
                    updateSearch({ environmentId: value ?? undefined })
                  }
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
              <NewTestMenu projectId={projectId} onCreateManual={() => setAddingIntent(true)} />
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
            onEnvironmentChange={(value) => updateSearch({ environmentId: value ?? undefined })}
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
            search={search.testsQuery ?? ''}
            readiness={search.testReadiness ?? 'all'}
            result={search.testResult ?? 'all'}
            onFiltersChange={(patch) => updateSearch(patch)}
          />
        ) : null}
        {tab === 'runs' ? (
          <ProjectRunsTab
            projectId={projectId}
            environments={environments}
            liveSuiteRunId={liveSuiteRunId}
            search={search.runsQuery ?? ''}
            status={search.runStatus ?? 'all'}
            trigger={search.runTrigger ?? 'all'}
            environmentId={search.environmentId ?? 'all'}
            onFiltersChange={(patch) => updateSearch(patch)}
          />
        ) : null}
        {tab === 'environments' ? (
          <EnvironmentsPanel
            projectId={projectId}
            focusEnvironmentId={search.environmentId}
            focusVariable={search.variable}
            editEnvironment={search.editEnvironment === 'edit'}
          />
        ) : null}
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
  readiness: 'draft' | 'ready'
  schedule: string | null
  currentVersion: number
  updatedAt: Date
  lastRunEnvironmentName: string | null
  lastRunAt: Date | null
  lastRunStatus: RunStatus | null
}

const READINESS_FILTERS = {
  all: 'Any readiness',
  proposed: 'Proposed',
  draft: 'Draft',
  ready: 'Ready to run',
} as const

const RESULT_FILTERS = {
  all: 'Any result',
  passed: 'Passed',
  failed: 'Failed',
  error: 'Errored',
  'not-run': 'Not run',
} as const

function IntentsTab({
  projectId,
  intents,
  liveSuiteRunId,
  onCreate,
  search,
  readiness,
  result,
  onFiltersChange,
}: {
  projectId: string
  intents: Array<IntentRow>
  liveSuiteRunId: string | null
  onCreate: () => void
  search: string
  readiness: TestReadinessFilter
  result: TestResultFilter
  onFiltersChange: (patch: Partial<ProjectSearch>) => void
}) {
  const queryClient = useQueryClient()

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return intents.filter((row) => {
      const rowReadiness = row.status === 'proposed' ? 'proposed' : row.readiness
      if (readiness !== 'all' && rowReadiness !== readiness) return false
      const rowResult = row.lastRunStatus === 'healed' ? 'passed' : (row.lastRunStatus ?? 'not-run')
      if (result !== 'all' && rowResult !== result) return false
      if (!needle) return true
      return `${row.title} ${row.description}`.toLowerCase().includes(needle)
    })
  }, [intents, search, readiness, result])

  if (intents.length === 0) {
    return (
      <div className="grid gap-4">
        <LayerCard className="px-5 py-4">
          <div className="grid gap-3">
            <div className="grid gap-1">
              <Text as="h2" variant="heading">
                What should this app be able to do?
              </Text>
              <Text variant="secondary">
                Say it in a sentence and the agent writes the test in a real browser. Or send it
                round the app first and let it propose a suite.
              </Text>
            </div>
            <QuickTestBox projectId={projectId} autoFocus />
          </div>
        </LayerCard>
        <div className="flex flex-wrap items-center gap-2">
          <ExploreButton projectId={projectId} />
          <NewTestMenu projectId={projectId} onCreateManual={onCreate} variant="secondary" />
        </div>
      </div>
    )
  }

  const proposedCount = intents.filter((row) => row.status === 'proposed').length

  return (
    <div className="grid gap-4">
      <LayerCard className="px-5 py-3">
        <QuickTestBox projectId={projectId} compact />
      </LayerCard>

      {liveSuiteRunId ? (
        <SuiteProgress key={liveSuiteRunId} suiteRunId={liveSuiteRunId} projectId={projectId} />
      ) : null}

      {proposedCount > 0 && readiness !== 'proposed' ? (
        <Banner
          variant="default"
          icon={<ListChecksIcon weight="fill" />}
          title={`${proposedCount} proposed test${proposedCount === 1 ? '' : 's'} to review`}
          description="Proposals do not run and are not counted until you approve them."
          action={
            <Banner.Action onClick={() => onFiltersChange({ testReadiness: 'proposed' })}>
              Review them
            </Banner.Action>
          }
        />
      ) : null}

      <ListToolbar
        value={search}
        onValueChange={(value) => onFiltersChange({ testsQuery: value || undefined })}
        placeholder="Search tests"
        onRefresh={() => {
          void queryClient.invalidateQueries({ queryKey: intentsQuery(projectId).queryKey })
        }}
      >
        <Select
          aria-label="Filter by readiness"
          className="w-44"
          items={READINESS_FILTERS}
          value={readiness}
          onValueChange={(value: TestReadinessFilter | null) =>
            onFiltersChange({ testReadiness: value === 'all' ? undefined : (value ?? undefined) })
          }
        />
        <Select
          aria-label="Filter by result"
          className="w-40"
          items={RESULT_FILTERS}
          value={result}
          onValueChange={(value: TestResultFilter | null) =>
            onFiltersChange({ testResult: value === 'all' ? undefined : (value ?? undefined) })
          }
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
    mutationFn: () => exploreProject({ data: { projectId, autoGenerate: true } }),
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
      Explore and write tests
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
      toast.add({ variant: 'success', title: 'Test deleted', description: intent.title })
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
  usage: { jobs: number; chatTurns: number; inputTokens: number; outputTokens: number }
  healPolicy: { effective: HealPolicy; project: HealPolicyChoice; organization: HealPolicy }
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
        <ProjectFilesCard projectId={project.id} />
      </Section>

      <Section title="Model" description="Which model generates scripts in this project.">
        <ProjectModelCard project={project} />
        <ProjectUsageRow project={project} />
      </Section>

      <Section
        title="Repairs"
        description="What the agent may do when a ready test in this project fails. Tests can override it."
      >
        <ProjectRepairPolicyRow project={project} />
      </Section>

      <Section
        title="Webhooks"
        description="Trigger this project or one ready test from CI and other external systems."
      >
        <ProjectWebhooksCard projectId={project.id} />
      </Section>

      <Section
        title="Notifications"
        description="Where failures, suite results and repairs are sent: Slack, Discord, a signed webhook or email."
      >
        <NotificationsPanel projectId={project.id} />
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

const WEBHOOK_EXPIRATIONS = {
  '30': '30 days',
  '90': '90 days',
  '365': 'One year',
  never: 'No expiration',
} as const

function ProjectWebhooksCard({ projectId }: { projectId: string }) {
  const { data } = useSuspenseQuery(projectWebhookSettingsQuery(projectId))
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('CI webhook')
  const [expiration, setExpiration] = useState<keyof typeof WEBHOOK_EXPIRATIONS>('90')
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null)

  const createKey = useMutation({
    mutationFn: () =>
      createProjectWebhookKey({
        data: {
          projectId,
          name: name.trim(),
          expiresInDays: expiration === 'never' ? null : Number(expiration),
        },
      }),
    onSuccess: async (result) => {
      setCreatedKey(result.key)
      await queryClient.invalidateQueries({
        queryKey: projectWebhookSettingsQuery(projectId).queryKey,
      })
    },
  })

  const revokeKey = useMutation({
    mutationFn: (keyId: string) => revokeProjectWebhookKey({ data: { projectId, keyId } }),
    onSuccess: async () => {
      setRevokeTarget(null)
      await queryClient.invalidateQueries({
        queryKey: projectWebhookSettingsQuery(projectId).queryKey,
      })
      toast.add({ variant: 'success', title: 'API key revoked' })
    },
  })

  const curl = [
    'curl --request POST \\',
    `  --url "${data.projectRunUrl}" \\`,
    '  --header "Authorization: Bearer $KUMO_API_KEY" \\',
    '  --header "Content-Type: application/json" \\',
    '  --header "Idempotency-Key: deploy-$CI_COMMIT_SHA" \\',
    `  --data '{"environmentId":"your-environment-id"}'`,
  ].join('\n')

  return (
    <>
      <LayerCard className="grid gap-5 px-5 py-4">
        <div className="grid gap-1.5">
          <Text as="h3" bold>
            Inbound run endpoints
          </Text>
          <Text variant="secondary" size="base">
            Send an empty JSON body to use the default environment. Poll the returned statusUrl
            until the execution finishes.
          </Text>
        </div>

        <div className="grid gap-3">
          <MonoPanel label="Run every ready test" text={data.projectRunUrl} />
          <MonoPanel label="Run one ready test" text={data.testRunUrl} />
          <MonoPanel label="curl example" text={curl} />
        </div>

        <div className="flex flex-wrap items-start justify-between gap-3 border-t border-kumo-line pt-4">
          <div className="grid gap-1">
            <Text as="h3" bold>
              Project API keys
            </Text>
            <Text variant="secondary" size="base">
              Use the Bearer header. Never put API keys in URLs or commit them to a repository.
            </Text>
          </div>
          {data.canManage ? (
            <Button
              variant="primary"
              icon={<KeyIcon size={16} />}
              onClick={() => {
                setCreatedKey(null)
                setCreating(true)
              }}
            >
              Create API key
            </Button>
          ) : null}
        </div>

        {data.canManage ? (
          data.keys.length > 0 ? (
            <div className="divide-y divide-kumo-line ring ring-kumo-line rounded-md">
              {data.keys.map((key) => (
                <div
                  key={key.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="grid min-w-0 gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <Text as="span" bold>
                        {key.name}
                      </Text>
                      <Text as="span" variant={key.enabled ? 'secondary' : 'error'} size="base">
                        {key.enabled ? 'Active' : 'Revoked'}
                      </Text>
                    </span>
                    <Text variant="secondary" size="base">
                      <span className="font-mono text-[0.9em]">{key.start}…</span> · created by{' '}
                      {key.createdByName} ·{' '}
                      {key.lastRequest ? (
                        <>
                          last used <RelativeTime value={key.lastRequest} />
                        </>
                      ) : (
                        'never used'
                      )}{' '}
                      ·{' '}
                      {key.expiresAt ? (
                        <>
                          expires <RelativeTime value={key.expiresAt} />
                        </>
                      ) : (
                        'never expires'
                      )}
                    </Text>
                  </div>
                  {key.enabled ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setRevokeTarget({ id: key.id, name: key.name })}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <InlineEmpty message="No API keys have been created for this project." />
          )
        ) : (
          <Text variant="secondary" size="base">
            Organization owners and admins manage the API keys for this project.
          </Text>
        )}
      </LayerCard>

      <Dialog.Root
        open={creating}
        onOpenChange={(open) => {
          setCreating(open)
          if (!open) {
            setCreatedKey(null)
            createKey.reset()
          }
        }}
      >
        <Dialog className="px-6 py-5">
          <div className="grid gap-5">
            <div className="grid gap-1.5">
              <Dialog.Title>
                <Text as="span" variant="heading">
                  Create a project API key
                </Text>
              </Dialog.Title>
              <Dialog.Description>
                <Text as="span" variant="secondary">
                  This key can trigger and read runs for this project only.
                </Text>
              </Dialog.Description>
            </div>

            {createKey.error ? (
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" />}
                title="Could not create the key"
                description={createKey.error.message}
              />
            ) : null}

            {createdKey ? (
              <div className="grid gap-3">
                <Banner
                  variant="alert"
                  icon={<WarningCircleIcon weight="fill" />}
                  title="Copy this key now"
                  description="For security, the complete key will not be shown again after this dialog closes."
                />
                <MonoPanel label="API key" text={createdKey} />
              </div>
            ) : (
              <div className="grid gap-4">
                <Input
                  label="Name"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <Select
                  aria-label="Expiration"
                  label="Expiration"
                  items={WEBHOOK_EXPIRATIONS}
                  value={expiration}
                  onValueChange={(value: keyof typeof WEBHOOK_EXPIRATIONS | null) =>
                    setExpiration(value ?? '90')
                  }
                />
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="secondary">
                    {createdKey ? 'Done' : 'Cancel'}
                  </Button>
                )}
              />
              {!createdKey ? (
                <Button
                  variant="primary"
                  loading={createKey.isPending}
                  disabled={!name.trim()}
                  onClick={() => createKey.mutate()}
                >
                  Create key
                </Button>
              ) : null}
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <Dialog className="px-6 py-5">
          <div className="grid gap-5">
            <div className="grid gap-1.5">
              <Dialog.Title>
                <Text as="span" variant="heading">
                  Revoke this API key?
                </Text>
              </Dialog.Title>
              <Dialog.Description>
                <Text as="span" variant="secondary">
                  {revokeTarget?.name ?? 'This key'} will stop working immediately. It cannot be
                  restored.
                </Text>
              </Dialog.Description>
            </div>
            {revokeKey.error ? (
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" />}
                title="Could not revoke the key"
                description={revokeKey.error.message}
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
                loading={revokeKey.isPending}
                onClick={() => revokeTarget && revokeKey.mutate(revokeTarget.id)}
              >
                Revoke key
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
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

function ProjectRepairPolicyRow({ project }: { project: ProjectRow }) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const save = useMutation({
    mutationFn: (healPolicy: HealPolicyChoice) =>
      setProjectHealPolicy({ data: { projectId: project.id, healPolicy } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Repair policy saved' })
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not save', description: error.message }),
  })

  const { effective, project: own, organization } = project.healPolicy

  return (
    <SettingRow
      label="When a ready test fails"
      hint={
        own === 'inherit'
          ? `Inherited from the organization (${HEAL_POLICY_LABEL[organization].toLowerCase()}). ${describeHealPolicy(effective)}`
          : describeHealPolicy(effective)
      }
    >
      <HealPolicySelect
        aria-label="Repair policy"
        value={own}
        inheritLabel={`Inherit from organization (${HEAL_POLICY_LABEL[organization]})`}
        loading={save.isPending}
        onChange={(next) => save.mutate(next)}
      />
    </SettingRow>
  )
}

function ProjectUsageRow({ project }: { project: ProjectRow }) {
  const { usage } = project
  const idle = usage.jobs === 0 && usage.chatTurns === 0

  return (
    <SettingRow
      label="Model usage"
      hint={
        idle
          ? 'Nothing has used a model in this project yet.'
          : `${usage.jobs} generation${usage.jobs === 1 ? '' : 's'} and ${usage.chatTurns} chat turn${
              usage.chatTurns === 1 ? '' : 's'
            } so far. Tokens are billed by the provider whose key was used.`
      }
    >
      <Text as="span" variant="mono-secondary">
        {formatCount(usage.inputTokens)} in · {formatCount(usage.outputTokens)} out
      </Text>
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
            Every environment, test, script version and run under {project.name} goes with it.
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
              Create a manual test
            </Text>
          </Dialog.Title>
          <Dialog.Description>
            <Text as="span" variant="secondary">
              Start with expected behavior, then write the Playwright script.
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
