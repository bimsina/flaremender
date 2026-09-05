import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Input,
  InputArea,
  LayerCard,
  LinkButton,
  Loader,
  Text,
} from '@cloudflare/kumo'
import {
  ArrowSquareOutIcon,
  BinocularsIcon,
  CheckIcon,
  ClockIcon,
  GlobeIcon,
  ListChecksIcon,
  PencilSimpleIcon,
  PlayIcon,
  SparkleIcon,
  StackIcon,
  TestTubeIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'

import { Duration } from '#/components/duration.tsx'
import {
  IntentStatusBadge,
  RunStatusBadge,
  SuiteRunStatusBadge,
} from '#/components/status-badge.tsx'
import { UsageLine } from '#/components/generation-live-panel.tsx'
import { LiveBrowser } from '#/components/live-browser.tsx'
import { StepList } from '#/components/step-list.tsx'
import type {
  BatchCard,
  ChatCard,
  EnvironmentCard,
  ExploreCard,
  GenerationCard,
  IntentCard,
  PlanCard,
  RunCard,
  SuiteCard,
} from '#/engine/chat/contract.ts'
import { describeCron } from '#/lib/cron.ts'
import { chatMessagesQuery, intentsQuery, runQuery, suiteRunQuery } from '#/lib/queries.ts'
import { useJobProgress } from '#/lib/use-job-progress.ts'
import { describePurpose } from '#/lib/format.ts'
import { approveProposedIntents, dismissProposedIntent } from '#/server/explore.ts'
import { updateIntent } from '#/server/intents.ts'

const POLL_INTERVAL_MS = 2500

const MAX_CARD_STEPS = 6

export function ChatCardView({ card, projectId }: { card: ChatCard; projectId: string }) {
  switch (card.kind) {
    case 'intent':
      return <IntentCardView card={card} projectId={projectId} />
    case 'generation':
      return <GenerationCardView card={card} projectId={projectId} />
    case 'run':
      return <RunCardView card={card} projectId={projectId} />
    case 'suite':
      return <SuiteCardView card={card} projectId={projectId} />
    case 'environment':
      return <EnvironmentCardView card={card} />
    case 'explore':
      return <ExploreCardView card={card} projectId={projectId} />
    case 'plan':
      return <PlanCardView card={card} projectId={projectId} />
    case 'batch':
      return <BatchCardView card={card} projectId={projectId} />
  }
}

function CardFrame({
  icon,
  title,
  meta,
  footer,
  children,
}: {
  icon: React.ReactNode
  title: React.ReactNode
  meta?: React.ReactNode
  footer?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <LayerCard className="px-4 py-3">
      <div className="grid gap-2.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="flex h-lh shrink-0 items-center text-kumo-subtle">{icon}</span>
            <div className="grid min-w-0 gap-0.5">{title}</div>
          </div>
          {meta ? <div className="flex shrink-0 items-center gap-2">{meta}</div> : null}
        </div>
        {children}
        {footer ? (
          <div className="-mx-4 -mb-3 border-t border-kumo-hairline px-4 py-2">{footer}</div>
        ) : null}
      </div>
    </LayerCard>
  )
}

function IntentCardView({ card, projectId }: { card: IntentCard; projectId: string }) {
  const { data } = useQuery(intentsQuery(projectId))
  const live = data?.find((row) => row.id === card.intentId) ?? null

  const title = live?.title ?? card.title
  const status = live?.status ?? card.status
  const schedule = live === null ? card.schedule : live.schedule

  return (
    <CardFrame
      icon={<TestTubeIcon size={18} />}
      title={
        <>
          <Link
            to="/projects/$projectId/intents/$intentId"
            params={{ projectId, intentId: card.intentId }}
            className="truncate font-medium text-kumo-default hover:text-kumo-link"
          >
            {title}
          </Link>
          {schedule ? (
            <Text as="span" variant="secondary" size="base">
              <ClockIcon size={12} className="mr-1 inline align-[-0.1em]" />
              {describeCron(schedule)}, UTC
            </Text>
          ) : null}
        </>
      }
      meta={<IntentStatusBadge status={status} />}
    />
  )
}

function GenerationCardView({ card, projectId }: { card: GenerationCard; projectId: string }) {
  const { job, live, transport } = useJobProgress(card.jobId)

  const finished = live.outcome !== null
  const succeeded = live.outcome === 'passed'
  const steps = live.steps.slice(-MAX_CARD_STEPS)
  const narration = live.logs.at(-1)?.line ?? null
  const repairing = card.job === 'repair' || job?.kind === 'repair'

  return (
    <CardFrame
      icon={finished ? <SparkleIcon size={18} /> : <Loader size="sm" />}
      title={
        <>
          <Text as="span" bold>
            {finished
              ? succeeded
                ? repairing
                  ? 'Repair verified'
                  : 'Script generated and verified'
                : repairing
                  ? 'Repair needs attention'
                  : 'Generation needs attention'
              : repairing
                ? 'Repairing the script'
                : 'Writing the script'}
          </Text>
          <Text as="span" variant="secondary" size="base">
            {card.intentTitle} · {card.environmentName}
          </Text>
        </>
      }
      meta={
        finished ? (
          <Badge variant={succeeded ? 'success' : 'error'} appearance="dot">
            {succeeded ? 'Verified' : 'Needs attention'}
          </Badge>
        ) : (
          <Badge variant="neutral" appearance="dot">
            {transport === 'loading'
              ? 'Loading'
              : transport === 'polling'
                ? 'Reconnecting'
                : 'Live'}
          </Badge>
        )
      }
      footer={
        <div className="flex flex-wrap gap-2">
          <LinkButton
            href={`/projects/${projectId}/intents/${card.intentId}`}
            variant="ghost"
            size="xs"
            icon={ArrowSquareOutIcon}
          >
            Open the test
          </LinkButton>
          {job?.runId ? (
            <LinkButton href={`/projects/${projectId}/runs/${job.runId}`} variant="ghost" size="sm">
              View verification
            </LinkButton>
          ) : null}
        </div>
      }
    >
      {!finished ? <LiveBrowser frame={live.frame} active caption={narration} size="sm" /> : null}

      {live.errorMessage && finished ? (
        <Text variant="secondary" size="base">
          {live.errorMessage.split('\n')[0]}
        </Text>
      ) : null}

      {finished && job ? (
        <Text variant="secondary" size="base">
          <UsageLine
            turns={job.turns}
            inputTokens={job.inputTokens}
            outputTokens={job.outputTokens}
            modelId={job.modelId}
          />
        </Text>
      ) : null}

      {steps.length > 0 ? <StepList steps={steps} /> : null}
    </CardFrame>
  )
}

function RunCardView({ card, projectId }: { card: RunCard; projectId: string }) {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    ...runQuery(card.runId),
    refetchInterval: (query) => {
      const status = query.state.data?.run.status
      return status === 'queued' || status === 'running' || status === undefined
        ? POLL_INTERVAL_MS
        : false
    },
  })

  const status = data?.run.status ?? card.status
  const running = status === 'queued' || status === 'running'
  const durationMs = data?.attempts.reduce((total, row) => total + (row.durationMs ?? 0), 0) ?? null

  useEffect(() => {
    if (!running) void queryClient.invalidateQueries({ queryKey: intentsQuery(projectId).queryKey })
  }, [running, card.runId, projectId, queryClient])

  return (
    <CardFrame
      icon={running ? <Loader size="sm" /> : <PlayIcon size={18} />}
      title={
        <>
          <Link
            to="/projects/$projectId/runs/$runId"
            params={{ projectId, runId: card.runId }}
            className="truncate font-medium text-kumo-default hover:text-kumo-link"
          >
            {card.intentTitle}
          </Link>
          <Text as="span" variant="secondary" size="base">
            {data?.environment.name ?? card.environmentName}
            {data
              ? ` · v${data.scriptVersion.version} · ${describePurpose(data.run.purpose)}`
              : null}
            {durationMs ? ' · ' : ''}
            {durationMs ? <Duration ms={durationMs} /> : null}
          </Text>
        </>
      }
      meta={<RunStatusBadge status={status} />}
    />
  )
}

function SuiteCardView({ card, projectId }: { card: SuiteCard; projectId: string }) {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    ...suiteRunQuery(card.suiteRunId),
    refetchInterval: (query) => {
      const status = query.state.data?.suiteRun.status
      return status === 'queued' || status === 'running' || status === undefined
        ? POLL_INTERVAL_MS
        : false
    },
  })

  const suite = data?.suiteRun ?? null
  const status = suite?.status ?? card.status
  const running = status === 'queued' || status === 'running'
  const done = suite ? suite.passedCount + suite.failedCount + suite.errorCount : 0

  useEffect(() => {
    if (!running) void queryClient.invalidateQueries({ queryKey: intentsQuery(projectId).queryKey })
  }, [running, card.suiteRunId, projectId, queryClient])

  return (
    <CardFrame
      icon={running ? <Loader size="sm" /> : <StackIcon size={18} />}
      title={
        <>
          <Text as="span" bold>
            Suite execution
          </Text>
          <Text as="span" variant="secondary" size="base">
            {card.environmentName}
            {suite ? ` · ${done} of ${suite.totalCount} done` : null}
          </Text>
        </>
      }
      meta={<SuiteRunStatusBadge status={status} />}
    >
      {suite?.errorMessage ? <Text variant="error">{suite.errorMessage}</Text> : null}
      {suite && suite.totalCount > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <Text as="span" size="base" variant={suite.passedCount > 0 ? 'success' : 'secondary'}>
            {suite.passedCount} passed
          </Text>
          <Text as="span" size="base" variant={suite.failedCount > 0 ? 'error' : 'secondary'}>
            {suite.failedCount} failed
          </Text>
          <Text as="span" size="base" variant="secondary">
            {suite.errorCount} errored
          </Text>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <LinkButton size="sm" variant="secondary" href={`/projects/${projectId}?tab=runs`}>
          View results
        </LinkButton>
        <LinkButton
          size="sm"
          variant="ghost"
          href={`/api/reports/suites/${card.suiteRunId}?format=json`}
        >
          JSON
        </LinkButton>
        <LinkButton
          size="sm"
          variant="ghost"
          href={`/api/reports/suites/${card.suiteRunId}?format=junit`}
        >
          JUnit
        </LinkButton>
      </div>
    </CardFrame>
  )
}

function EnvironmentCardView({ card }: { card: EnvironmentCard }) {
  return (
    <CardFrame
      icon={<GlobeIcon size={18} />}
      title={
        <>
          <Text as="span" bold>
            {card.name}
          </Text>
          <Text as="span" variant="mono-secondary" truncate>
            {card.baseUrl}
          </Text>
        </>
      }
      meta={
        card.isDefault ? (
          <Badge variant="neutral" appearance="dot">
            Default
          </Badge>
        ) : null
      }
    >
      {card.variableNames.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {card.variableNames.map((name) => (
            <Badge key={name} variant="neutral">
              <span className="font-mono text-[0.9em]">{name}</span>
            </Badge>
          ))}
        </div>
      ) : (
        <Text variant="secondary" size="base">
          No credentials stored yet.
        </Text>
      )}
    </CardFrame>
  )
}

function ExploreCardView({ card, projectId }: { card: ExploreCard; projectId: string }) {
  const { live, transport } = useJobProgress(card.jobId)
  const queryClient = useQueryClient()

  const finished = live.outcome !== null
  const proposed = live.outcome === 'passed'
  const steps = live.steps.slice(-MAX_CARD_STEPS)
  const narration = live.logs.at(-1)?.line ?? null

  useEffect(() => {
    if (!finished) return

    void queryClient.invalidateQueries({ queryKey: chatMessagesQuery(projectId).queryKey })
    void queryClient.invalidateQueries({ queryKey: intentsQuery(projectId).queryKey })
  }, [finished, projectId, queryClient])

  return (
    <CardFrame
      icon={finished ? <BinocularsIcon size={18} /> : <Loader size="sm" />}
      title={
        <>
          <Text as="span" bold>
            {finished
              ? proposed
                ? 'Explored the app'
                : 'The exploration stopped early'
              : 'Exploring the app'}
          </Text>
          <Text as="span" variant="secondary" size="base">
            {card.environmentName}
            {card.focus ? ` · focused on ${card.focus}` : ''}
          </Text>
        </>
      }
      meta={
        finished ? (
          <Badge variant={proposed ? 'success' : 'warning'} appearance="dot">
            {proposed ? 'Plan ready' : 'Nothing proposed'}
          </Badge>
        ) : (
          <Badge variant="neutral" appearance="dot">
            {transport === 'loading'
              ? 'Loading'
              : transport === 'polling'
                ? 'Reconnecting'
                : 'Live'}
          </Badge>
        )
      }
    >
      {!finished ? <LiveBrowser frame={live.frame} active caption={narration} size="sm" /> : null}

      {live.errorMessage && finished ? (
        <Text variant="secondary" size="base">
          {live.errorMessage.split('\n')[0]}
        </Text>
      ) : null}

      {steps.length > 0 ? <StepList steps={steps} /> : null}
    </CardFrame>
  )
}

function PlanCardView({ card, projectId }: { card: PlanCard; projectId: string }) {
  const queryClient = useQueryClient()
  const { data: intents } = useQuery(intentsQuery(projectId))

  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)

  const items = useMemo(
    () =>
      card.items.map((item, index) => {
        const live = item.intentId
          ? (intents?.find((row) => row.id === item.intentId) ?? null)
          : null

        return {
          key: item.intentId ?? `item-${index}`,
          intentId: item.intentId,
          title: live?.title ?? item.title,
          description: live?.description ?? item.description,
          removed: item.intentId !== null && intents !== undefined && live === null,
          status: live?.status ?? null,
          pending: live?.status === 'proposed',
        }
      }),
    [card.items, intents],
  )

  const selected = items
    .filter((item) => item.pending && item.intentId && !excluded.has(item.intentId))
    .map((item) => item.intentId!)

  const pendingCount = items.filter((item) => item.pending).length

  const approve = useMutation({
    mutationFn: () => approveProposedIntents({ data: { projectId, intentIds: selected } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
    },
  })

  const toggle = (intentId: string, checked: boolean) => {
    setExcluded((previous) => {
      const next = new Set(previous)
      if (checked) next.delete(intentId)
      else next.add(intentId)
      return next
    })
  }

  return (
    <CardFrame
      icon={<ListChecksIcon size={18} />}
      title={
        <>
          <Text as="span" bold>
            {card.title}
          </Text>
          <Text as="span" variant="secondary" size="base">
            {pendingCount === 0
              ? 'Nothing left to review.'
              : 'Untick anything you do not want, then generate.'}
          </Text>
        </>
      }
      footer={
        pendingCount > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Text as="span" variant="secondary" size="base">
              {selected.length} of {pendingCount} selected
            </Text>
            <Button
              variant="primary"
              size="sm"
              icon={<SparkleIcon size={16} />}
              loading={approve.isPending}
              disabled={selected.length === 0}
              onClick={() => approve.mutate()}
            >
              Generate {selected.length} test{selected.length === 1 ? '' : 's'}
            </Button>
          </div>
        ) : null
      }
    >
      {approve.error ? (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="Could not start generating"
          description={approve.error.message}
        />
      ) : null}

      <ul className="-mx-1 grid">
        {items.map((item) => (
          <li key={item.key} className="border-b border-kumo-hairline px-1 py-2 last:border-b-0">
            {editing !== null && editing === item.intentId ? (
              <PlanItemEditor
                intentId={item.intentId!}
                title={item.title}
                description={item.description}
                projectId={projectId}
                onClose={() => setEditing(null)}
              />
            ) : (
              <PlanItemRow
                item={item}
                projectId={projectId}
                checked={item.intentId !== null && !excluded.has(item.intentId)}
                onCheckedChange={(checked) => item.intentId && toggle(item.intentId, checked)}
                onEdit={() => setEditing(item.intentId)}
              />
            )}
          </li>
        ))}
      </ul>
    </CardFrame>
  )
}

interface PlanItem {
  key: string
  intentId: string | null
  title: string
  description: string
  removed: boolean
  status: IntentCard['status'] | null
  pending: boolean
}

function PlanItemRow({
  item,
  projectId,
  checked,
  onCheckedChange,
  onEdit,
}: {
  item: PlanItem
  projectId: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  onEdit: () => void
}) {
  const queryClient = useQueryClient()

  const dismiss = useMutation({
    mutationFn: () => dismissProposedIntent({ data: { intentId: item.intentId! } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: intentsQuery(projectId).queryKey })
    },
  })

  if (item.removed) {
    return (
      <div className="flex items-start gap-2">
        <span className="flex h-lh shrink-0 items-center text-kumo-subtle">
          <XIcon size={14} />
        </span>
        <Text as="span" variant="secondary" size="base">
          {item.title} — removed
        </Text>
      </div>
    )
  }

  if (!item.pending) {
    return (
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          {item.intentId ? (
            <Link
              to="/projects/$projectId/intents/$intentId"
              params={{ projectId, intentId: item.intentId }}
              className="truncate font-medium text-kumo-default hover:text-kumo-link"
            >
              {item.title}
            </Link>
          ) : (
            <Text as="span" bold>
              {item.title}
            </Text>
          )}
          <Text as="span" variant="secondary" size="base">
            {item.description}
          </Text>
        </div>
        {item.status ? <IntentStatusBadge status={item.status} /> : null}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        <span className="flex h-lh shrink-0 items-center">
          <Checkbox
            aria-label={`Include ${item.title}`}
            checked={checked}
            onCheckedChange={(value) => onCheckedChange(value === true)}
          />
        </span>
        <div className="grid min-w-0 gap-0.5">
          <Text as="span" bold>
            {item.title}
          </Text>
          <Text as="span" variant="secondary" size="base">
            {item.description}
          </Text>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          aria-label={`Edit ${item.title}`}
          onClick={onEdit}
        >
          <PencilSimpleIcon size={14} />
        </Button>
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          aria-label={`Remove ${item.title}`}
          loading={dismiss.isPending}
          onClick={() => dismiss.mutate()}
        >
          <XIcon size={14} />
        </Button>
      </div>
    </div>
  )
}

function PlanItemEditor({
  intentId,
  title,
  description,
  projectId,
  onClose,
}: {
  intentId: string
  title: string
  description: string
  projectId: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [draftTitle, setDraftTitle] = useState(title)
  const [draftDescription, setDraftDescription] = useState(description)

  const save = useMutation({
    mutationFn: () =>
      updateIntent({
        data: {
          intentId,
          title: draftTitle.trim(),
          description: draftDescription.trim(),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: intentsQuery(projectId).queryKey })
      onClose()
    },
  })

  return (
    <form
      className="grid gap-3 py-1"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      {save.error ? (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="Could not save"
          description={save.error.message}
        />
      ) : null}

      <Input
        label="Title"
        value={draftTitle}
        onChange={(event) => setDraftTitle(event.target.value)}
      />
      <InputArea
        label="What should happen?"
        autoResize
        minRows={3}
        maxRows={10}
        value={draftDescription}
        onChange={(event) => setDraftDescription(event.target.value)}
      />

      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          icon={<CheckIcon size={14} />}
          loading={save.isPending}
          disabled={draftTitle.trim().length === 0 || draftDescription.trim().length < 10}
        >
          Save
        </Button>
      </div>
    </form>
  )
}

function BatchCardView({ card, projectId }: { card: BatchCard; projectId: string }) {
  const queryClient = useQueryClient()
  const { job, live, transport } = useJobProgress(card.jobId)
  const finished = live.outcome !== null

  const { data: intents } = useQuery({
    ...intentsQuery(projectId),
    refetchInterval: finished ? false : POLL_INTERVAL_MS,
  })

  useEffect(() => {
    if (!finished) return
    void queryClient.invalidateQueries({ queryKey: intentsQuery(projectId).queryKey })
  }, [finished, projectId, queryClient])

  const members = card.intentIds.map((intentId) => {
    const row = intents?.find((item) => item.id === intentId) ?? null
    return {
      intentId,
      title: row?.title ?? intentId,
      status: row?.status ?? null,
      readiness: row?.readiness ?? 'draft',
      hasCode: (row?.currentVersion ?? 0) > 0,
    }
  })

  const done = finished
    ? members.length
    : members.filter((member) => member.readiness === 'ready' && member.hasCode).length
  const ready = members.filter((member) => member.readiness === 'ready' && member.hasCode).length
  const narration = live.logs.at(-1)?.line ?? null

  return (
    <CardFrame
      icon={finished ? <SparkleIcon size={18} /> : <Loader size="sm" />}
      title={
        <>
          <Text as="span" bold>
            {finished
              ? job?.status === 'succeeded'
                ? 'Generation complete'
                : 'Generation needs attention'
              : 'Writing the approved tests'}
          </Text>
          <Text as="span" variant="secondary" size="base">
            {card.environmentName} ·{' '}
            {finished ? `${ready} tests currently ready` : `${done} of ${members.length} done`}
          </Text>
        </>
      }
      meta={
        finished ? (
          <Badge variant={job?.status === 'succeeded' ? 'success' : 'warning'} appearance="dot">
            {job?.status === 'succeeded' ? 'Completed' : 'Needs attention'}
          </Badge>
        ) : (
          <Badge variant="neutral" appearance="dot">
            {transport === 'loading'
              ? 'Loading'
              : transport === 'polling'
                ? 'Reconnecting'
                : 'Live'}
          </Badge>
        )
      }
    >
      {narration && !finished ? (
        <Text variant="secondary" size="base">
          {narration}
        </Text>
      ) : null}

      {finished && live.errorMessage ? <Text variant="secondary">{live.errorMessage}</Text> : null}
      <ul className="grid gap-1.5">
        {members.map((member) => (
          <li key={member.intentId} className="flex flex-wrap items-start justify-between gap-3">
            <Link
              to="/projects/$projectId/intents/$intentId"
              params={{ projectId, intentId: member.intentId }}
              className="min-w-0 flex-1 break-words text-kumo-default hover:text-kumo-link"
            >
              <Text as="span" size="base">
                {member.title}
              </Text>
            </Link>
            {member.status ? <IntentStatusBadge status={member.status} /> : null}
          </li>
        ))}
      </ul>
    </CardFrame>
  )
}
