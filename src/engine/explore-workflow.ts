/**
 * One app, looked at by a model driving a real browser, turned into a plan.
 *
 * The same ordering as `GenerateWorkflow` — load, open a session, one step per
 * model turn, persist — and the same reason for it: an LLM call is the least
 * reliable and most expensive thing in the engine, so each is checkpointed the
 * moment it returns, and an instance evicted halfway through resumes on the turn
 * after the last one that completed.
 *
 * What is different is what it produces and what that costs. A generation ends
 * in code, which has to be *proved* by executing it — so a generation has a
 * verification step and may not award itself a pass. An exploration ends in an
 * opinion, and an opinion cannot be verified by running it; it is verified by a
 * person reading it, which is exactly what the `'proposed'` status and the plan
 * card exist for. Nothing here goes near a script, and nothing it clicks is
 * kept.
 *
 * The caps are lower than a generation's for the same reason: exploring is
 * unbounded by nature — there is always one more page — so the budget is what
 * decides when to stop, and twenty turns is comfortably more than any app needs
 * to be understood well enough to have an opinion about it.
 */
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
import { loadCredentials } from '#/engine/generation/loop.ts'
import { formatObservation } from '#/engine/generation/prompts.ts'
import { PERSIST_ERROR_STEP_CONFIG, announceRun, releaseRunSession } from '#/engine/run-steps.ts'
import { startGenerationSession } from '#/engine/runner/loader.ts'

export interface ExploreWorkflowParams {
  jobId: string
  projectId: string
  environmentId: string
  /** Taken from the session at enqueue time; never from anything a row says. */
  organizationId: string
  /** Who asked. Proposed intents are still attributed to a person. */
  userId: string
  /** What they asked it to concentrate on, when they said. */
  focus?: string | null
}

/** The turn ceiling. Exploring has no natural end; this is the end. */
const MAX_TURNS = 20

/** A model call is worth one retry — a provider blip should not lose a job. */
const TURN_STEP_CONFIG = {
  retries: { limit: 1, delay: '5 seconds' },
  timeout: '10 minutes',
} as const

/** Taking a browser session is the one step a `429` makes worth repeating. */
const SESSION_STEP_CONFIG = {
  retries: { limit: 2, delay: '10 seconds' },
  timeout: '5 minutes',
} as const

export class ExploreWorkflow extends WorkflowEntrypoint<Cloudflare.Env, ExploreWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<ExploreWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ jobId: string; status: GenerationJobStatus; proposed: number }> {
    const { jobId, organizationId, focus } = event.payload

    /**
     * The browser session. Hoisted so the failure path can hand it back too, and
     * only ever assigned from a step's return value — so a resumed instance
     * recomputes exactly the session the first pass used.
     */
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

      // Accumulated in the workflow's own memory across steps. Every value here
      // came out of a step return, so a resumed instance rebuilds it exactly.
      const transcript: Array<string> = []
      const proposals: Array<Proposal> = []
      let stepIndexOffset = 0
      let docsRead = 0
      let refusedThinPlan = false
      let modelId: string | null = null
      let summary: string | null = null
      let fatal: string | null = null
      let turns = 0

      for (let turn = 0; turn < MAX_TURNS; turn += 1) {
        const result = await step.do(`turn-${turn}`, TURN_STEP_CONFIG, () =>
          runExploreTurn(this.env, {
            jobId,
            environmentId: loaded.environmentId,
            projectModelId: loaded.projectModelId,
            baseUrl: loaded.baseUrl,
            sessionId: sessionId!,
            messages: [
              { role: 'user', content: opening.prompt },
              ...transcript.flatMap((json) => JSON.parse(json) as Array<ModelMessage>),
            ],
            // Everything already spoken for: what the project has, plus
            // anything an earlier turn's rejected attempt got as far as
            // recording.
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
          abandonExploration(this.env, loaded, { reason, turns, modelId }),
        )
        return { jobId, status: 'failed', proposed: 0 }
      }

      const persisted = await step.do('persist', () =>
        persistExploration(this.env, loaded, { proposals, summary, turns, modelId }),
      )

      return { jobId, status: 'succeeded', proposed: persisted.intentIds.length }
    } catch (error) {
      // A session left running holds one of the account's very few concurrent
      // slots until its keep-alive lapses, whatever went wrong above.
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

  /**
   * Opens the browser and writes the opening message.
   *
   * The two belong in one step because the prompt ends with what the model can
   * see: it is handed the page it is actually standing on rather than being told
   * to go and find out, which saves a turn on every job.
   *
   * The credentials are decrypted here and go no further than the isolate — the
   * opening snapshot is the first thing the model reads, so it is also the first
   * thing that has to be scrubbed, and the scrubber is built from the values.
   * Only the redacted prompt is returned.
   */
  private async openSession(
    loaded: LoadedExploration,
  ): Promise<{ sessionId: string | null; prompt: string; errorMessage: string | null }> {
    const started = await startGenerationSession({
      loader: this.env.LOADER,
      browser: this.env.BROWSER,
      baseUrl: loaded.baseUrl,
      creds: await loadCredentials(this.env, loaded.environmentId),
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

    return { sessionId: started.sessionId, prompt, errorMessage: started.errorMessage }
  }
}
