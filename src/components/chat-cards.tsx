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
import { Badge, LayerCard, LinkButton, Loader, Text } from '@cloudflare/kumo'
import {
  ArrowSquareOutIcon,
  ClockIcon,
  GlobeIcon,
  PlayIcon,
  SparkleIcon,
  StackIcon,
  TestTubeIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { Duration } from '#/components/duration.tsx'
import {
  IntentStatusBadge,
  RunStatusBadge,
  SuiteRunStatusBadge,
} from '#/components/status-badge.tsx'
import { StepList } from '#/components/step-list.tsx'
import type {
  ChatCard,
  EnvironmentCard,
  GenerationCard,
  IntentCard,
  PlanCard,
  RunCard,
  SuiteCard,
} from '#/engine/chat/contract.ts'
import { describeCron } from '#/lib/cron.ts'
import { intentsQuery, runQuery, suiteRunQuery } from '#/lib/queries.ts'
import { reduceFeed, useChannelFeed } from '#/lib/use-channel-feed.ts'

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
    case 'plan':
      return <PlanCardView card={card} />
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

/** Reserved for M9c. Rendered read-only so an early plan is at least legible. */
function PlanCardView({ card }: { card: PlanCard }) {
  return (
    <CardFrame
      icon={<StackIcon size={18} />}
      title={
        <Text as="span" bold truncate>
          {card.title}
        </Text>
      }
    >
      <ul className="grid gap-1.5">
        {card.items.map((item, index) => (
          <li key={item.intentId ?? `${index}`}>
            <Text as="span" size="xs">
              {item.title}
            </Text>
          </li>
        ))}
      </ul>
    </CardFrame>
  )
}
