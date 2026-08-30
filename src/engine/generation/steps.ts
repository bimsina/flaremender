/**
 * What a generation *is*, outside the workflow that orders it.
 *
 * Same split as `run-steps.ts`, and for the same reason: each function here is
 * written to be the body of a Workflow step, so each is re-runnable, returns
 * only what survives a JSON trip, and lets nothing live or secret cross a
 * boundary. Rows are written under deterministic ids and claimed with guarded
 * updates, so a step that commits and then fails on its way out does the same
 * thing the second time.
 *
 * The shape of the job is worth stating once, because the ordering is the part
 * that is easy to get wrong:
 *
 * 1. The intent is claimed (`'generating'`) and the browser is opened.
 * 2. The model builds a script, one verified fragment at a time.
 * 3. The assembled script is executed **fresh** — new session, new context,
 *    tracing on — through the ordinary run path. That run is the verdict, and
 *    it is a real run row: it shows up in the intent's history with artifacts,
 *    and it is what makes the intent `'passing'`. A generation cannot award
 *    itself a pass; only a run can.
 * 4. Whatever happened is recorded on the version, the intent and the job.
 *
 * A job that fails never discards work. The verified prefix is saved as an
 * agent-authored version with a note saying where it got stuck, so the person
 * who asked for it opens the editor onto something half-built rather than onto
 * nothing.
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { NonRetryableError } from 'cloudflare:workflows'

import { createDb } from '#/db/index.ts'
import type { IntentStatus } from '#/db/schema/app.ts'
import { environment, generationJob, intent, project, run, scriptVersion } from '#/db/schema/app.ts'
import type { RunOutcome } from '#/engine/contract.ts'
import { loadCredentialNames } from '#/engine/generation/loop.ts'
import type { ExecutedRun, LoadedRun } from '#/engine/run-steps.ts'
import { announceRun, persistRun } from '#/engine/run-steps.ts'

/** Everything a turn needs about the job, and nothing that could go stale. */
export interface LoadedGeneration {
  jobId: string
  intentId: string
  projectId: string
  environmentId: string
  organizationId: string
  userId: string
  projectName: string
  /**
   * What the project knows about this app that is not in this intent — how one
   * signs in, what the docs said, what the explorer found. Redacted before it
   * was ever written; see `project.context`.
   */
  projectContext: string | null
  /** The project's model choice; null falls through the resolution chain. */
  projectModelId: string | null
  environmentName: string
  baseUrl: string
  intentTitle: string
  intentDescription: string
  /** Names only — a value has no business in a prompt or a workflow step. */
  credentialNames: Array<string>
  /** The script being replaced, when the intent already had one. */
  currentScript: string | null
  previousVersionId: string | null
  /** Restored if the job does not produce something worth pointing at. */
  previousStatus: IntentStatus
}

/** The rows the verification run needs to exist before it can be executed. */
export interface PreparedVerification {
  versionId: string
  version: number
  runId: string
}

/**
 * A generation's rows are named after the job, not randomly.
 *
 * `prepare` is a retryable step that writes two rows and points nothing at them
 * until the verdict is in. Random ids would leave an orphan version and an
 * orphan run behind every time it committed and then failed on its way out.
 */
function derivedId(prefix: string, jobId: string): string {
  return `${prefix}_${jobId.replace(/^gen_/, '')}`
}

/**
 * Resolves the job, claims the intent, and says so.
 *
 * Read back through the organization the caller was in at enqueue time, for the
 * same reason a run is: a job row retargeted between enqueue and execution must
 * resolve to nothing rather than to another tenant's intent.
 */
export async function loadGeneration(
  env: Cloudflare.Env,
  params: { jobId: string; organizationId: string },
): Promise<LoadedGeneration> {
  const db = createDb(env.DB)

  const [row] = await db
    .select({ job: generationJob, intent, project, environment })
    .from(generationJob)
    .innerJoin(intent, eq(intent.id, generationJob.intentId))
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
      `Generation job ${params.jobId} does not exist in this organization.`,
    )
  }

  const currentScript = row.intent.currentVersionId
    ? ((
        await db
          .select({ code: scriptVersion.code })
          .from(scriptVersion)
          .where(eq(scriptVersion.id, row.intent.currentVersionId))
          .limit(1)
      )[0]?.code ?? null)
    : null

  // The status the intent had before it was claimed, so a job that produces
  // nothing can put it back rather than inventing a verdict.
  const previousStatus: IntentStatus =
    row.intent.status === 'generating' ? 'draft' : row.intent.status

  await db.batch([
    db.update(intent).set({ status: 'generating' }).where(eq(intent.id, row.intent.id)),
    db.update(generationJob).set({ status: 'running' }).where(eq(generationJob.id, params.jobId)),
  ])

  await announceRun(env, params.jobId, {
    type: 'run.started',
    runId: params.jobId,
    at: Date.now(),
  })

  return {
    jobId: params.jobId,
    intentId: row.intent.id,
    projectId: row.project.id,
    environmentId: row.environment.id,
    organizationId: params.organizationId,
    userId: row.job.createdBy,
    projectName: row.project.name,
    projectContext: row.project.context,
    projectModelId: row.project.modelId,
    environmentName: row.environment.name,
    baseUrl: row.environment.baseUrl,
    intentTitle: row.intent.title,
    intentDescription: row.intent.description,
    credentialNames: await loadCredentialNames(env, row.environment.id),
    currentScript,
    previousVersionId: row.intent.currentVersionId,
    previousStatus,
  }
}

/**
 * Writes the version and the run the verification will use.
 *
 * The intent is deliberately *not* pointed at the new version here. A script
 * that has not been verified is not this intent's script yet, and a job that
 * dies between here and the verdict must not leave a live intent pointing at
 * code nobody has run.
 */
export async function prepareVerification(
  env: Cloudflare.Env,
  loaded: LoadedGeneration,
  input: { code: string; note: string; modelId: string | null },
): Promise<PreparedVerification> {
  const db = createDb(env.DB)

  const versionId = derivedId('sv', loaded.jobId)
  const runId = derivedId('run', loaded.jobId)

  const [existing] = await db
    .select({ version: scriptVersion.version })
    .from(scriptVersion)
    .where(eq(scriptVersion.id, versionId))
    .limit(1)

  let version = existing?.version ?? 0

  if (!existing) {
    const [last] = await db
      .select({ version: scriptVersion.version })
      .from(scriptVersion)
      .where(eq(scriptVersion.intentId, loaded.intentId))
      .orderBy(desc(scriptVersion.version))
      .limit(1)

    version = (last?.version ?? 0) + 1

    await db
      .insert(scriptVersion)
      .values({
        id: versionId,
        intentId: loaded.intentId,
        version,
        code: input.code,
        author: 'agent',
        // The person who asked for it — an agent version still belongs to
        // somebody, and history reads better than "the system".
        createdBy: loaded.userId,
        note: input.note,
      })
      .onConflictDoNothing()
  }

  await db
    .insert(run)
    .values({
      id: runId,
      intentId: loaded.intentId,
      environmentId: loaded.environmentId,
      projectId: loaded.projectId,
      scriptVersionId: versionId,
      status: 'queued',
      // The trigger that already means "an agent produced this script and it is
      // being proved". Adding a fourth trigger for the same event would split
      // the history without telling anyone anything new.
      trigger: 'regenerate',
      modelId: input.modelId,
      startedAt: new Date(),
    })
    .onConflictDoNothing()

  await announceRun(env, loaded.jobId, {
    type: 'log',
    runId: loaded.jobId,
    line: `Verifying the assembled script in a fresh browser session (${runId}).`,
    at: Date.now(),
  })

  return { versionId, version, runId }
}

/**
 * Records the verdict, everywhere it belongs.
 *
 * The verification run is persisted exactly as any other run — attempt row,
 * artifacts, run status, the intent's badge — and then the *generation's* own
 * policy is applied on top of it, which is the only part that is not just a
 * run:
 *
 * - **Green.** The new version becomes the intent's script. The intent is
 *   `'passing'` because a run said so, not because a generator did.
 * - **Not green, and there was no script before.** The half-built version
 *   becomes current anyway: something to open and fix beats an empty editor,
 *   and `'failing'` is the honest badge for it.
 * - **Not green, and there was a working script.** The old version stays
 *   current and the intent's old status comes back. A failed regeneration must
 *   never cost someone a script that worked.
 */
export async function persistGeneration(
  env: Cloudflare.Env,
  loaded: LoadedGeneration,
  context: {
    prepared: PreparedVerification
    loadedRun: LoadedRun
    executed: ExecutedRun
    modelId: string | null
    turns: number
    /**
     * Why the job stopped short, if it did — the browser gave out, the script
     * asserts nothing, the turn budget ran out, or the model said the flow
     * cannot be performed here. Any of them disqualifies a pass, whatever the
     * verification run then went on to say.
     */
    stuckReason: string | null
  },
): Promise<{ outcome: RunOutcome; versionId: string; runId: string }> {
  const db = createDb(env.DB)
  const outcome = context.executed.result.outcome

  /**
   * A pass takes two independent things, and the run is only one of them.
   *
   * The run proves the script executes. It cannot prove the script is the one
   * that was asked for, and a partial script is very often *more* likely to go
   * green than a complete one: it stops before the hard part, or it asserts
   * something trivially true. The clearest case is a model that finds the
   * feature does not exist and writes `toHaveCount(0)` — perfectly valid code,
   * reliably green, and the exact opposite of the intent.
   *
   * So whatever the job said about stopping short outranks the run.
   */
  const green = outcome === 'passed' && context.stuckReason === null

  await persistRun(env, context.prepared.runId, context.loadedRun, context.executed)

  const keepNewVersion = green || loaded.previousVersionId === null

  await db
    .update(intent)
    .set({
      currentVersionId: keepNewVersion ? context.prepared.versionId : loaded.previousVersionId,
      // `persistRun` has already written a verdict from the run's point of
      // view, and it is overwritten here because the run's verdict is not the
      // whole story:
      //
      // - green, and the new version is current: the run is right.
      // - the run went red: `'failing'`, which is what the run said anyway.
      // - the run went green but the job stopped short: `'draft'`. It is not
      //   failing — the steps it did write all work — but calling it passing
      //   would be a lie, and it is exactly what a draft is: something to go
      //   and finish, with a note saying where it got to.
      // - the old script is being kept: the run said nothing about *it*, so the
      //   intent goes back to what it was.
      status: keepNewVersion
        ? green
          ? 'passing'
          : outcome === 'passed'
            ? 'draft'
            : 'failing'
        : loaded.previousStatus,
    })
    .where(eq(intent.id, loaded.intentId))

  const reason = green
    ? null
    : (context.stuckReason ??
      context.executed.result.errorMessage?.split('\n')[0] ??
      'The generated script did not pass verification.')

  await db
    .update(generationJob)
    .set({
      status: green ? 'succeeded' : 'failed',
      modelId: context.modelId,
      scriptVersionId: context.prepared.versionId,
      runId: context.prepared.runId,
      turns: context.turns,
      stuckReason: reason,
      finishedAt: new Date(),
    })
    .where(eq(generationJob.id, loaded.jobId))

  await announceRun(
    env,
    loaded.jobId,
    {
      type: 'run.finished',
      runId: loaded.jobId,
      outcome,
      errorMessage: reason,
      at: Date.now(),
    },
    { final: true },
  )

  return { outcome, versionId: context.prepared.versionId, runId: context.prepared.runId }
}

/**
 * The job wrote nothing worth verifying.
 *
 * Rare, and always the model's doing rather than the engine's: it decided the
 * flow could not be performed, or every fragment it tried failed. There is no
 * script, so there is no version and no run — just an intent put back where it
 * was and a reason someone can read.
 */
export async function abandonGeneration(
  env: Cloudflare.Env,
  loaded: LoadedGeneration,
  context: { reason: string; turns: number; modelId: string | null },
): Promise<void> {
  const db = createDb(env.DB)

  await db.batch([
    db.update(intent).set({ status: loaded.previousStatus }).where(eq(intent.id, loaded.intentId)),
    db
      .update(generationJob)
      .set({
        status: 'failed',
        modelId: context.modelId,
        turns: context.turns,
        stuckReason: context.reason,
        finishedAt: new Date(),
      })
      .where(eq(generationJob.id, loaded.jobId)),
  ])

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
 * the intent is still claimed and nobody is coming back for it.
 *
 * Guarded on the non-terminal statuses so a late failure cannot rewrite a
 * verdict the job already earned.
 */
export async function failGeneration(
  env: Cloudflare.Env,
  params: { jobId: string; intentId: string },
  error: unknown,
): Promise<void> {
  const db = createDb(env.DB)

  await db
    .update(generationJob)
    .set({
      status: 'failed',
      stuckReason: 'The generation could not be completed.',
      finishedAt: new Date(),
    })
    .where(
      and(eq(generationJob.id, params.jobId), inArray(generationJob.status, ['queued', 'running'])),
    )

  // Only if it is still claimed: a job that got as far as a verdict has already
  // set the status it earned, and this must not undo it. An intent that still
  // has a script is `'ready'` rather than `'draft'` — the failure was the
  // generator's, and the script it already had is untouched and still runnable.
  const [row] = await db
    .select({ currentVersionId: intent.currentVersionId })
    .from(intent)
    .where(eq(intent.id, params.intentId))
    .limit(1)

  await db
    .update(intent)
    .set({ status: row?.currentVersionId ? 'ready' : 'draft' })
    .where(and(eq(intent.id, params.intentId), eq(intent.status, 'generating')))

  console.error(`[generation] ${params.jobId} failed:`, error)

  await announceRun(
    env,
    params.jobId,
    {
      type: 'run.finished',
      runId: params.jobId,
      outcome: 'error',
      errorMessage: 'The generation could not be completed.',
      at: Date.now(),
    },
    { final: true },
  )
}
