import { Badge, Banner, Button, LinkButton, Loader, Text } from '@cloudflare/kumo'
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  DownloadSimpleIcon,
  FileTextIcon,
  ImageIcon,
  WarningCircleIcon,
  WaveformIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { createLink, Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { Duration } from '#/components/ui/duration.tsx'
import { InlineEmpty } from '#/components/ui/list.tsx'
import { MonoPanel } from '#/components/ui/mono-panel.tsx'
import { RunStatusBadge } from '#/components/ui/status-badge.tsx'
import { StepList } from '#/components/runs/step-list.tsx'
import { SummaryStrip } from '#/components/ui/summary-strip.tsx'
import type { ArtifactKeys, RunPurpose, RunStatus, RunTrigger } from '#/db/schema/app.ts'
import { runQuery } from '#/lib/queries.ts'
import type { RunResult } from '#/engine/contract.ts'
import { readTranscript } from '#/lib/transcript.ts'
import { describePurpose } from '#/lib/format.ts'

const RouterLinkButton = createLink(LinkButton)

export interface RunDetailAttempt {
  id: string
  attemptNumber: number
  outcome: 'passed' | 'failed' | 'error'
  diagnosis: string | null
  artifactKeys: ArtifactKeys | null
  result?: RunResult | null
  artifactWarnings?: Array<string> | null
  logs: string | null
  errorMessage: string | null
  durationMs: number | null
  scriptUsed: string
}

export interface RunDetailData {
  run: {
    id: string
    status: RunStatus
    trigger: RunTrigger
    purpose: RunPurpose
    errorMessage: string | null
  }
  environment: { id: string; name: string; baseUrl: string | null }
  scriptVersion: { id: string; version: number }
  intent: { id: string; title: string }
  attempts: Array<RunDetailAttempt>
}

const TRIGGER_LABEL: Record<RunTrigger, string> = {
  manual: 'Manual',
  regenerate: 'Regenerated',
  schedule: 'Schedule',
  webhook: 'Webhook',
  repair: 'Repair',
}

export function RunDetailPanel({ runId, projectId }: { runId: string; projectId: string }) {
  const { data, isPending, error } = useQuery(runQuery(runId))

  if (isPending) {
    return (
      <div className="flex items-center gap-2 py-2">
        <Loader size="sm" />
        <Text as="span" variant="secondary" size="base">
          Loading the attempt…
        </Text>
      </div>
    )
  }

  if (error) {
    return (
      <Banner
        variant="error"
        icon={<WarningCircleIcon weight="fill" />}
        title="Could not load this run"
        description={error.message}
      />
    )
  }

  return (
    <div className="grid gap-4 py-2">
      <div className="flex justify-end">
        <RouterLinkButton
          to="/projects/$projectId/runs/$runId"
          params={{ projectId, runId }}
          variant="ghost"
          size="sm"
          icon={ArrowSquareOutIcon}
        >
          Open
        </RouterLinkButton>
      </div>
      <RunDetail data={data} projectId={projectId} variant="inline" />
    </div>
  )
}

export function RunDetail({
  data,
  projectId,
  variant,
}: {
  data: RunDetailData
  projectId: string
  variant: 'inline' | 'page'
}) {
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Text variant="secondary">
          {data.run.purpose === 'regression'
            ? 'Regression execution'
            : `${describePurpose(data.run.purpose)} · excluded from regression results`}
        </Text>
      </div>
      {variant === 'page' ? (
        <RunSummary data={data} projectId={projectId} lastAttempt={data.attempts.at(-1) ?? null} />
      ) : null}

      {data.attempts.length === 0 ? (
        <InlineEmpty
          message={data.run.errorMessage ?? 'This run has not recorded an attempt yet.'}
        />
      ) : null}
      {data.attempts.map((attempt) => (
        <AttemptDetail
          key={attempt.id}
          runId={data.run.id}
          projectId={projectId}
          attempt={attempt}
          environmentName={data.environment.name}
          showAttemptNumber={data.attempts.length > 1}
          showSummary={variant === 'inline'}
        />
      ))}
    </div>
  )
}

function RunSummary({
  data,
  projectId,
  lastAttempt,
}: {
  data: RunDetailData
  projectId: string
  lastAttempt: RunDetailAttempt | null
}) {
  const transcript = useMemo(() => readTranscript(lastAttempt), [lastAttempt])
  const completed = transcript.steps.filter((step) => step.ok).length

  const durationMs = data.attempts.reduce((total, attempt) => total + (attempt.durationMs ?? 0), 0)

  return (
    <SummaryStrip
      items={[
        {
          key: 'status',
          label: 'Status',
          value: <RunStatusBadge status={data.run.status} />,
        },
        {
          key: 'steps',
          label: 'Steps completed',
          value: (
            <Text as="span" variant="heading">
              {completed}
              <span className="text-kumo-subtle">/{transcript.steps.length}</span>
            </Text>
          ),
        },
        {
          key: 'duration',
          label: 'Duration',
          value: <Duration ms={data.attempts.length === 0 ? null : durationMs} />,
        },
        {
          key: 'environment',
          label: 'Environment',
          value: (
            <div className="grid gap-1 break-words">
              <Text as="span">{data.environment.name}</Text>
              <Text variant="secondary">
                {data.environment.baseUrl ?? 'URL not recorded (historical run)'}
              </Text>
            </div>
          ),
        },
        {
          key: 'trigger',
          label: 'Trigger',
          value: <Text as="span">{TRIGGER_LABEL[data.run.trigger] ?? data.run.trigger}</Text>,
        },
        {
          key: 'script',
          label: 'Script',
          value: (
            <Link
              to="/projects/$projectId/intents/$intentId"
              params={{ projectId, intentId: data.intent.id }}
              search={{ tab: 'history' }}
              className="font-mono text-kumo-link hover:underline"
            >
              v{data.scriptVersion.version}
            </Link>
          ),
        },
        {
          key: 'intent',
          label: 'Test',
          wide: true,
          value: (
            <Link
              to="/projects/$projectId/intents/$intentId"
              params={{ projectId, intentId: data.intent.id }}
              className="block break-words text-kumo-link hover:underline"
            >
              {data.intent.title}
            </Link>
          ),
        },
      ]}
    />
  )
}

const ARTIFACT_LABELS: Record<keyof ArtifactKeys, { label: string; icon: React.ReactNode }> = {
  screenshot: { label: 'Screenshot', icon: <ImageIcon size={14} /> },
  trace: { label: 'Trace', icon: <WaveformIcon size={14} /> },
  logs: { label: 'Logs', icon: <FileTextIcon size={14} /> },
  video: { label: 'Video', icon: <WaveformIcon size={14} /> },
}

function artifactHref(key: string): string {
  return `/api/artifacts/${key.split('/').map(encodeURIComponent).join('/')}`
}

const OUTCOME_BADGE = {
  passed: { label: 'Passed', variant: 'success' },
  failed: { label: 'Failed', variant: 'error' },
  error: { label: 'Errored', variant: 'warning' },
} as const

function AttemptDetail({
  runId,
  projectId,
  attempt,
  environmentName,
  showAttemptNumber,
  showSummary,
}: {
  runId: string
  projectId: string
  attempt: RunDetailAttempt
  environmentName: string
  showAttemptNumber: boolean
  showSummary: boolean
}) {
  const [showScript, setShowScript] = useState(false)
  const transcript = useMemo(() => readTranscript(attempt), [attempt])

  const artifacts = Object.entries(attempt.artifactKeys ?? {}).filter(
    (entry): entry is [keyof ArtifactKeys, string] => typeof entry[1] === 'string',
  )

  const outcome = OUTCOME_BADGE[attempt.outcome] ?? OUTCOME_BADGE.error
  const completed = transcript.steps.filter((step) => step.ok).length

  const output = useMemo(() => {
    if (transcript.logs.length === 0) return null
    const joined = transcript.logs.join('\n')
    const message = attempt.errorMessage
    if (!message) return joined
    const remaining = transcript.logs.filter((line) => !message.includes(line))
    return remaining.length === 0 ? null : remaining.join('\n')
  }, [transcript.logs, attempt.errorMessage])

  return (
    <div className="grid gap-4">
      {showSummary ? (
        <SummaryStrip
          items={[
            ...(showAttemptNumber
              ? [
                  {
                    key: 'attempt',
                    label: 'Attempt',
                    value: (
                      <Text as="span" variant="heading">
                        {attempt.attemptNumber}
                      </Text>
                    ),
                  },
                ]
              : []),
            {
              key: 'status',
              label: 'Status',
              value: (
                <Badge variant={outcome.variant} appearance="dot">
                  {outcome.label}
                </Badge>
              ),
            },
            {
              key: 'steps',
              label: 'Steps completed',
              value: (
                <Text as="span" variant="heading">
                  {completed}
                  <span className="text-kumo-subtle">/{transcript.steps.length}</span>
                </Text>
              ),
            },
            {
              key: 'duration',
              label: 'Duration',
              value: <Duration ms={attempt.durationMs} />,
            },
            {
              key: 'environment',
              label: 'Environment',
              value: <Text as="span">{environmentName}</Text>,
            },
            ...(attempt.diagnosis
              ? [
                  {
                    key: 'diagnosis',
                    label: 'Diagnosis',
                    value: <Badge variant="neutral">{attempt.diagnosis}</Badge>,
                  },
                ]
              : []),
          ]}
        />
      ) : null}

      {attempt.errorMessage ? (
        <div className="grid gap-2">
          <Text as="h3" variant="heading">
            {transcript.steps.find((step) => !step.ok)?.label ?? 'Execution error'}
          </Text>
          <MonoPanel label="Recorded error" text={attempt.errorMessage} tone="danger" />
        </div>
      ) : null}

      <div className="grid gap-2">
        <Text as="h3" variant="heading">
          {showAttemptNumber ? `Step history · attempt ${attempt.attemptNumber}` : 'Step history'}
        </Text>
        {transcript.steps.length === 0 ? (
          <InlineEmpty message="No step transcript was recorded for this attempt." />
        ) : (
          <StepList steps={transcript.steps} showOffset />
        )}
      </div>

      {output === null ? null : (
        <details>
          <summary className="cursor-pointer text-sm text-kumo-subtle">Console output</summary>
          <div className="mt-3">
            <MonoPanel label="Output" text={output} />
          </div>
        </details>
      )}

      {attempt.artifactWarnings?.length ? (
        <Banner
          variant="alert"
          title="Some evidence could not be collected"
          description={attempt.artifactWarnings.join(' · ')}
        />
      ) : null}
      {attempt.artifactKeys?.screenshot ? (
        <a
          href={artifactHref(attempt.artifactKeys.screenshot)}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-lg ring ring-kumo-hairline"
        >
          <img
            src={artifactHref(attempt.artifactKeys.screenshot)}
            alt="Page captured when the test failed"
            loading="lazy"
            className="max-h-96 w-full object-contain bg-kumo-recessed"
          />
        </a>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {artifacts.length === 0 ? (
          <Text as="span" variant="secondary" size="base">
            No artifacts.
          </Text>
        ) : (
          artifacts.map(([kind, key]) =>
            kind === 'trace' ? (
              <TraceActions key={kind} runId={runId} projectId={projectId} artifactKey={key} />
            ) : (
              <LinkButton
                key={kind}
                href={artifactHref(key)}
                target="_blank"
                rel="noreferrer"
                variant="secondary"
                size="sm"
              >
                {ARTIFACT_LABELS[kind].label}
              </LinkButton>
            ),
          )
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<CaretDownIcon size={14} className={showScript ? 'rotate-180' : '-rotate-90'} />}
          onClick={() => setShowScript((previous) => !previous)}
        >
          {showScript ? 'Hide the script that ran' : 'Show the script that ran'}
        </Button>
      </div>

      {showScript ? (
        <MonoPanel label="Script that ran" text={attempt.scriptUsed} language="javascript" />
      ) : null}
    </div>
  )
}

function TraceActions({
  runId,
  projectId,
  artifactKey,
}: {
  runId: string
  projectId: string
  artifactKey: string
}) {
  return (
    <>
      <LinkButton
        href={artifactHref(artifactKey)}
        target="_blank"
        rel="noreferrer"
        variant="secondary"
        size="sm"
        icon={DownloadSimpleIcon}
      >
        Download trace
      </LinkButton>
      <RouterLinkButton
        to="/projects/$projectId/runs/$runId/trace"
        params={{ projectId, runId }}
        search={{ key: artifactKey }}
        variant="secondary"
        size="sm"
        icon={WaveformIcon}
      >
        Open trace viewer
      </RouterLinkButton>
    </>
  )
}
