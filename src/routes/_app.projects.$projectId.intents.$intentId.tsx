import { Table, TablePagination, useTablePagination } from '#/components/table.tsx'
import {
  Badge,
  Banner,
  Breadcrumbs,
  Button,
  Dialog,
  DropdownMenu,
  Empty,
  Input,
  InputArea,
  LayerCard,
  Loader,
  Select,
  Tabs,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  ClockCounterClockwiseIcon,
  ClockIcon,
  DotsThreeIcon,
  FloppyDiskIcon,
  PencilSimpleIcon,
  PlayIcon,
  SparkleIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Fragment, useEffect, useMemo, useState } from 'react'

import { useDiscardGuard } from '#/components/discard-guard.tsx'
import { CodeEditor } from '#/components/code-editor.tsx'
import { Duration } from '#/components/duration.tsx'
import { DurationTrend } from '#/components/duration-trend.tsx'
import { GenerationLivePanel } from '#/components/generation-live-panel.tsx'
import { ListRow, ListToolbar, Section } from '#/components/list.tsx'
import { PageBody, PageHeader } from '#/components/page.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { RunDetailPanel } from '#/components/run-detail.tsx'
import { RunLivePanel } from '#/components/run-live-panel.tsx'
import { RunStatusSummary } from '#/components/run-status-summary.tsx'
import { IntentStatusBadge, RunStatusBadge, ScriptAuthorBadge } from '#/components/status-badge.tsx'
import type { RunPurpose, RunStatus, ScriptAuthor } from '#/db/schema/app.ts'
import { hasSupportedAssertions } from '#/lib/assertions.ts'
import { describeCron, isValidCron } from '#/lib/cron.ts'
import { shortId } from '#/lib/ids.ts'
import {
  environmentsQuery,
  intentGenerationQuery,
  intentQuery,
  runsQuery,
  scriptVersionQuery,
  scriptVersionsQuery,
} from '#/lib/queries.ts'
import { DEFAULT_SCRIPT_TEMPLATE } from '#/lib/script-template.ts'
import {
  deleteIntent,
  generateIntentScript,
  restoreScriptVersion,
  runIntent,
  saveScript,
  setTestReadiness,
  updateIntent,
} from '#/server/intents.ts'

const TABS = ['script', 'runs', 'history'] as const
type Tab = (typeof TABS)[number]

function isTab(value: unknown): value is Tab {
  return typeof value === 'string' && (TABS as ReadonlyArray<string>).includes(value)
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(['passed', 'healed', 'failed', 'error'])

export const Route = createFileRoute('/_app/projects/$projectId/intents/$intentId')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab; mode?: 'manual' } => ({
    ...(isTab(search.tab) ? { tab: search.tab } : {}),
    ...(search.mode === 'manual' ? { mode: 'manual' as const } : {}),
  }),
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
      context.queryClient.ensureQueryData({
        ...environmentsQuery(params.projectId),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...intentGenerationQuery(params.intentId),
        revalidateIfStale: true,
      }),
    ])
  },
  component: IntentDetail,
})

function IntentDetail() {
  const { projectId, intentId } = Route.useParams()
  const search = Route.useSearch()
  const tab = search.tab ?? 'script'
  const navigate = useNavigate({ from: Route.fullPath })

  const { data } = useSuspenseQuery(intentQuery(intentId))
  const { data: runs } = useSuspenseQuery(runsQuery(intentId))
  const { data: versions } = useSuspenseQuery(scriptVersionsQuery(intentId))
  const { data: environments } = useSuspenseQuery(environmentsQuery(projectId))
  const { data: generation } = useSuspenseQuery(intentGenerationQuery(intentId))

  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const { intent, currentVersion, project } = data

  const [dirty, setDirty] = useState(false)
  const guard = useDiscardGuard(dirty)
  const [editorKey, setEditorKey] = useState(0)
  const [editingDescription, setEditingDescription] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [watching, setWatching] = useState<string | null>(null)
  const [watchingGeneration, setWatchingGeneration] = useState<string | null>(null)
  const [environmentId, setEnvironmentId] = useState<string | null>(null)

  const defaultEnvironment = environments.find((row) => row.isDefault) ?? environments[0] ?? null
  const targetEnvironmentId = environmentId ?? defaultEnvironment?.id ?? null

  const currentResult = runs.find(
    (row) =>
      row.scriptVersionId === currentVersion?.id &&
      row.environmentId === targetEnvironmentId &&
      row.purpose === 'regression',
  )
  const visibleStatus =
    intent.readiness === 'draft'
      ? 'draft'
      : currentResult?.status === 'passed' || currentResult?.status === 'healed'
        ? 'passing'
        : currentResult?.status === 'failed' || currentResult?.status === 'error'
          ? 'failing'
          : 'ready'

  const inFlight = runs.find((row) => !TERMINAL.has(row.status))
  const liveRunId = watching ?? inFlight?.id ?? null

  const unfinishedGeneration =
    generation && (generation.status === 'queued' || generation.status === 'running')
      ? generation.id
      : null
  const liveGenerationId = watchingGeneration ?? unfinishedGeneration
  const generating = unfinishedGeneration !== null || intent.status === 'generating'

  const run = useMutation({
    mutationFn: () =>
      runIntent({
        data: {
          intentId,
          ...(targetEnvironmentId ? { environmentId: targetEnvironmentId } : {}),
        },
      }),
    onSuccess: async (result) => {
      setWatching(result.runId)
      await queryClient.invalidateQueries()
      if (tab !== 'script') void navigate({ search: { tab: 'script' }, replace: true })
      toast.add({ variant: 'info', title: 'Run queued', description: result.runId })
    },
    onError: (error: Error) => {
      toast.add({ variant: 'error', title: 'Could not queue the run', description: error.message })
    },
  })

  const generate = useMutation({
    mutationFn: () =>
      generateIntentScript({
        data: {
          intentId,
          ...(targetEnvironmentId ? { environmentId: targetEnvironmentId } : {}),
        },
      }),
    onSuccess: async (result) => {
      setWatchingGeneration(result.jobId)
      await queryClient.invalidateQueries()
      if (tab !== 'script') void navigate({ search: { tab: 'script' }, replace: true })
      toast.add({
        variant: 'info',
        title: 'Generating',
        description: 'The agent is building this test in a real browser.',
      })
    },
    onError: (error: Error) => {
      toast.add({
        variant: 'error',
        title: 'Could not start generating',
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

  return (
    <>
      <PageHeader
        breadcrumbs={
          <Breadcrumbs size="base">
            <Breadcrumbs.Link href="/projects">Projects</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Link href={`/projects/${projectId}`}>{project.name}</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Current>{intent.title}</Breadcrumbs.Current>
          </Breadcrumbs>
        }
        title={intent.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <IntentStatusBadge status={generating ? 'generating' : visibleStatus} />
            {intent.schedule ? (
              <ScheduleBadge schedule={intent.schedule} paused={intent.readiness === 'draft'} />
            ) : null}
            <Text as="span" variant="secondary" size="base">
              {currentVersion ? `Version ${currentVersion.version}` : 'No script saved yet'}
            </Text>
          </span>
        }
        actions={
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button variant="secondary" shape="square" aria-label="Test actions">
                  <DotsThreeIcon size={16} weight="bold" />
                </Button>
              }
            />
            <DropdownMenu.Content>
              <DropdownMenu.Item
                icon={PencilSimpleIcon}
                onClick={() => setEditingDescription(true)}
              >
                Edit test
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                icon={TrashIcon}
                variant="danger"
                onClick={() => setDeleting(true)}
              >
                Delete test
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        }
        tabs={
          <Tabs
            labels={{ scrollStart: 'Scroll tabs left', scrollEnd: 'Scroll tabs right' }}
            variant="segmented"
            tabs={[
              { value: 'script', label: 'Script' },
              { value: 'runs', label: `Runs${runs.length > 0 ? ` (${runs.length})` : ''}` },
              { value: 'history', label: 'History' },
            ]}
            value={tab}
            onValueChange={(value) => {
              if (isTab(value)) void navigate({ search: { tab: value }, replace: true })
            }}
          />
        }
        tabActions={
          <>
            <Select
              aria-label="Environment"
              className="w-52"
              placeholder="No environment"
              items={environmentItems}
              value={targetEnvironmentId}
              onValueChange={(value: string | null) => setEnvironmentId(value)}
            />
            <Button
              variant="primary"
              icon={<PlayIcon size={16} />}
              loading={run.isPending}
              disabled={currentVersion === null || targetEnvironmentId === null || generating}
              onClick={() => run.mutate()}
            >
              {intent.readiness === 'draft' ? 'Check draft' : 'Run test'}
            </Button>
          </>
        }
      />

      <PageBody className="grid gap-6">
        {environments.length === 0 ? (
          <Banner
            variant="alert"
            icon={<WarningCircleIcon weight="fill" />}
            title="This project has no environment"
            description="Add one under the project's Environments tab before running anything."
          />
        ) : null}

        <div hidden={tab !== 'script'}>
          <ScriptTab
            key={`${currentVersion?.id ?? 'unsaved'}-${editorKey}`}
            manual={search.mode === 'manual'}
            readiness={intent.readiness}
            onDirtyChange={setDirty}
            onRunQueued={setWatching}
            intentId={intentId}
            description={intent.description}
            schedule={intent.schedule}
            currentVersion={currentVersion}
            liveRunId={liveRunId}
            liveGenerationId={liveGenerationId}
            generating={generating}
            lastGeneration={generation}
            environmentItems={environmentItems}
            environmentId={targetEnvironmentId}
            onEnvironmentChange={setEnvironmentId}
            generatePending={generate.isPending}
            onGenerate={() =>
              guard.confirm(() => {
                setEditorKey((key) => key + 1)
                setDirty(false)
                generate.mutate()
              })
            }
            onEditDescription={() => setEditingDescription(true)}
          />
        </div>

        {tab === 'runs' ? <RunsTab projectId={projectId} runs={runs} /> : null}

        {tab === 'history' ? (
          <HistoryTab
            versions={versions}
            currentVersionId={currentVersion?.id ?? null}
            confirm={guard.confirm}
          />
        ) : null}
      </PageBody>

      {guard.dialog}
      <EditIntentDialog
        intent={intent}
        open={editingDescription}
        onOpenChange={setEditingDescription}
      />
      <DeleteIntentDialog
        intent={intent}
        projectId={projectId}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </>
  )
}

interface GenerationSummary {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  stuckReason: string | null
  turns: number
}

function ScriptTab({
  manual,
  readiness,
  onDirtyChange,
  onRunQueued,
  intentId,
  description,
  schedule,
  currentVersion,
  liveRunId,
  liveGenerationId,
  generating,
  lastGeneration,
  environmentItems,
  environmentId,
  onEnvironmentChange,
  generatePending,
  onGenerate,
  onEditDescription,
}: {
  manual: boolean
  readiness: 'draft' | 'ready'
  onDirtyChange: (dirty: boolean) => void
  onRunQueued: (runId: string) => void
  intentId: string
  description: string
  schedule: string | null
  currentVersion: { id: string; version: number; code: string; author: ScriptAuthor } | null
  liveRunId: string | null
  liveGenerationId: string | null
  generating: boolean
  lastGeneration: GenerationSummary | null
  environmentItems: Array<{ label: string; value: string }>
  environmentId: string | null
  onEnvironmentChange: (value: string | null) => void
  generatePending: boolean
  onGenerate: () => void
  onEditDescription: () => void
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const saved = currentVersion?.code ?? DEFAULT_SCRIPT_TEMPLATE
  const [code, setCode] = useState(saved)
  const [note, setNote] = useState('')
  const [authoring, setAuthoring] = useState(manual)

  const dirty = code !== saved || note.trim().length > 0
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  const untouched = currentVersion === null && !dirty

  const hero = currentVersion === null && !authoring && !generating

  const save = useMutation({
    mutationFn: async (andRun: boolean) => {
      const result = await saveScript({
        data: { intentId, code, ...(note.trim() ? { note: note.trim() } : {}) },
      })
      if (!result?.id || !Number.isInteger(result.version)) {
        throw new Error(
          'The server did not confirm the save. Your edits are still here; try again after reconnecting.',
        )
      }
      if (andRun) {
        try {
          const queued = await runIntent({
            data: {
              intentId,
              scriptVersionId: result.id,
              ...(environmentId ? { environmentId } : {}),
            },
          })
          if (!queued?.runId) throw new Error('The server did not confirm that the run started.')
          onRunQueued(queued.runId)
        } catch (error) {
          return {
            ...result,
            runError:
              error instanceof Error ? error.message : 'Try Check draft to run the saved version.',
          }
        }
      }
      return { ...result, runError: null }
    },
    onSuccess: async (result) => {
      onDirtyChange(false)
      await queryClient.invalidateQueries()
      setNote('')
      toast.add(
        result.runError
          ? {
              variant: 'error',
              title: `Saved draft v${result.version}, but the run could not start`,
              description: result.runError,
            }
          : { variant: 'success', title: `Saved draft v${result.version}` },
      )
    },
  })

  const [confirmReady, setConfirmReady] = useState(false)
  const ready = useMutation({
    mutationFn: () =>
      setTestReadiness({
        data: {
          intentId,
          versionId: currentVersion!.id,
          readiness: readiness === 'ready' ? 'draft' : 'ready',
        },
      }),
    onSuccess: async () => {
      setConfirmReady(false)
      await queryClient.invalidateQueries()
    },
  })
  const assertionWarning = !hasSupportedAssertions(code)

  const failedLast =
    lastGeneration?.status === 'failed' && !generating && liveGenerationId !== lastGeneration.id

  return (
    <div className="grid gap-6">
      <Section
        title="Expected behavior"
        description="What this test must verify. Readiness does not prove coverage."
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon={<PencilSimpleIcon size={14} />}
            onClick={onEditDescription}
          >
            Edit
          </Button>
        }
      >
        <LayerCard className="px-5 py-4">
          <pre className="font-mono text-[0.9em] whitespace-pre-wrap text-kumo-default">
            {description}
          </pre>
        </LayerCard>
      </Section>

      {hero ? (
        <LayerCard className="px-5 py-10">
          <Empty
            icon={<SparkleIcon size={48} className="text-kumo-inactive" />}
            title="No script yet"
            description="The agent opens a real browser, performs this flow one step at a time, keeps only the code that worked, and verifies the finished script before saving it."
            contents={
              <div className="grid justify-items-center gap-3">
                {failedLast && lastGeneration?.stuckReason ? (
                  <Banner
                    variant="alert"
                    icon={<WarningCircleIcon weight="fill" />}
                    title="The last attempt did not finish"
                    description={lastGeneration.stuckReason}
                  />
                ) : null}

                <div className="flex flex-wrap items-center justify-center gap-2">
                  {environmentItems.length > 1 ? (
                    <Select
                      aria-label="Environment to generate against"
                      className="w-52"
                      items={environmentItems}
                      value={environmentId}
                      onValueChange={onEnvironmentChange}
                    />
                  ) : null}
                  <Button
                    variant="primary"
                    icon={<SparkleIcon size={16} />}
                    loading={generatePending}
                    disabled={environmentItems.length === 0}
                    onClick={onGenerate}
                  >
                    Generate the test
                  </Button>
                </div>

                <Button variant="ghost" size="sm" onClick={() => setAuthoring(true)}>
                  Or start from a blank script
                </Button>
              </div>
            }
          />
        </LayerCard>
      ) : (
        <Section
          title="Playwright script"
          description="Every save creates a draft version. Check it, then mark it ready for suites and schedules."
          actions={
            <Button
              variant="secondary"
              size="sm"
              icon={<SparkleIcon size={14} />}
              loading={generatePending}
              disabled={generating || environmentItems.length === 0}
              onClick={onGenerate}
            >
              {currentVersion ? 'Regenerate' : 'Generate'}
            </Button>
          }
        >
          <LayerCard className="px-5 py-4">
            <div className="grid gap-3">
              {save.error ? (
                <Banner
                  variant="error"
                  icon={<WarningCircleIcon weight="fill" />}
                  title="Could not save"
                  description={save.error.message}
                />
              ) : null}

              <CodeEditor
                ariaLabel="Playwright script"
                value={code}
                onChange={setCode}
                readOnly={generating || save.isPending}
                minHeight="26rem"
                maxHeight="60vh"
              />

              <div className="flex flex-wrap items-center justify-between gap-3">
                <Text variant="secondary" size="base">
                  {generating
                    ? 'The agent is writing this script. Saving now would be overwritten.'
                    : untouched
                      ? 'Save this template as a draft to check it in a browser.'
                      : dirty
                        ? 'Unsaved changes. Runs always use the last saved version.'
                        : currentVersion
                          ? `Saved as v${currentVersion.version}.`
                          : 'Not saved yet.'}
                </Text>

                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    size="sm"
                    className="w-56"
                    aria-label="Version note"
                    placeholder="Note (optional)"
                    value={note}
                    disabled={generating || save.isPending}
                    onChange={(event) => setNote(event.target.value)}
                  />
                  <Button
                    variant={dirty ? 'primary' : 'secondary'}
                    icon={<FloppyDiskIcon size={16} />}
                    loading={save.isPending}
                    disabled={(!dirty && currentVersion !== null) || generating}
                    onClick={() => save.mutate(false)}
                  >
                    Save version
                  </Button>
                  <Button
                    variant="primary"
                    icon={<PlayIcon size={16} />}
                    loading={save.isPending}
                    disabled={generating || environmentId === null}
                    onClick={() => save.mutate(true)}
                  >
                    Save and run
                  </Button>
                </div>
              </div>
            </div>
          </LayerCard>
        </Section>
      )}

      {!hero && currentVersion ? (
        <Section
          title="Readiness"
          description="Draft checks are excluded from suites, schedules and regression pass rates."
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Text>
              {readiness === 'ready'
                ? 'This saved version is ready for regression runs.'
                : 'This version is a draft. A passing draft check does not make it ready.'}
            </Text>
            <Button
              variant="secondary"
              disabled={dirty || generating}
              loading={ready.isPending}
              onClick={() => (readiness === 'ready' ? ready.mutate() : setConfirmReady(true))}
            >
              {readiness === 'ready' ? 'Return to draft' : 'Mark ready'}
            </Button>
          </div>
          {ready.error ? <Text variant="error">{ready.error.message}</Text> : null}
        </Section>
      ) : null}
      <Dialog.Root open={confirmReady} onOpenChange={setConfirmReady}>
        <Dialog size="sm" className="p-6">
          <div className="grid gap-4">
            <Dialog.Title>Mark this version ready?</Dialog.Title>
            <Text>
              {assertionWarning
                ? 'No supported expect assertion was found. This quick check may miss custom matchers. The script may finish successfully without checking the expected behavior. '
                : ''}
              You are responsible for its coverage. Ready tests can run in suites and on schedules,
              even when they detect a failure.
            </Text>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmReady(false)}>
                Keep as draft
              </Button>
              <Button variant="primary" loading={ready.isPending} onClick={() => ready.mutate()}>
                Mark ready
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
      {!hero ? (
        <div className="grid gap-3">
          <Text variant="secondary">
            {readiness === 'draft'
              ? 'Scheduling is paused while this test is a draft. Mark it ready to enable scheduled execution.'
              : 'Schedules run the ready version against the default environment.'}
          </Text>
          <ScheduleSection
            key={schedule ?? 'unscheduled'}
            intentId={intentId}
            schedule={schedule}
          />
        </div>
      ) : null}

      {liveGenerationId ? (
        <Section
          title="Generation"
          description="What the agent is doing, and what the browser did about it."
        >
          <GenerationLivePanel
            key={liveGenerationId}
            jobId={liveGenerationId}
            intentId={intentId}
          />
        </Section>
      ) : null}

      {liveRunId ? (
        <Section title="Live run" description="Steps appear as the browser makes them.">
          <RunLivePanel key={liveRunId} runId={liveRunId} intentId={intentId} />
        </Section>
      ) : null}
    </div>
  )
}

const SCHEDULE_PRESETS = [
  { label: 'Not scheduled', value: 'none' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Daily at 06:00 UTC', value: '0 6 * * *' },
  { label: 'Weekly on Monday at 06:00 UTC', value: '0 6 * * 1' },
  { label: 'Custom cron…', value: 'custom' },
]

const PRESET_EXPRESSIONS = new Set(
  SCHEDULE_PRESETS.map((preset) => preset.value).filter(
    (value) => value !== 'none' && value !== 'custom',
  ),
)

function presetFor(schedule: string | null): string {
  if (!schedule) return 'none'
  return PRESET_EXPRESSIONS.has(schedule) ? schedule : 'custom'
}

function ScheduleBadge({ schedule, paused = false }: { schedule: string; paused?: boolean }) {
  return (
    <span title={`${schedule} (UTC)`}>
      <Badge variant="neutral" icon={ClockIcon}>
        {paused ? 'Schedule paused' : 'Scheduled'} · {describeCron(schedule)} UTC
      </Badge>
    </span>
  )
}

function ScheduleSection({ intentId, schedule }: { intentId: string; schedule: string | null }) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [choice, setChoice] = useState(() => presetFor(schedule))
  const [custom, setCustom] = useState(() => (presetFor(schedule) === 'custom' ? schedule! : ''))

  const next = choice === 'none' ? null : choice === 'custom' ? custom.trim() : choice
  const valid = next === null ? true : isValidCron(next)
  const dirty = next !== (schedule ?? null)

  const save = useMutation({
    mutationFn: () => updateIntent({ data: { intentId, schedule: next } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: 'success',
        title: next === null ? 'Schedule cleared' : 'Schedule saved',
        ...(next === null ? {} : { description: `${describeCron(next)}, UTC.` }),
      })
    },
  })

  return (
    <Section
      title="Schedule"
      description="Cron, read in UTC. Everything due in this project on the same minute runs as one suite."
    >
      <LayerCard className="px-5 py-4">
        <div className="grid gap-3">
          {save.error ? (
            <Banner
              variant="error"
              icon={<WarningCircleIcon weight="fill" />}
              title="Could not save the schedule"
              description={save.error.message}
            />
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Schedule"
              className="w-72"
              items={SCHEDULE_PRESETS}
              value={choice}
              onValueChange={(value: string | null) => setChoice(value ?? 'none')}
            />
            {choice === 'custom' ? (
              <Input
                aria-label="Cron expression"
                className="w-56 font-mono"
                placeholder="*/30 * * * *"
                spellCheck={false}
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
              />
            ) : null}
            <Button
              variant={dirty ? 'primary' : 'secondary'}
              icon={<ClockIcon size={16} />}
              loading={save.isPending}
              disabled={!dirty || !valid}
              onClick={() => save.mutate()}
            >
              Save schedule
            </Button>
          </div>

          <Text variant="secondary" size="base">
            {next === null
              ? 'This test runs only when someone presses Run.'
              : valid
                ? `${describeCron(next)}, UTC. Scheduled runs appear in the history with a schedule trigger.`
                : 'Five fields — minute hour day month weekday — using numbers, *, lists, ranges and steps.'}
          </Text>
        </div>
      </LayerCard>
    </Section>
  )
}

type RunRowData = {
  purpose: RunPurpose
  id: string
  status: RunStatus
  trigger: 'manual' | 'regenerate' | 'schedule'
  environmentName: string
  version: number
  durationMs: number | null
  startedAt: Date
  lastErrorMessage: string | null
}

function RunsTab({ projectId, runs }: { projectId: string; runs: Array<RunRowData> }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const visibleRuns = runs.filter(
    (run) =>
      (status === 'all' || run.status === status) &&
      `${run.id} ${run.environmentName} v${run.version}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  )
  const pagination = useTablePagination(visibleRuns, `${search}:${status}`)

  if (runs.length === 0) {
    return (
      <Empty
        icon={<PlayIcon size={48} className="text-kumo-inactive" />}
        title="No runs found"
        description="Save a script, pick an environment, then press Run — every execution lands here."
      />
    )
  }

  return (
    <Section
      title="Runs"
      description="Regression summary excludes draft checks and generation verification. All executions appear below, newest first."
    >
      <div className="grid min-w-0 grid-cols-1 gap-4">
        <RunStatusSummary runs={runs.filter((row) => row.purpose === 'regression')} />

        <DurationTrend runs={runs.filter((row) => row.purpose === 'regression')} />

        <Table
          label="Test runs"
          footer={<TablePagination {...pagination} />}
          toolbar={
            <ListToolbar
              value={search}
              onValueChange={setSearch}
              placeholder="Search run ID or environment"
            >
              <Select
                aria-label="Filter test runs by status"
                className="w-40"
                value={status}
                onValueChange={(value: string | null) => setStatus(value ?? 'all')}
                items={{
                  all: 'All statuses',
                  passed: 'Passed',
                  failed: 'Failed',
                  error: 'Errored',
                  healed: 'Healed',
                  queued: 'Queued',
                  running: 'Running',
                }}
              />
            </ListToolbar>
          }
        >
          <Table.Header>
            <Table.Row>
              <Table.Head className="w-0">
                <span className="sr-only">Expand details</span>
              </Table.Head>
              <Table.Head>Status</Table.Head>
              <Table.Head>Started</Table.Head>
              <Table.Head>Run</Table.Head>
              <Table.Head>Environment</Table.Head>
              <Table.Head>Version</Table.Head>
              <Table.Head className="text-right">Duration</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {pagination.items.map((row) => {
              const open = expanded === row.id
              return (
                <Fragment key={row.id}>
                  <Table.Row data-expanded={open}>
                    <Table.Cell>
                      <Button
                        variant="ghost"
                        shape="square"
                        size="sm"
                        aria-label={open ? 'Hide run detail' : 'Show run detail'}
                        aria-expanded={open}
                        aria-controls={`test-run-detail-${row.id}`}
                        onClick={() => setExpanded(open ? null : row.id)}
                      >
                        <CaretDownIcon size={14} className={open ? 'rotate-180' : '-rotate-90'} />
                      </Button>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="grid gap-1">
                        <RunStatusBadge status={row.status} />
                        <Text variant="secondary">
                          {row.purpose === 'draft-check'
                            ? 'Draft check'
                            : row.purpose === 'generation-verification'
                              ? 'Verification'
                              : 'Regression'}
                        </Text>
                      </div>
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap text-kumo-subtle">
                      <RelativeTime value={row.startedAt} />
                    </Table.Cell>
                    <Table.Cell>
                      <span className="flex items-center gap-1.5">
                        <Text as="span" variant="mono-secondary">
                          {shortId(row.id)}
                        </Text>

                        {row.trigger === 'schedule' ? (
                          <span
                            className="flex items-center text-kumo-subtle"
                            title="Started by the schedule"
                          >
                            <ClockIcon size={13} aria-label="Started by the schedule" />
                          </span>
                        ) : null}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap text-kumo-subtle">
                      {row.environmentName}
                    </Table.Cell>
                    <Table.Cell>
                      <Text as="span" variant="mono-secondary">
                        v{row.version}
                      </Text>
                    </Table.Cell>
                    <Table.Cell className="text-right whitespace-nowrap tabular-nums">
                      <Duration ms={row.durationMs} />
                    </Table.Cell>
                  </Table.Row>
                  {open ? (
                    <Table.Row>
                      <Table.Cell
                        id={`test-run-detail-${row.id}`}
                        colSpan={7}
                        className="bg-kumo-recessed"
                      >
                        <RunDetailPanel runId={row.id} projectId={projectId} />
                      </Table.Cell>
                    </Table.Row>
                  ) : null}
                </Fragment>
              )
            })}
            {pagination.items.length === 0 ? (
              <Table.Empty
                columns={7}
                message="No runs match your filters"
                onClear={() => {
                  setSearch('')
                  setStatus('all')
                }}
              />
            ) : null}
          </Table.Body>
        </Table>
      </div>
    </Section>
  )
}

type VersionRowData = {
  id: string
  version: number
  author: ScriptAuthor
  note: string | null
  createdByName: string
  createdAt: Date
  codeLength: number
}

function HistoryTab({
  versions,
  currentVersionId,
  confirm,
}: {
  confirm: (next: () => void) => void
  versions: Array<VersionRowData>
  currentVersionId: string | null
}) {
  const [viewing, setViewing] = useState<VersionRowData | null>(null)

  if (versions.length === 0) {
    return (
      <Empty
        icon={<ClockCounterClockwiseIcon size={48} className="text-kumo-inactive" />}
        title="No script versions found"
        description="Every save on the Script tab appends a version here, and nothing here is ever rewritten."
      />
    )
  }

  return (
    <>
      <Section title="Script history" description="Immutable, newest first.">
        <ol className="grid gap-3">
          {versions.map((version) => (
            <li key={version.id}>
              <VersionRow
                version={version}
                isCurrent={version.id === currentVersionId}
                onView={() => setViewing(version)}
                confirm={confirm}
              />
            </li>
          ))}
        </ol>
      </Section>

      <VersionDialog
        version={viewing}
        open={viewing !== null}
        onOpenChange={(open) => {
          if (!open) setViewing(null)
        }}
      />
    </>
  )
}

function VersionRow({
  version,
  isCurrent,
  onView,
  confirm,
}: {
  confirm: (next: () => void) => void
  version: VersionRowData
  isCurrent: boolean
  onView: () => void
}) {
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
    <ListRow
      icon={<ClockCounterClockwiseIcon size={18} />}
      title={
        <div className="flex flex-wrap items-center gap-2">
          <Text as="span" bold>
            v{version.version}
          </Text>
          <ScriptAuthorBadge author={version.author} />
          {isCurrent ? <Badge variant="success">Current</Badge> : null}
        </div>
      }
      subtitle={
        <Text variant="secondary" size="base" truncate>
          {version.note ?? 'No note'} · {version.createdByName} ·{' '}
          <RelativeTime value={version.createdAt} /> · {version.codeLength} chars
        </Text>
      }
      actions={
        <>
          <Button variant="secondary" size="sm" onClick={onView}>
            View
          </Button>
          {isCurrent ? null : (
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowCounterClockwiseIcon size={14} />}
              loading={restore.isPending}
              onClick={() => confirm(() => restore.mutate())}
            >
              Restore
            </Button>
          )}
        </>
      }
    />
  )
}

function VersionDialog({
  version,
  open,
  onOpenChange,
}: {
  version: VersionRowData | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="px-6 py-5">
        <div className="grid gap-4">
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title>
              <Text as="span" variant="heading">
                {version ? `Version ${version.version}` : 'Version'}
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
          {version ? <VersionCode versionId={version.id} /> : null}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

function VersionCode({ versionId }: { versionId: string }) {
  const { data, isPending, error } = useQuery(scriptVersionQuery(versionId))

  if (isPending) return <Loader size="sm" />
  if (error) {
    return (
      <Banner
        variant="error"
        icon={<WarningCircleIcon weight="fill" />}
        title="Could not load this version"
        description={error.message}
      />
    )
  }

  return <CodeEditor value={data.code} readOnly wrap showLineNumbers={false} maxHeight="60vh" />
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
        <EditIntentForm
          key={open ? 'open' : 'closed'}
          intent={intent}
          onOpenChange={onOpenChange}
        />
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
            Edit test
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
              Delete test
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
