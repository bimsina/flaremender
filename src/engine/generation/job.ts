import type { ModelMessage } from 'ai'
import type { WorkflowStep } from 'cloudflare:workers'

import type { GenerationJobStatus } from '#/db/schema/app.ts'
import { loadCredentials, runTurn } from '#/engine/generation/loop.ts'
import { buildTaskPrompt, formatObservation } from '#/engine/generation/prompts.ts'
import { resolveModelId } from '#/engine/generation/llm.ts'
import { formatDocuments, loadProjectKnowledge, modelCanSee } from '#/engine/knowledge.ts'
import { createDb } from '#/db/index.ts'
import { type OpeningContent, asUserContent, openingContent } from '#/engine/opening.ts'
import { assembleScript, hasAssertions } from '#/engine/generation/script.ts'
import {
  type LoadedGeneration,
  abandonGeneration,
  failGeneration,
  loadGeneration,
  persistGeneration,
  prepareVerification,
} from '#/engine/generation/steps.ts'
import {
  EXECUTE_STEP_CONFIG,
  PERSIST_ERROR_STEP_CONFIG,
  announceRun,
  executeRun,
  loadRun,
  releaseRunSession,
} from '#/engine/run-steps.ts'
import { startGenerationSession } from '#/engine/runner/loader.ts'

const MAX_TURNS = 24

const TURN_STEP_CONFIG = {
  retries: { limit: 1, delay: '5 seconds' },
  timeout: '10 minutes',
} as const

const SESSION_STEP_CONFIG = {
  retries: { limit: 2, delay: '10 seconds' },
  timeout: '5 minutes',
} as const

export interface GenerationJobParams {
  jobId: string
  intentId: string
  organizationId: string
  label?: string
}

export interface GenerationJobResult {
  jobId: string
  status: GenerationJobStatus
}

export async function runGenerationJob(
  env: Cloudflare.Env,
  step: WorkflowStep,
  params: GenerationJobParams,
): Promise<GenerationJobResult> {
  const { jobId, intentId, organizationId } = params
  const at = (name: string) => `${params.label ?? ''}${name}`

  let sessionId: string | null = null

  try {
    const loaded = await step.do(at('load'), () => loadGeneration(env, { jobId, organizationId }))

    const opening = await step.do(at('session'), SESSION_STEP_CONFIG, () =>
      openSession(env, loaded),
    )
    sessionId = opening.sessionId

    if (!opening.sessionId) {
      await step.do(at('abandon'), () =>
        abandonGeneration(env, loaded, {
          reason: opening.errorMessage ?? 'A browser session could not be started.',
          turns: 0,
          modelId: null,
        }),
      )
      return { jobId, status: 'failed' }
    }

    const transcript: Array<string> = []
    const fragments: Array<string> = []
    let failures = { total: 0, consecutive: 0 }
    let refusedFinish = false
    let observedSinceFailure = true
    let stepIndexOffset = 0
    let modelId: string | null = null
    let notes: string | null = null
    let fatal: string | null = null
    let turns = 0
    const usage = { inputTokens: 0, outputTokens: 0 }

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const result = await step.do(at(`turn-${turn}`), TURN_STEP_CONFIG, () =>
        runTurn(env, {
          jobId,
          organizationId,
          environmentId: loaded.environmentId,
          projectModelId: loaded.projectModelId,
          baseUrl: loaded.baseUrl,
          intentTitle: loaded.intentTitle,
          intentDescription: loaded.intentDescription,
          sessionId: sessionId!,
          messages: [
            { role: 'user', content: asUserContent(opening.content) },
            ...transcript.flatMap((json) => JSON.parse(json) as Array<ModelMessage>),
          ],
          verified: fragments,
          stepIndexOffset,
          failures,
          refusedFinish,
          observedSinceFailure,
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
        notes = `The generator reached its ${MAX_TURNS}-turn limit before finishing the flow.`
      }
    }

    if (sessionId) {
      await step.do(at('end-session'), () => releaseRunSession(env, sessionId!))
      sessionId = null
    }

    if (fragments.length === 0) {
      const reason =
        fatal ?? notes ?? 'The generator could not perform any step of this flow against the site.'

      await step.do(at('abandon'), () =>
        abandonGeneration(env, loaded, { reason, turns, modelId, usage }),
      )
      return { jobId, status: 'failed' }
    }

    const code = assembleScript(fragments)

    const unproven = hasAssertions(code)
      ? null
      : 'The generated script performs the flow but never asserts anything, so it would pass whatever the site did. It has been saved as a draft to finish by hand.'

    const stuckReason = fatal ?? unproven ?? (isIncomplete(notes) ? notes : null)

    const prepared = await step.do(at('prepare-verification'), () =>
      prepareVerification(env, loaded, {
        code,
        note: versionNote(loaded, stuckReason),
        modelId,
      }),
    )

    const loadedRun = await step.do(at('verify-load'), () =>
      loadRun(env, prepared.runId, organizationId),
    )

    const executed = await step.do(at('verify-execute'), EXECUTE_STEP_CONFIG, () =>
      executeRun(env, prepared.runId, loadedRun),
    )

    const verdict = await step.do(at('persist'), () =>
      persistGeneration(env, loaded, {
        prepared,
        loadedRun,
        executed,
        modelId,
        turns,
        usage,
        stuckReason,
      }),
    )

    return { jobId, status: verdict.outcome === 'passed' ? 'succeeded' : 'failed' }
  } catch (error) {
    if (sessionId) {
      await step.do(at('release-error'), PERSIST_ERROR_STEP_CONFIG, () =>
        releaseRunSession(env, sessionId!),
      )
    }

    await step.do(at('generation-error'), PERSIST_ERROR_STEP_CONFIG, () =>
      failGeneration(env, { jobId, intentId }, error),
    )

    throw error
  }
}

async function openSession(
  env: Cloudflare.Env,
  loaded: LoadedGeneration,
): Promise<{
  sessionId: string | null
  content: OpeningContent
  errorMessage: string | null
}> {
  const { modelId } = await resolveModelId(createDb(env.DB), loaded.projectModelId)
  const knowledge = await loadProjectKnowledge(env, loaded.projectId, {
    images: modelCanSee(modelId),
  })

  const started = await startGenerationSession({
    loader: env.LOADER,
    browser: env.BROWSER,
    baseUrl: loaded.baseUrl,
    creds: await loadCredentials(env, loaded.environmentId),
    channel: env.RUN_CHANNEL.getByName(loaded.jobId),
    jobId: loaded.jobId,
  })

  const task = buildTaskPrompt({
    intentTitle: loaded.intentTitle,
    intentDescription: loaded.intentDescription,
    projectName: loaded.projectName,
    projectContext: loaded.projectContext,
    environmentName: loaded.environmentName,
    baseUrl: loaded.baseUrl,
    credentialNames: loaded.credentialNames,
    currentScript: loaded.currentScript,
    documents: formatDocuments(knowledge.documents),
  })

  const prompt = started.observation
    ? `${task}\n\n# The page you are on\n\n${formatObservation(started.observation)}`
    : task

  if (started.sessionId) {
    await announceRun(env, loaded.jobId, {
      type: 'log',
      runId: loaded.jobId,
      line: `Browser open on ${loaded.baseUrl}. Building the test from "${loaded.intentTitle}".`,
      at: Date.now(),
    })
  }

  return {
    sessionId: started.sessionId,
    content: openingContent(prompt, knowledge.images),
    errorMessage: started.errorMessage,
  }
}

function isIncomplete(notes: string | null): boolean {
  if (!notes) return false
  return /\b(could not|cannot|unable|blocked|does not exist|no such|limit|gave up|failed)\b/i.test(
    notes,
  )
}

function versionNote(loaded: LoadedGeneration, stuckReason: string | null): string {
  const origin = loaded.previousVersionId ? 'Regenerated from the test' : 'Generated from the test'

  if (!stuckReason) return origin

  const trimmed = stuckReason.split('\n')[0]!.slice(0, 300)
  return `${origin} — partial: ${trimmed}`
}
