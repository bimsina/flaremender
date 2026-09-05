import type { ModelMessage } from 'ai'
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'

import type { GenerationJobStatus } from '#/db/schema/app.ts'
import { loadCredentials, runTurn } from '#/engine/generation/loop.ts'
import { assembleScript, hasAssertions } from '#/engine/generation/script.ts'
import { REPAIR_SYSTEM_PROMPT, buildRepairPrompt } from '#/engine/repair/prompts.ts'
import {
  type LoadedRepair,
  type ReplayResult,
  abandonRepair,
  failRepair,
  loadRepair,
  persistRepair,
  prepareRepairVerification,
  replayScript,
} from '#/engine/repair/steps.ts'
import {
  EXECUTE_STEP_CONFIG,
  PERSIST_ERROR_STEP_CONFIG,
  announceRun,
  executeRun,
  loadRun,
  releaseRunSession,
} from '#/engine/run-steps.ts'
import { startGenerationSession } from '#/engine/runner/loader.ts'

export interface RepairWorkflowParams {
  jobId: string
  intentId: string
  organizationId: string
}

/** A repair is bounded: it replaces one broken step and carries the rest through. */
const MAX_TURNS = 10

const TURN_STEP_CONFIG = {
  retries: { limit: 1, delay: '5 seconds' },
  timeout: '10 minutes',
} as const

const SESSION_STEP_CONFIG = {
  retries: { limit: 2, delay: '10 seconds' },
  timeout: '5 minutes',
} as const

const REPLAY_STEP_CONFIG = {
  retries: { limit: 1, delay: '5 seconds' },
  timeout: '10 minutes',
} as const

function firstLine(text: string): string {
  return text.split('\n')[0]!.slice(0, 300)
}

export class RepairWorkflow extends WorkflowEntrypoint<Cloudflare.Env, RepairWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<RepairWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ jobId: string; status: GenerationJobStatus }> {
    const { jobId, organizationId } = event.payload

    let sessionId: string | null = null

    try {
      const loaded = await step.do('load', () => loadRepair(this.env, { jobId, organizationId }))

      const opening = await step.do('session', SESSION_STEP_CONFIG, () => this.openSession(loaded))
      sessionId = opening.sessionId

      if (!opening.sessionId) {
        await step.do('abandon', () =>
          abandonRepair(this.env, loaded, {
            reason: opening.errorMessage ?? 'A browser session could not be started.',
            turns: 0,
            modelId: null,
          }),
        )
        return { jobId, status: 'failed' }
      }

      const replay = await step.do('replay', REPLAY_STEP_CONFIG, () =>
        replayScript(this.env, loaded, sessionId!),
      )

      if (replay.fatal || !replay.failing) {
        await step.do('end-session', () => releaseRunSession(this.env, sessionId!))
        sessionId = null

        await step.do('abandon', () =>
          abandonRepair(this.env, loaded, {
            reason:
              replay.fatal ??
              `Version ${loaded.sourceVersion} passed when replayed just now, so there was nothing to repair. The failure may have been transient; run the test again.`,
            turns: 0,
            modelId: null,
          }),
        )
        return { jobId, status: 'failed' }
      }

      const prompt = this.buildPrompt(loaded, replay)

      await announceRun(this.env, jobId, {
        type: 'log',
        runId: jobId,
        line: `Statement ${replay.failing.index + 1} failed: ${firstLine(replay.failing.error)}. Asking the agent for a replacement.`,
        at: Date.now(),
      })

      const transcript: Array<string> = []
      const fragments: Array<string> = []
      let failures = { total: 0, consecutive: 0 }
      let refusedFinish = false
      let observedSinceFailure = true
      let stepIndexOffset = replay.stepIndexOffset
      let modelId: string | null = null
      let notes: string | null = null
      let fatal: string | null = null
      let turns = 0
      const usage = { inputTokens: 0, outputTokens: 0 }

      for (let turn = 0; turn < MAX_TURNS; turn += 1) {
        const result = await step.do(`turn-${turn}`, TURN_STEP_CONFIG, () =>
          runTurn(this.env, {
            jobId,
            organizationId,
            environmentId: loaded.environmentId,
            projectModelId: loaded.projectModelId,
            baseUrl: loaded.baseUrl,
            intentTitle: loaded.intentTitle,
            intentDescription: loaded.intentDescription,
            sessionId: sessionId!,
            messages: [
              { role: 'user', content: prompt },
              ...transcript.flatMap((json) => JSON.parse(json) as Array<ModelMessage>),
            ],
            verified: [...replay.prefix, ...fragments],
            stepIndexOffset,
            failures,
            refusedFinish,
            observedSinceFailure,
            systemPrompt: REPAIR_SYSTEM_PROMPT,
          }),
        )

        turns = turn + 1
        transcript.push(result.messagesJson)
        fragments.push(...result.fragments)
        sessionId = result.sessionId
        stepIndexOffset = result.stepIndexOffset
        failures = result.failures
        refusedFinish = result.refusedFinish
        observedSinceFailure = result.observedSinceFailure
        modelId = result.modelId
        notes = result.notes ?? notes
        fatal = result.fatal
        usage.inputTokens += result.usage.inputTokens
        usage.outputTokens += result.usage.outputTokens

        if (result.finished) break

        if (turn === MAX_TURNS - 1) {
          notes = `The repair reached its ${MAX_TURNS}-turn limit before finishing the flow.`
        }
      }

      if (sessionId) {
        await step.do('end-session', () => releaseRunSession(this.env, sessionId!))
        sessionId = null
      }

      if (fragments.length === 0) {
        await step.do('abandon', () =>
          abandonRepair(this.env, loaded, {
            reason:
              fatal ?? notes ?? 'The agent could not find a replacement for the failing step.',
            turns,
            modelId,
            usage,
          }),
        )
        return { jobId, status: 'failed' }
      }

      const code = assembleScript([...replay.prefix, ...fragments])
      const whatFailed = `${replay.failing.statement.replace(/\s+/g, ' ')} — ${firstLine(replay.failing.error)}`

      const unproven = hasAssertions(code)
        ? null
        : 'The repaired script performs the flow but never asserts anything, so it would pass whatever the site did.'
      const stuckReason = fatal ?? unproven ?? (isIncomplete(notes) ? notes : null)

      const prepared = await step.do('prepare-verification', () =>
        prepareRepairVerification(this.env, loaded, {
          code,
          note: `Repaired from v${loaded.sourceVersion}${stuckReason ? ' — partial: ' + firstLine(stuckReason) : ''}: ${firstLine(whatFailed)}`,
          modelId,
        }),
      )

      const loadedRun = await step.do('verify-load', () =>
        loadRun(this.env, prepared.runId, organizationId),
      )

      const executed = await step.do('verify-execute', EXECUTE_STEP_CONFIG, () =>
        executeRun(this.env, prepared.runId, loadedRun),
      )

      const verdict = await step.do('persist', () =>
        persistRepair(this.env, loaded, {
          prepared,
          loadedRun,
          executed,
          modelId,
          turns,
          usage,
          whatFailed,
          stuckReason,
        }),
      )

      return { jobId, status: verdict.outcome === 'passed' ? 'succeeded' : 'failed' }
    } catch (error) {
      if (sessionId) {
        await step.do('release-error', PERSIST_ERROR_STEP_CONFIG, () =>
          releaseRunSession(this.env, sessionId!),
        )
      }

      await step.do('repair-error', PERSIST_ERROR_STEP_CONFIG, () =>
        failRepair(this.env, jobId, error),
      )

      throw error
    }
  }

  private async openSession(
    loaded: LoadedRepair,
  ): Promise<{ sessionId: string | null; errorMessage: string | null }> {
    const started = await startGenerationSession({
      loader: this.env.LOADER,
      browser: this.env.BROWSER,
      baseUrl: loaded.baseUrl,
      creds: await loadCredentials(this.env, loaded.environmentId),
    })

    if (started.sessionId) {
      await announceRun(this.env, loaded.jobId, {
        type: 'log',
        runId: loaded.jobId,
        line: `Browser open on ${loaded.baseUrl}. Repairing "${loaded.intentTitle}" (version ${loaded.sourceVersion}).`,
        at: Date.now(),
      })
    }

    return { sessionId: started.sessionId, errorMessage: started.errorMessage }
  }

  private buildPrompt(loaded: LoadedRepair, replay: ReplayResult): string {
    return buildRepairPrompt({
      intentTitle: loaded.intentTitle,
      intentDescription: loaded.intentDescription,
      projectName: loaded.projectName,
      projectContext: loaded.projectContext,
      environmentName: loaded.environmentName,
      baseUrl: loaded.baseUrl,
      credentialNames: loaded.credentialNames,
      originalCode: loaded.code,
      version: loaded.sourceVersion,
      prefix: replay.prefix,
      failingStatement: replay.failing!.statement,
      failureError: replay.failing!.error,
      originalError: loaded.sourceError,
      remaining: replay.remaining,
      pageAtFailure: replay.pageAtFailure,
    })
  }
}

function isIncomplete(notes: string | null): boolean {
  if (!notes) return false
  return /\b(could not|cannot|unable|blocked|does not exist|no such|limit|gave up|failed|missing|no longer)\b/i.test(
    notes,
  )
}
