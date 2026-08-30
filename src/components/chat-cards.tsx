/**
 * What the assistant's answers are actually made of.
 *
 * A card is the visible half of a row the conversation created or touched, and
 * every one of them is a link out of the chat: the intent card opens the intent,
 * the run card opens the run, the environment card names the variables that now
 * exist. That is what keeps the conversation from being a place where things
 * live — nothing here is a record, everything here is a *view* of one.
 *
 * Two of them are live. A generation card reuses the run channel's feed to show
 * the script being written, in the same compact step list the intent page uses;
 * a run card polls the run it names until it has a verdict. Both fall silent and
 * become an ordinary link once the thing they describe has finished, so an old
 * transcript costs nothing to render.
 */
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
import { reduceFeed, useChannelFeed } from '#/lib/use-channel-feed.ts'
import { approveProposedIntents, dismissProposedIntent } from '#/server/explore.ts'
import { updateIntent } from '#/server/intents.ts'

const POLL_INTERVAL_MS = 2500

/** How many of a generation's steps a card shows before it stops growing. */
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
      return <SuiteCardView card={card} />
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

/**
 * The card frame.
 *
 * A `LayerCard` rather than a bordered div so a card reads as the same kind of
 * object the rest of the app shows in lists — and never nested, which is why the
 * message bubble around it is a plain container.
 */
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
        <div className="flex items-start justify-between gap-3">
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

/**
 * An intent, as it is *now* rather than as it was when the card was made.
 *
 * The card stores a snapshot so an old transcript renders without a query, but
 * an intent created a minute ago and generated since would otherwise sit in the
 * conversation reading "Draft" for ever. The project's intent listing is already
 * loaded and already invalidated at the end of every turn, so reading the live
 * row out of it costs nothing and never goes stale.
 */
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
            <Text as="span" variant="secondary" size="xs">
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

/**
 * The script being written, inside a message.
 *
 * Deliberately the same feed and the same `StepList` as the intent page's
 * generation panel: these are the same events, and a generation watched from the
 * chat should look like a generation watched anywhere else. Only the amount is
 * different — a card shows the last few steps and the newest narration line,
 * because a message is not the place to read a hundred of them.
 */
function GenerationCardView({ card, projectId }: { card: GenerationCard; projectId: string }) {
  const { envelopes, transport } = useChannelFeed(card.jobId)
  const live = reduceFeed(envelopes)

  const finished = live.outcome !== null
  const succeeded = live.outcome === 'passed'
  const steps = live.steps.slice(-MAX_CARD_STEPS)
  const narration = live.logs.at(-1)?.line ?? null

  return (
    <CardFrame
      icon={finished ? <SparkleIcon size={18} /> : <Loader size="sm" />}
      title={
        <>
          <Text as="span" bold truncate>
            {finished
              ? succeeded
                ? 'Script generated and verified'
                : 'Generation did not finish'
              : 'Writing the script'}
          </Text>
          <Text as="span" variant="secondary" size="xs" truncate>
            {card.intentTitle} · {card.environmentName}
          </Text>
        </>
      }
      meta={
        finished ? (
          <Badge variant={succeeded ? 'success' : 'error'} appearance="dot">
            {succeeded ? 'Verified' : 'Incomplete'}
          </Badge>
        ) : (
          <Badge variant="neutral" appearance="dot">
            {transport === 'polling' ? 'Reconnecting' : 'Live'}
          </Badge>
        )
      }
      footer={
        <LinkButton
          href={`/projects/${projectId}/intents/${card.intentId}`}
          variant="ghost"
          size="xs"
          icon={ArrowSquareOutIcon}
        >
          Open the test
        </LinkButton>
      }
    >
      {narration && !finished ? (
        <Text variant="secondary" size="xs">
          {narration}
        </Text>
      ) : null}

      {live.errorMessage && finished ? (
        <Text variant="secondary" size="xs">
          {live.errorMessage.split('\n')[0]}
        </Text>
      ) : null}

      {steps.length > 0 ? <StepList steps={steps} /> : null}
    </CardFrame>
  )
}

/**
 * One run. Polled rather than socketed: a run card is usually read after the
 * fact, and the step-by-step view already has a home on the run page.
 */
function RunCardView({ card, projectId }: { card: RunCard; projectId: string }) {
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
          <Text as="span" variant="secondary" size="xs" truncate>
            {card.environmentName}
            {durationMs ? ' · ' : ''}
            {durationMs ? <Duration ms={durationMs} /> : null}
          </Text>
        </>
      }
      meta={<RunStatusBadge status={status} />}
    />
  )
}

/** A "run all". The counts are the whole story, so they are the whole card. */
function SuiteCardView({ card }: { card: SuiteCard }) {
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

  return (
    <CardFrame
      icon={running ? <Loader size="sm" /> : <StackIcon size={18} />}
      title={
        <>
          <Text as="span" bold>
            Running every test
          </Text>
          <Text as="span" variant="secondary" size="xs">
            {card.environmentName}
            {suite ? ` · ${done} of ${suite.totalCount} done` : null}
          </Text>
        </>
      }
      meta={<SuiteRunStatusBadge status={status} />}
    >
      {suite && suite.totalCount > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <Text as="span" size="xs" variant={suite.passedCount > 0 ? 'success' : 'secondary'}>
            {suite.passedCount} passed
          </Text>
          <Text as="span" size="xs" variant={suite.failedCount > 0 ? 'error' : 'secondary'}>
            {suite.failedCount} failed
          </Text>
          <Text as="span" size="xs" variant="secondary">
            {suite.errorCount} errored
          </Text>
        </div>
      ) : null}
    </CardFrame>
  )
}

function EnvironmentCardView({ card }: { card: EnvironmentCard }) {
  return (
    <CardFrame
      icon={<GlobeIcon size={18} />}
      title={
        <>
          <Text as="span" bold truncate>
            {card.name}
          </Text>
          <Text as="span" variant="mono-secondary" truncate>
            {card.baseUrl}
          </Text>
        </>
      }
      meta={
        card.isDefault ? (
          <Badge variant="blue" appearance="dot">
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
        <Text variant="secondary" size="xs">
          No credentials stored yet.
        </Text>
      )}
    </CardFrame>
  )
}

/**
 * The agent going round the app.
 *
 * The same feed and the same `StepList` as a generation, because they are the
 * same events from the same harness — what differs is that this one has no
 * script to show and no verdict of its own. When it finishes, the plan arrives
 * as a *separate message*, which is why the completion here re-reads the
 * conversation: the workflow posted that message minutes after the turn ended,
 * so nothing else on the page knows it exists.
 */
function ExploreCardView({ card, projectId }: { card: ExploreCard; projectId: string }) {
  const { envelopes, transport } = useChannelFeed(card.jobId)
  const live = reduceFeed(envelopes)
  const queryClient = useQueryClient()

  const finished = live.outcome !== null
  const proposed = live.outcome === 'passed'
  const steps = live.steps.slice(-MAX_CARD_STEPS)
  const narration = live.logs.at(-1)?.line ?? null

  // The plan is a message the *workflow* posted, minutes after the turn that
  // started it ended — so nothing else on this page knows it exists. Re-reading
  // the conversation the moment the job reports finished is what makes the plan
  // appear, including in the case the chat object was mid-turn and could not
  // broadcast it.
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
          <Text as="span" bold truncate>
            {finished
              ? proposed
                ? 'Explored the app'
                : 'The exploration stopped early'
              : 'Exploring the app'}
          </Text>
          <Text as="span" variant="secondary" size="xs" truncate>
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
            {transport === 'polling' ? 'Reconnecting' : 'Live'}
          </Badge>
        )
      }
    >
      {narration && !finished ? (
        <Text variant="secondary" size="xs">
          {narration}
        </Text>
      ) : null}

      {live.errorMessage && finished ? (
        <Text variant="secondary" size="xs">
          {live.errorMessage.split('\n')[0]}
        </Text>
      ) : null}

      {steps.length > 0 ? <StepList steps={steps} /> : null}
    </CardFrame>
  )
}

/**
 * The plan: a checklist of proposed tests, and a button that generates them.
 *
 * The card stores a snapshot of each item so an old transcript is legible, but
 * the *live* intent rows are what it acts on — so a proposal edited on the
 * Intents tab shows its new title here, one that has already been approved
 * shows its real status instead of a checkbox, and one that was dismissed reads
 * as removed rather than silently vanishing from a list somebody remembers
 * ticking.
 *
 * Deliberately a real affordance rather than a suggestion to type something:
 * approving is one click on the thing you are already reading, and it calls the
 * same server function the assistant's `approve_plan` tool does.
 */
function PlanCardView({ card, projectId }: { card: PlanCard; projectId: string }) {
  const queryClient = useQueryClient()
  const { data: intents } = useQuery(intentsQuery(projectId))

  /** Ids the user has un-ticked. Default-checked, so absence means selected. */
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
          // No live row and a listing that has loaded means the intent is gone.
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
      // The batch posts its own message into the conversation, and every
      // intent it touched has just changed status.
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
          <Text as="span" bold truncate>
            {card.title}
          </Text>
          <Text as="span" variant="secondary" size="xs">
            {pendingCount === 0
              ? 'Nothing left to review.'
              : 'Untick anything you do not want, then generate.'}
          </Text>
        </>
      }
      footer={
        pendingCount > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Text as="span" variant="secondary" size="xs">
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
        <Text as="span" variant="secondary" size="xs" truncate>
          {item.title} — removed
        </Text>
      </div>
    )
  }

  // Approved already: it is an ordinary test now, so it links like one and
  // shows the status its generation earned rather than a checkbox nobody can
  // usefully tick.
  if (!item.pending) {
    return (
      <div className="flex items-start justify-between gap-3">
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
            <Text as="span" bold truncate>
              {item.title}
            </Text>
          )}
          <Text as="span" variant="secondary" size="xs" truncate>
            {item.description}
          </Text>
        </div>
        {item.status ? <IntentStatusBadge status={item.status} /> : null}
      </div>
    )
  }

  return (
    <div className="flex items-start justify-between gap-3">
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
          <Text as="span" variant="secondary" size="xs">
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

/**
 * Editing a proposal in place.
 *
 * The same `update_intent` the assistant calls, which matters more than it
 * looks: a description is the permanent source of truth a script gets generated
 * from, so the moment before approval is exactly when someone wants to correct
 * it — and correcting it here has to produce the same row a correction anywhere
 * else would.
 */
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

/**
 * An approved plan being written, one test at a time.
 *
 * Two live sources, because they answer different questions and neither implies
 * the other: the channel says what the batch is *doing* — which member, how far
 * in — and the intent rows say what each member has *become*. The listing is
 * polled while the batch is running, which is also what keeps every other intent
 * card in the transcript current, since they all read the same query.
 */
function BatchCardView({ card, projectId }: { card: BatchCard; projectId: string }) {
  const queryClient = useQueryClient()
  const { envelopes, transport } = useChannelFeed(card.jobId)
  const live = reduceFeed(envelopes)
  const finished = live.outcome !== null

  const { data: intents } = useQuery({
    ...intentsQuery(projectId),
    refetchInterval: finished ? false : POLL_INTERVAL_MS,
  })

  // The channel says "done" a moment before the last member's verdict is
  // readable, and stopping the poll on that word alone freezes the card on the
  // second-to-last state — every member still reading `Generating` under a
  // heading that says it finished. One read after the end is what makes the
  // final answer the one that stays on screen.
  useEffect(() => {
    if (!finished) return
    void queryClient.invalidateQueries({ queryKey: intentsQuery(projectId).queryKey })
  }, [finished, projectId, queryClient])

  const members = card.intentIds.map((intentId) => {
    const row = intents?.find((item) => item.id === intentId) ?? null
    return { intentId, title: row?.title ?? intentId, status: row?.status ?? null }
  })

  const done = members.filter(
    (member) => member.status === 'passing' || member.status === 'failing',
  ).length
  const passed = members.filter((member) => member.status === 'passing').length
  const narration = live.logs.at(-1)?.line ?? null

  return (
    <CardFrame
      icon={finished ? <SparkleIcon size={18} /> : <Loader size="sm" />}
      title={
        <>
          <Text as="span" bold truncate>
            {finished ? 'Finished generating' : 'Writing the approved tests'}
          </Text>
          <Text as="span" variant="secondary" size="xs" truncate>
            {card.environmentName} · {done} of {members.length} done
          </Text>
        </>
      }
      meta={
        finished ? (
          <Badge variant={passed === members.length ? 'success' : 'warning'} appearance="dot">
            {passed} of {members.length} passing
          </Badge>
        ) : (
          <Badge variant="neutral" appearance="dot">
            {transport === 'polling' ? 'Reconnecting' : 'Live'}
          </Badge>
        )
      }
    >
      {narration && !finished ? (
        <Text variant="secondary" size="xs">
          {narration}
        </Text>
      ) : null}

      <ul className="grid gap-1.5">
        {members.map((member) => (
          <li key={member.intentId} className="flex items-start justify-between gap-3">
            <Link
              to="/projects/$projectId/intents/$intentId"
              params={{ projectId, intentId: member.intentId }}
              className="truncate text-kumo-default hover:text-kumo-link"
            >
              <Text as="span" size="xs">
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
