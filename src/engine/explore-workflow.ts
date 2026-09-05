import type { ModelMessage } from 'ai'
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'

import type { GenerationJobStatus } from '#/db/schema/app.ts'
import { type Proposal, runExploreTurn } from '#/engine/explore/loop.ts'
import { buildExplorePrompt } from '#/engine/explore/prompts.ts'
import {
  type LoadedExploration,
  abandonExploration,
  failExploration,
  loadExploration,
  persistExploration,
} from '#/engine/explore/steps.ts'
import { resolveModelId } from '#/engine/generation/llm.ts'
import { loadCredentials } from '#/engine/generation/loop.ts'
import { formatObservation } from '#/engine/generation/prompts.ts'
import { formatDocuments, loadProjectKnowledge, modelCanSee } from '#/engine/knowledge.ts'
import { type OpeningContent, asUserContent, openingContent } from '#/engine/opening.ts'
import { createDb } from '#/db/index.ts'
import { PERSIST_ERROR_STEP_CONFIG, announceRun, releaseRunSession } from '#/engine/run-steps.ts'
import { startGenerationSession } from '#/engine/runner/loader.ts'

export interface ExploreWorkflowParams {
  jobId: string
  projectId: string
  environmentId: string
  organizationId: string
  userId: string
  focus?: string | null
  /** Generate every proposal as soon as the plan is ready, instead of waiting for approval. */
  autoGenerate?: boolean
}

const MAX_TURNS = 20

const TURN_STEP_CONFIG = {
  retries: { limit: 1, delay: '5 seconds' },
  timeout: '10 minutes',
} as const

const SESSION_STEP_CONFIG = {
  retries: { limit: 2, delay: '10 seconds' },
  timeout: '5 minutes',
} as const

export class ExploreWorkflow extends WorkflowEntrypoint<Cloudflare.Env, ExploreWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<ExploreWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ jobId: string; status: GenerationJobStatus; proposed: number }> {
    const { jobId, organizationId, focus, autoGenerate } = event.payload

    let sessionId: string | null = null

    try {
      const loaded = await step.do('load', () =>
        loadExploration(this.env, { jobId, organizationId, focus: focus ?? null }),
      )

      const opening = await step.do('session', SESSION_STEP_CONFIG, () => this.openSession(loaded))
      sessionId = opening.sessionId

      if (!opening.sessionId) {
        await step.do('abandon', () =>
          abandonExploration(this.env, loaded, {
            reason: opening.errorMessage ?? 'A browser session could not be started.',
            turns: 0,
            modelId: null,
          }),
        )
        return { jobId, status: 'failed', proposed: 0 }
      }

      const transcript: Array<string> = []
      const proposals: Array<Proposal> = []
      let stepIndexOffset = 0
      let docsRead = 0
      let refusedThinPlan = false
      let modelId: string | null = null
      let summary: string | null = null
      let fatal: string | null = null
      let turns = 0
      const usage = { inputTokens: 0, outputTokens: 0 }

      for (let turn = 0; turn < MAX_TURNS; turn += 1) {
        const result = await step.do(`turn-${turn}`, TURN_STEP_CONFIG, () =>
          runExploreTurn(this.env, {
            jobId,
            organizationId,
            environmentId: loaded.environmentId,
            projectModelId: loaded.projectModelId,
            baseUrl: loaded.baseUrl,
            sessionId: sessionId!,
            messages: [
              { role: 'user', content: asUserContent(opening.content) },
              ...transcript.flatMap((json) => JSON.parse(json) as Array<ModelMessage>),
            ],
            knownTitles: [...loaded.existingTitles, ...proposals.map((proposal) => proposal.title)],
            stepIndexOffset,
            docsRead,
            refusedThinPlan,
          }),
        )

        turns = turn + 1
        transcript.push(result.messagesJson)
        proposals.push(...result.proposals)
        sessionId = result.sessionId
        stepIndexOffset = result.stepIndexOffset
        docsRead = result.docsRead
        refusedThinPlan = result.refusedThinPlan
        modelId = result.modelId
        summary = result.summary ?? summary
        fatal = result.fatal
        usage.inputTokens += result.usage.inputTokens
        usage.outputTokens += result.usage.outputTokens

        if (result.finished) break

        if (turn === MAX_TURNS - 1 && proposals.length === 0) {
          summary = `The explorer reached its ${MAX_TURNS}-turn limit without proposing anything.`
        }
      }

      if (sessionId) {
        await step.do('end-session', () => releaseRunSession(this.env, sessionId!))
        sessionId = null
      }

      if (proposals.length === 0) {
        const reason =
          fatal ??
          summary ??
          'The explorer could not find anything on this site worth proposing a test for.'

        await step.do('abandon', () =>
          abandonExploration(this.env, loaded, { reason, turns, modelId, usage }),
        )
        return { jobId, status: 'failed', proposed: 0 }
      }

      const persisted = await step.do('persist', () =>
        persistExploration(this.env, loaded, {
          proposals,
          summary,
          turns,
          modelId,
          usage,
          autoGenerate: autoGenerate === true,
        }),
      )

      return { jobId, status: 'succeeded', proposed: persisted.intentIds.length }
    } catch (error) {
      if (sessionId) {
        await step.do('release-error', PERSIST_ERROR_STEP_CONFIG, () =>
          releaseRunSession(this.env, sessionId!),
        )
      }

      await step.do('explore-error', PERSIST_ERROR_STEP_CONFIG, () =>
        failExploration(this.env, jobId, error),
      )

      throw error
    }
  }

  private async openSession(loaded: LoadedExploration): Promise<{
    sessionId: string | null
    content: OpeningContent
    errorMessage: string | null
  }> {
    const { modelId } = await resolveModelId(createDb(this.env.DB), loaded.projectModelId)
    const knowledge = await loadProjectKnowledge(this.env, loaded.projectId, {
      images: modelCanSee(modelId),
    })

    const started = await startGenerationSession({
      loader: this.env.LOADER,
      browser: this.env.BROWSER,
      baseUrl: loaded.baseUrl,
      creds: await loadCredentials(this.env, loaded.environmentId),
      channel: this.env.RUN_CHANNEL.getByName(loaded.jobId),
      jobId: loaded.jobId,
    })

    const task = buildExplorePrompt({
      projectName: loaded.projectName,
      projectDescription: loaded.projectDescription,
      environmentName: loaded.environmentName,
      baseUrl: loaded.baseUrl,
      credentialNames: loaded.credentialNames,
      projectContext: loaded.projectContext,
      existingTitles: loaded.existingTitles,
      focus: loaded.focus,
      documents: formatDocuments(knowledge.documents),
    })

    const prompt = started.observation
      ? `${task}\n\n# The page you are on\n\n${formatObservation(started.observation)}`
      : task

    if (started.sessionId) {
      await announceRun(this.env, loaded.jobId, {
        type: 'log',
        runId: loaded.jobId,
        line: `Browser open on ${loaded.baseUrl}. Looking around ${loaded.projectName}…`,
        at: Date.now(),
      })
    }

    return {
      sessionId: started.sessionId,
      content: openingContent(prompt, knowledge.images),
      errorMessage: started.errorMessage,
    }
  }
}
