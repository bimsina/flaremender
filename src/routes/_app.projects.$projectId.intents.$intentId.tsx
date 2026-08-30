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
  Table,
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
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Fragment, useMemo, useState } from 'react'

import { CodeEditor } from '#/components/code-editor.tsx'
import { Duration } from '#/components/duration.tsx'
import { DurationTrend } from '#/components/duration-trend.tsx'
import { ListRow, Section } from '#/components/list.tsx'
import { PageBody, PageHeader } from '#/components/page.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { RunDetailPanel } from '#/components/run-detail.tsx'
import { RunLivePanel } from '#/components/run-live-panel.tsx'
import { RunStatusSummary } from '#/components/run-status-summary.tsx'
import { IntentStatusBadge, RunStatusBadge, ScriptAuthorBadge } from '#/components/status-badge.tsx'
import type { RunStatus, ScriptAuthor } from '#/db/schema/app.ts'
import { describeCron, isValidCron } from '#/lib/cron.ts'
import { shortId } from '#/lib/ids.ts'
import {
  environmentsQuery,
  intentQuery,
  runsQuery,
  scriptVersionQuery,
  scriptVersionsQuery,
} from '#/lib/queries.ts'
import { DEFAULT_SCRIPT_TEMPLATE } from '#/lib/script-template.ts'
import {
  deleteIntent,
  restoreScriptVersion,
  runIntent,
  saveScript,
  updateIntent,
} from '#/server/intents.ts'

const TABS = ['script', 'runs', 'history'] as const
type Tab = (typeof TABS)[number]

function isTab(value: unknown): value is Tab {
  return typeof value === 'string' && (TABS as ReadonlyArray<string>).includes(value)
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(['passed', 'healed', 'failed', 'error'])

export const Route = createFileRoute('/_app/projects/$projectId/intents/$intentId')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    isTab(search.tab) ? { tab: search.tab } : {},
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

  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const { intent, currentVersion, project } = data

  const [editingDescription, setEditingDescription] = useState(false)
  const [deleting, setDeleting] = useState(false)
  /** Explicitly watched run — set the moment one is queued from this page. */
  const [watching, setWatching] = useState<string | null>(null)
  const [environmentId, setEnvironmentId] = useState<string | null>(null)

  const defaultEnvironment = environments.find((row) => row.isDefault) ?? environments[0] ?? null
  const targetEnvironmentId = environmentId ?? defaultEnvironment?.id ?? null

  // A reload in the middle of a run must find its way back to the live panel,
  // so an unfinished run in the history seeds the watch as well.
  const inFlight = runs.find((row) => !TERMINAL.has(row.status))
  const liveRunId = watching ?? inFlight?.id ?? null

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
      // The verdict does not arrive with the response — a run is a Workflow and
      // this only queues it. The live panel takes it from here.
      await queryClient.invalidateQueries()
      if (tab !== 'script') void navigate({ search: { tab: 'script' }, replace: true })
      toast.add({ variant: 'info', title: 'Run queued', description: result.runId })
    },
    onError: (error: Error) => {
      toast.add({ variant: 'error', title: 'Could not queue the run', description: error.message })
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
          <Breadcrumbs size="sm">
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
            <IntentStatusBadge status={intent.status} />
            {intent.schedule ? <ScheduleBadge schedule={intent.schedule} /> : null}
            <Text as="span" variant="secondary" size="xs">
              {currentVersion ? `Version ${currentVersion.version}` : 'No script saved yet'}
            </Text>
          </span>
        }
        actions={
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button variant="secondary" shape="square" aria-label="Intent actions">
                  <DotsThreeIcon size={16} weight="bold" />
                </Button>
              }
            />
            <DropdownMenu.Content>
              <DropdownMenu.Item
                icon={PencilSimpleIcon}
                onClick={() => setEditingDescription(true)}
              >
                Edit intent
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
        }
        tabs={
          <Tabs
            variant="underline"
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
              disabled={currentVersion === null || targetEnvironmentId === null}
              onClick={() => run.mutate()}
            >
              Run
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

        {tab === 'script' ? (
          <ScriptTab
            // A restore replaces the saved code, and the editor has to follow it
            // rather than sit there claiming unsaved changes it did not make.
            key={currentVersion?.id ?? 'unsaved'}
            intentId={intentId}
            description={intent.description}
            schedule={intent.schedule}
            currentVersion={currentVersion}
            liveRunId={liveRunId}
            onEditDescription={() => setEditingDescription(true)}
          />
        ) : null}

        {tab === 'runs' ? <RunsTab projectId={projectId} runs={runs} /> : null}

        {tab === 'history' ? (
          <HistoryTab versions={versions} currentVersionId={currentVersion?.id ?? null} />
        ) : null}
      </PageBody>

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

/* -------------------------------------------------------------- Script tab */

function ScriptTab({
  intentId,
  description,
  schedule,
  currentVersion,
  liveRunId,
  onEditDescription,
}: {
  intentId: string
  description: string
  schedule: string | null
  currentVersion: { id: string; version: number; code: string; author: ScriptAuthor } | null
  liveRunId: string | null
  onEditDescription: () => void
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  // A brand-new intent starts from the template rather than an empty box: the
  // shape of a script is not obvious, and an empty editor teaches nothing.
  const saved = currentVersion?.code ?? DEFAULT_SCRIPT_TEMPLATE
  const [code, setCode] = useState(saved)
  const [note, setNote] = useState('')

  const dirty = code !== saved
  const untouched = currentVersion === null && !dirty

  const save = useMutation({
    mutationFn: () =>
      saveScript({ data: { intentId, code, ...(note.trim() ? { note: note.trim() } : {}) } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      setNote('')
      toast.add({ variant: 'success', title: `Saved as v${result.version}` })
    },
  })

  return (
    <div className="grid gap-6">
      <Section
        title="Intent"
        description="Plain English, and the permanent source of truth."
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

      <ScheduleSection key={schedule ?? 'unscheduled'} intentId={intentId} schedule={schedule} />

      <Section
        title="Playwright script"
        description="Every save is a new, immutable version. Restoring an old one saves it forward."
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
              minHeight="26rem"
              maxHeight="60vh"
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <Text variant="secondary" size="xs">
                {untouched
                  ? 'Seeded from the default template — save it to make this intent runnable.'
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
                  onChange={(event) => setNote(event.target.value)}
                />
                <Button
                  variant={dirty ? 'primary' : 'secondary'}
                  icon={<FloppyDiskIcon size={16} />}
                  loading={save.isPending}
                  disabled={!dirty && currentVersion !== null}
                  onClick={() => save.mutate()}
                >
                  Save version
                </Button>
              </div>
            </div>
          </div>
        </LayerCard>
      </Section>

      {liveRunId ? (
        <Section title="Live run" description="Steps appear as the browser makes them.">
          <RunLivePanel key={liveRunId} runId={liveRunId} intentId={intentId} />
        </Section>
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------- Schedule */

/**
 * The schedules worth naming, plus the two entries that are not schedules.
 *
 * Presets exist because the useful cases are few and cron is a bad thing to
 * make someone remember; `custom` exists because the ones we did not think of
 * are exactly as valid, and the matcher does not care which route produced the
 * expression.
 */
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

/** Which row of the Select an existing schedule already sits on. */
function presetFor(schedule: string | null): string {
  if (!schedule) return 'none'
  return PRESET_EXPRESSIONS.has(schedule) ? schedule : 'custom'
}

/**
 * Everything about a schedule that fits next to a status badge. The raw
 * expression is the `title`, because a description is a summary and someone
 * debugging a schedule wants the thing itself.
 */
function ScheduleBadge({ schedule }: { schedule: string }) {
  return (
    <span title={`${schedule} (UTC)`}>
      <Badge variant="blue" icon={ClockIcon}>
        Scheduled · {describeCron(schedule)} UTC
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
  // An empty custom box is "not finished typing", not "clear the schedule" —
  // the Select's own first row means that, and says so.
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

          <Text variant="secondary" size="xs">
            {next === null
              ? 'This intent runs only when someone presses Run.'
              : valid
                ? `${describeCron(next)}, UTC. Scheduled runs appear in the history with a schedule trigger.`
                : 'Five fields — minute hour day month weekday — using numbers, *, lists, ranges and steps.'}
          </Text>
        </div>
      </LayerCard>
    </Section>
  )
}

/* ---------------------------------------------------------------- Runs tab */

type RunRowData = {
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
    <Section title="Runs" description="Newest first. Open one for its steps and artifacts.">
      <div className="grid gap-4">
        <RunStatusSummary runs={runs} />

        <DurationTrend runs={runs} />

        <LayerCard className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head className="w-0" />
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Started</Table.Head>
                  <Table.Head>Run</Table.Head>
                  <Table.Head>Environment</Table.Head>
                  <Table.Head>Version</Table.Head>
                  <Table.Head className="text-right">Duration</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {runs.map((row) => {
                  const open = expanded === row.id
                  return (
                    <Fragment key={row.id}>
                      <Table.Row>
                        <Table.Cell>
                          <Button
                            variant="ghost"
                            shape="square"
                            size="sm"
                            aria-label={open ? 'Hide run detail' : 'Show run detail'}
                            onClick={() => setExpanded(open ? null : row.id)}
                          >
                            <CaretDownIcon
                              size={14}
                              className={open ? 'rotate-180' : '-rotate-90'}
                            />
                          </Button>
                        </Table.Cell>
                        <Table.Cell>
                          <RunStatusBadge status={row.status} />
                        </Table.Cell>
                        <Table.Cell>
                          <RelativeTime value={row.startedAt} />
                        </Table.Cell>
                        <Table.Cell>
                          <span className="flex items-center gap-1.5">
                            <Text as="span" variant="mono-secondary">
                              {shortId(row.id)}
                            </Text>
                            {/* Who started it, but only when it was not a
                                person — "manual" is the unremarkable case and
                                does not need saying on every row. */}
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
                        <Table.Cell>{row.environmentName}</Table.Cell>
                        <Table.Cell>
                          <Text as="span" variant="mono-secondary">
                            v{row.version}
                          </Text>
                        </Table.Cell>
                        <Table.Cell className="text-right">
                          <Duration ms={row.durationMs} />
                        </Table.Cell>
                      </Table.Row>
                      {open ? (
                        <Table.Row>
                          <Table.Cell colSpan={7} className="bg-kumo-recessed">
                            <RunDetailPanel runId={row.id} projectId={projectId} />
                          </Table.Cell>
                        </Table.Row>
                      ) : null}
                    </Fragment>
                  )
                })}
              </Table.Body>
            </Table>
          </div>
        </LayerCard>
      </div>
    </Section>
  )
}

/* ------------------------------------------------------------- History tab */

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
}: {
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
}: {
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
        <Text variant="secondary" size="xs" truncate>
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
              onClick={() => restore.mutate()}
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

/* ------------------------------------------------------------------ Dialogs */

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
