/**
 * What an exploration *is*, outside the workflow that orders it.
 *
 * Same split as `run-steps.ts` and `generation/steps.ts`, and for the same
 * reason: each function here is written to be the body of a Workflow step, so
 * each is re-runnable, returns only what survives a JSON trip, and lets nothing
 * live or secret cross a boundary.
 *
 * The shape of the job:
 *
 * 1. The job row is claimed and the browser is opened on the environment.
 * 2. The model goes round the app, reads whatever docs it was pointed at, and
 *    ends with a list of tests it thinks are worth having.
 * 3. Those become **real intent rows** in `'proposed'` — not a JSON blob on the
 *    job, not a message in a transcript. They can be edited, deleted and
 *    approved by anybody, from the chat or from the Intents tab, and nothing
 *    about them is different from an intent somebody typed except that they are
 *    excluded from everything that runs until approved.
 * 4. What the explorer *learned* is appended to `project.context`, redacted, so
 *    the next generation and the next conversation start from it.
 *
 * An exploration that proposes nothing is a failure with a readable reason, not
 * an error: the site was down, or the front door could not be opened, and the
 * person who asked should be told which.
 */
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
import { appendProjectContext, createIntentRecord } from '#/server/actions.ts'

/** Everything a turn needs about the job, and nothing that could go stale. */
export interface LoadedExploration {
  jobId: string
  projectId: string
  environmentId: string
  organizationId: string
  userId: string
  projectName: string
  projectDescription: string | null
  /** The project's model choice; null falls through the resolution chain. */
  projectModelId: string | null
  /** Redacted standing knowledge, from `project.context`. */
  projectContext: string | null
  environmentName: string
  baseUrl: string
  /** Names only — a value has no business in a prompt or a workflow step. */
  credentialNames: Array<string>
  /** What the project already tests, so nothing is proposed twice. */
  existingTitles: Array<string>
  focus: string | null
}

/**
 * Resolves the job, claims it, and says so.
 *
 * Read back through the organization the caller was in at enqueue time, for the
 * same reason a run is: a job row retargeted between enqueue and execution must
 * resolve to nothing rather than to another tenant's project.
 */
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

/**
 * Writes the plan down: the intents, the context, the job's verdict, and a
 * message in the project's chat carrying the reviewable card.
 *
 * Everything the model produced is scrubbed here, at the last point where the
 * plaintext credentials still exist in this isolate. The prompt tells it never
 * to write a value into a proposal; this is what makes that true rather than
 * hopeful, and it covers the summary that goes into `project.context` as well —
 * that column is read into every future prompt, so a value that got in there
 * would be read out for ever.
 */
export async function persistExploration(
  env: Cloudflare.Env,
  loaded: LoadedExploration,
  context: {
    proposals: Array<Proposal>
    summary: string | null
    turns: number
    modelId: string | null
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
      stuckReason: null,
      finishedAt: new Date(),
    })
    .where(eq(generationJob.id, loaded.jobId))

  await announceChatPlan(loaded, created, summary)

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

/**
 * Puts the plan in the conversation.
 *
 * The exploration was almost certainly started from the chat, and it finishes
 * minutes later when that turn is long over — so the workflow speaks into the
 * project's chat itself rather than the assistant somehow being made to wait.
 * The `ProjectChat` object persists it and, if nothing else is happening in
 * there, broadcasts it to whoever is watching.
 *
 * Best effort: a plan that reached the database but not the transcript is a
 * cosmetic loss — the intents are on the Intents tab, and the exploration card
 * in the chat re-reads the history when it sees the job finish.
 */
async function announceChatPlan(
  loaded: LoadedExploration,
  created: Array<{ id: string; title: string; description: string }>,
  summary: string | null,
): Promise<void> {
  const count = created.length

  const parts: Array<ChatPart> = [
    {
      type: 'text',
      text: summary
        ? `${summary}\n\nHere is what I would test — review it and generate the ones you want.`
        : `I have been round ${loaded.projectName} and here is what I would test. Review it and generate the ones you want.`,
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

/**
 * The exploration produced no plan.
 *
 * Never an error — it is nearly always the site being unreachable or a sign-in
 * that could not be completed, both of which the person who asked needs to read
 * rather than be shielded from.
 */
export async function abandonExploration(
  env: Cloudflare.Env,
  loaded: LoadedExploration,
  context: { reason: string; turns: number; modelId: string | null },
): Promise<void> {
  const db = createDb(env.DB)

  await db
    .update(generationJob)
    .set({
      status: 'failed',
      modelId: context.modelId,
      turns: context.turns,
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

/**
 * The safety net. Reached only when a step exhausted its retries, which means
 * nobody is coming back for this job. Guarded on the non-terminal statuses so a
 * late failure cannot rewrite a verdict the job already earned.
 */
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
