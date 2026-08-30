/**
 * One intent, turned into a script by a model driving a real browser.
 *
 * This is the whole of a generation, written as a function over a
 * `WorkflowStep` rather than as a workflow — because there are two callers.
 * `GenerateWorkflow` is one intent, started by a person pressing Generate;
 * `BatchGenerateWorkflow` is a list of them, started by approving a plan. Both
 * have to produce byte-identical work: the same turn loop, the same caps, the
 * same verification run, the same partial-save policy. Two copies would drift,
 * and the copy that drifted would be the one deciding whether a script is
 * allowed to say it passed.
 *
 * Two things about the ordering are load-bearing:
 *
 * - **One step per model turn.** An LLM call is the least reliable and most
 *   expensive thing in the engine, so each is checkpointed the moment it
 *   returns. A workflow instance that is evicted mid-generation resumes on the
 *   turn after the last one that completed, with the transcript, the verified
 *   fragments and the browser session it had — none of which are recomputed,
 *   because none of them could be.
 * - **The verdict comes from a run, not from the loop.** Every fragment has
 *   already executed once, against a page the previous fragment left behind.
 *   That proves each step in isolation and proves nothing about the whole: a
 *   flow assembled from twenty such fragments has never been executed from a
 *   cold browser in one go. So it is — through the ordinary run path, fresh
 *   session, tracing on. Only that run may make an intent `'passing'`.
 *
 * The caps exist because the failure mode of an agent loop is not stopping. A
 * generation is bounded by turns, by tool calls per turn, by fragment size, by
 * consecutive failures and by total failures, and every one of those bounds ends
 * the same way: whatever was verified is saved as a draft with a note saying
 * where it got stuck.
 */
import type { ModelMessage } from 'ai'
import type { WorkflowStep } from 'cloudflare:workers'

import type { GenerationJobStatus } from '#/db/schema/app.ts'
import { loadCredentials, runTurn } from '#/engine/generation/loop.ts'
import { buildTaskPrompt, formatObservation } from '#/engine/generation/prompts.ts'
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

/**
 * The turn ceiling. Generous enough for a sign-in, a multi-screen flow and the
 * assertions at the end of it; short of the point where a model that is not
 * converging would burn a browser session's whole keep-alive.
 */
const MAX_TURNS = 24

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

export interface GenerationJobParams {
  jobId: string
  intentId: string
  /** Taken from the session at enqueue time; never from anything a row says. */
  organizationId: string
  /**
   * Prefixed onto every step name. Empty for a standalone generation, so its
   * steps read `load`, `session`, `turn-0`; `gen-3-` for the fourth member of a
   * batch, whose steps would otherwise collide with its siblings' inside the
   * one workflow instance they all share.
   */
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

  /**
   * The shared browser session. Hoisted so the failure path can hand it back
   * too, and only ever assigned from a step's return value — so a resumed
   * instance recomputes exactly the session the first pass used.
   */
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

    // Accumulated in the workflow's own memory across steps. Every value here
    // came out of a step return, so a resumed instance rebuilds it exactly. The
    // transcript is carried as JSON for the same reason each turn returns it
    // that way: a `ModelMessage` is not a shape the platform's serialisation
    // types can see through.
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

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const result = await step.do(at(`turn-${turn}`), TURN_STEP_CONFIG, () =>
        runTurn(env, {
          jobId,
          environmentId: loaded.environmentId,
          projectModelId: loaded.projectModelId,
          baseUrl: loaded.baseUrl,
          intentTitle: loaded.intentTitle,
          intentDescription: loaded.intentDescription,
          sessionId: sessionId!,
          messages: [
            { role: 'user', content: opening.prompt },
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

      if (result.finished) break

      if (turn === MAX_TURNS - 1) {
        notes = `The generator reached its ${MAX_TURNS}-turn limit before finishing the flow.`
      }
    }

    // The session has done everything it is going to do, and verification
    // deliberately does not reuse it — a script that only passes in a browser
    // that is already signed in has not been verified at all.
    if (sessionId) {
      await step.do(at('end-session'), () => releaseRunSession(env, sessionId!))
      sessionId = null
    }

    if (fragments.length === 0) {
      const reason =
        fatal ?? notes ?? 'The generator could not perform any step of this flow against the site.'

      await step.do(at('abandon'), () => abandonGeneration(env, loaded, { reason, turns, modelId }))
      return { jobId, status: 'failed' }
    }

    const code = assembleScript(fragments)

    /**
     * A script with no assertions cannot be proved by running it, because
     * running it is exactly what it will always survive. Verification still
     * happens — the run and its artifacts are worth having, and the person who
     * opens the editor should see whether the steps work — but the verdict is
     * decided here rather than by the run, and it is not a pass.
     */
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
        stuckReason,
      }),
    )

    return { jobId, status: verdict.outcome === 'passed' ? 'succeeded' : 'failed' }
  } catch (error) {
    // A session left running holds one of the account's very few concurrent
    // slots until its keep-alive lapses, whatever went wrong above.
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

/**
 * Opens the browser and writes the opening message.
 *
 * The two belong in one step because the prompt ends with what the model can
 * see: it is handed the page it is actually standing on rather than being told
 * to go and find out, which saves a turn on every job.
 *
 * The credentials are decrypted here and go no further than the isolate: this
 * opening snapshot is the first thing the model reads, so it is also the first
 * thing that has to be scrubbed, and the scrubber is built from the values. Only
 * the redacted prompt is returned.
 */
async function openSession(
  env: Cloudflare.Env,
  loaded: LoadedGeneration,
): Promise<{ sessionId: string | null; prompt: string; errorMessage: string | null }> {
  const started = await startGenerationSession({
    loader: env.LOADER,
    browser: env.BROWSER,
    baseUrl: loaded.baseUrl,
    creds: await loadCredentials(env, loaded.environmentId),
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

  return { sessionId: started.sessionId, prompt, errorMessage: started.errorMessage }
}

/**
 * Whether the model's parting note describes a finished job or an abandoned
 * one. Deliberately crude: the note is prose, and the only decision riding on it
 * is whether the saved version is labelled as partial. Verification is what
 * actually decides whether the script is any good.
 */
function isIncomplete(notes: string | null): boolean {
  if (!notes) return false
  return /\b(could not|cannot|unable|blocked|does not exist|no such|limit|gave up|failed)\b/i.test(
    notes,
  )
}

function versionNote(loaded: LoadedGeneration, stuckReason: string | null): string {
  const origin = loaded.previousVersionId
    ? 'Regenerated from the intent'
    : 'Generated from the intent'

  if (!stuckReason) return origin

  const trimmed = stuckReason.split('\n')[0]!.slice(0, 300)
  return `${origin} — partial: ${trimmed}`
}
