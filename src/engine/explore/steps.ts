import { and, asc, eq, inArray } from 'drizzle-orm'
import { NonRetryableError } from 'cloudflare:workflows'
import { env as workerEnv } from 'cloudflare:workers'

import { createDb } from '#/db/index.ts'
import { environment, generationJob, intent, project } from '#/db/schema/app.ts'
import type { ChatPart } from '#/engine/chat/contract.ts'
import type { Proposal } from '#/engine/explore/loop.ts'
import { buildContextSection } from '#/engine/explore/prompts.ts'
import { loadCredentialNames, loadCredentials } from '#/engine/generation/loop.ts'
import { announceRun } from '#/engine/run-steps.ts'
import { createScrubber } from '#/engine/runner/scrub.ts'
import { appendProjectContext, createIntentRecord, queueBatchGeneration } from '#/server/actions.ts'

export interface LoadedExploration {
  jobId: string
  projectId: string
  environmentId: string
  organizationId: string
  userId: string
  projectName: string
  projectDescription: string | null
  projectModelId: string | null
  projectContext: string | null
  environmentName: string
  baseUrl: string
  credentialNames: Array<string>
  existingTitles: Array<string>
  focus: string | null
}

export async function loadExploration(
  env: Cloudflare.Env,
  params: { jobId: string; organizationId: string; focus: string | null },
): Promise<LoadedExploration> {
  const db = createDb(env.DB)

  const [row] = await db
    .select({ job: generationJob, project, environment })
    .from(generationJob)
    .innerJoin(project, eq(project.id, generationJob.projectId))
    .innerJoin(environment, eq(environment.id, generationJob.environmentId))
    .where(
      and(
        eq(generationJob.id, params.jobId),
        eq(project.organizationId, params.organizationId),
        eq(generationJob.organizationId, params.organizationId),
      ),
    )
    .limit(1)

  if (!row) {
    throw new NonRetryableError(
      `Exploration job ${params.jobId} does not exist in this organization.`,
    )
  }

  const titles = await db
    .select({ title: intent.title })
    .from(intent)
    .where(eq(intent.projectId, row.project.id))
    .orderBy(asc(intent.createdAt))

  await db
    .update(generationJob)
    .set({ status: 'running' })
    .where(eq(generationJob.id, params.jobId))

  await announceRun(env, params.jobId, {
    type: 'run.started',
    runId: params.jobId,
    at: Date.now(),
  })

  return {
    jobId: params.jobId,
    projectId: row.project.id,
    environmentId: row.environment.id,
    organizationId: params.organizationId,
    userId: row.job.createdBy,
    projectName: row.project.name,
    projectDescription: row.project.description,
    projectModelId: row.project.modelId,
    projectContext: row.project.context,
    environmentName: row.environment.name,
    baseUrl: row.environment.baseUrl,
    credentialNames: await loadCredentialNames(env, row.environment.id),
    existingTitles: titles.map((item) => item.title),
    focus: params.focus,
  }
}

export interface PersistedExploration {
  jobId: string
  intentIds: Array<string>
  titles: Array<string>
}

export async function persistExploration(
  env: Cloudflare.Env,
  loaded: LoadedExploration,
  context: {
    proposals: Array<Proposal>
    summary: string | null
    turns: number
    modelId: string | null
    usage?: { inputTokens: number; outputTokens: number }
    autoGenerate?: boolean
  },
): Promise<PersistedExploration> {
  const db = createDb(env.DB)

  const scrubber = createScrubber(Object.values(await loadCredentials(env, loaded.environmentId)))

  const created: Array<{ id: string; title: string; description: string }> = []

  for (const proposal of context.proposals) {
    const title = scrubber.text(proposal.title)
    const description = scrubber.text(proposal.description)

    const row = await createIntentRecord(db, {
      projectId: loaded.projectId,
      title,
      description,
      createdBy: loaded.userId,
      status: 'proposed',
    })

    created.push({ id: row.id, title, description })
  }

  const summary = scrubber.nullable(context.summary)

  await appendProjectContext(
    db,
    loaded.projectId,
    buildContextSection({
      summary,
      titles: created.map((item) => item.title),
      focus: loaded.focus ? scrubber.text(loaded.focus) : null,
      at: new Date(),
    }),
  )

  await db
    .update(generationJob)
    .set({
      status: 'succeeded',
      modelId: context.modelId,
      turns: context.turns,
      inputTokens: context.usage?.inputTokens ?? 0,
      outputTokens: context.usage?.outputTokens ?? 0,
      stuckReason: null,
      finishedAt: new Date(),
    })
    .where(eq(generationJob.id, loaded.jobId))

  let batch: { jobId: string; intentIds: Array<string> } | null = null
  if (context.autoGenerate && created.length > 0) {
    try {
      const [environmentRow] = await db
        .select()
        .from(environment)
        .where(eq(environment.id, loaded.environmentId))
        .limit(1)
      if (environmentRow) {
        batch = await queueBatchGeneration(db, {
          projectId: loaded.projectId,
          organizationId: loaded.organizationId,
          environment: environmentRow,
          createdBy: loaded.userId,
          intentIds: created.map((item) => item.id),
        })
      }
    } catch (error) {
      console.error(`[explore] ${loaded.jobId} could not start generating its plan:`, error)
    }
  }

  await announceChatPlan(loaded, created, summary, batch)

  await announceRun(
    env,
    loaded.jobId,
    {
      type: 'run.finished',
      runId: loaded.jobId,
      outcome: 'passed',
      errorMessage: null,
      at: Date.now(),
    },
    { final: true },
  )

  return {
    jobId: loaded.jobId,
    intentIds: created.map((item) => item.id),
    titles: created.map((item) => item.title),
  }
}

async function announceChatPlan(
  loaded: LoadedExploration,
  created: Array<{ id: string; title: string; description: string }>,
  summary: string | null,
  batch: { jobId: string; intentIds: Array<string> } | null,
): Promise<void> {
  const count = created.length
  const plural = count === 1 ? '' : 's'

  const intro = summary ?? `I have been round ${loaded.projectName}.`
  const next = batch
    ? `I have started writing all ${count} test${plural} now. Each one is built against the live site and checked in a fresh browser before it is kept, so the ones that verify will be ready to run without you touching them. Review anything below at your own pace; you can edit a test or throw it away at any time.`
    : `Here is what I would test — review it and generate the ones you want.`

  const parts: Array<ChatPart> = [
    {
      type: 'text',
      text: `${intro}\n\n${next}`,
    },
    {
      type: 'card',
      card: {
        kind: 'plan',
        planId: loaded.jobId,
        title: `${count} proposed test${count === 1 ? '' : 's'}`,
        items: created.map((item) => ({
          intentId: item.id,
          title: item.title,
          description: item.description,
        })),
      },
    },
  ]

  if (batch) {
    parts.push({
      type: 'card',
      card: {
        kind: 'batch',
        jobId: batch.jobId,
        environmentName: loaded.environmentName,
        intentIds: batch.intentIds,
      },
    })
  }

  try {
    await workerEnv.PROJECT_CHAT.getByName(loaded.projectId).announce({
      projectId: loaded.projectId,
      organizationId: loaded.organizationId,
      parts,
    })
  } catch (error) {
    console.error(`[explore] ${loaded.jobId} could not post its plan to the chat:`, error)
  }
}

export async function abandonExploration(
  env: Cloudflare.Env,
  loaded: LoadedExploration,
  context: {
    reason: string
    turns: number
    modelId: string | null
    usage?: { inputTokens: number; outputTokens: number }
  },
): Promise<void> {
  const db = createDb(env.DB)

  await db
    .update(generationJob)
    .set({
      status: 'failed',
      modelId: context.modelId,
      turns: context.turns,
      inputTokens: context.usage?.inputTokens ?? 0,
      outputTokens: context.usage?.outputTokens ?? 0,
      stuckReason: context.reason,
      finishedAt: new Date(),
    })
    .where(eq(generationJob.id, loaded.jobId))

  await announceRun(
    env,
    loaded.jobId,
    {
      type: 'run.finished',
      runId: loaded.jobId,
      outcome: 'failed',
      errorMessage: context.reason,
      at: Date.now(),
    },
    { final: true },
  )
}

export async function failExploration(
  env: Cloudflare.Env,
  jobId: string,
  error: unknown,
): Promise<void> {
  const db = createDb(env.DB)

  await db
    .update(generationJob)
    .set({
      status: 'failed',
      stuckReason: 'The exploration could not be completed.',
      finishedAt: new Date(),
    })
    .where(and(eq(generationJob.id, jobId), inArray(generationJob.status, ['queued', 'running'])))

  console.error(`[explore] ${jobId} failed:`, error)

  await announceRun(
    env,
    jobId,
    {
      type: 'run.finished',
      runId: jobId,
      outcome: 'error',
      errorMessage: 'The exploration could not be completed.',
      at: Date.now(),
    },
    { final: true },
  )
}
