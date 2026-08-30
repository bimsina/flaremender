/**
 * The tool belt.
 *
 * Every tool here is a thin shell around `server/actions.ts` — the same
 * functions the dialogs and buttons call. That is the whole design rule of the
 * chat: an intent created by typing a sentence is byte-for-byte the row a person
 * would have made with the New intent dialog, made by the same code, with the
 * same guards. Nothing exists only inside a conversation.
 *
 * Three things are true of all of them:
 *
 * - **Scoped to one project, structurally.** The Durable Object was authorized
 *   on a project id before a socket or a turn reached it, and every lookup below
 *   filters on that id. There is no argument a model could produce that reaches
 *   another project, let alone another tenant.
 * - **They announce themselves.** Each call emits a `tool.started` with a
 *   summary *we* wrote and a `tool.finished` carrying the cards it produced.
 *   The model's raw arguments are never streamed and never stored — which is
 *   what makes it safe for one of those arguments to be a password.
 * - **They fail as data.** A validation error comes back to the model as
 *   `{ error }` so it can explain or retry, rather than throwing and killing the
 *   turn.
 */
import { jsonSchema, tool } from 'ai'
import { and, desc, eq, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import {
  attempt,
  environment,
  environmentVariable,
  intent,
  run,
  scriptVersion,
} from '#/db/schema/app.ts'
import type {
  BatchCard,
  ChatCard,
  EnvironmentCard,
  ExploreCard,
  GenerationCard,
  IntentCard,
  RunCard,
} from '#/engine/chat/contract.ts'
import { describeCron } from '#/lib/cron.ts'
import {
  MAX_BATCH_INTENTS,
  MAX_PROJECT_CONTEXT_CHARS,
  assertNoGenerationInFlight,
  assertVariableName,
  createEnvironmentRecord,
  createIntentRecord,
  deleteIntentRecord,
  loadCurrentVersion,
  queueBatchGeneration,
  queueExploration,
  queueGeneration,
  queueIntentRun,
  queueSuiteRun,
  resolveTargetEnvironment,
  setEnvironmentVariableRecord,
  setProjectContextRecord,
  updateEnvironmentRecord,
  updateIntentRecord,
} from '#/server/actions.ts'
import { ValidationError, cron, str, url } from '#/server/validate.ts'

/** How many intents a listing turns into cards before it stops. */
const MAX_INTENT_CARDS = 12

/** How many runs a listing returns to the model. */
const RUN_LIMIT = 10

/** Descriptions are prose; the model does not need all of one to recognise it. */
const DESCRIPTION_PREVIEW = 240

export interface ChatToolContext {
  db: Db
  projectId: string
  /** From the session that opened the turn, never from a row. */
  organizationId: string
  userId: string
}

export interface ToolFinishedInput {
  toolCallId: string
  name: string
  ok: boolean
  detail?: string | null
  cards?: Array<ChatCard>
}

/** How a tool talks to the people watching, and to the redactor. */
export interface ChatToolBus {
  started(toolCallId: string, name: string, summary: string): Promise<void>
  finished(input: ToolFinishedInput): Promise<void>
  /**
   * A credential has just been stored. From here on it is redacted from
   * everything streamed or persisted — including, retroactively, the message
   * that carried it into the conversation.
   */
  liftSecret(value: string): Promise<void>
  /**
   * Runs text through the turn's current redactor.
   *
   * For the one tool whose argument is prose the *user* wrote and that is about
   * to be persisted outside the transcript: a project's context is very often
   * the sentence a credential arrived in, and the sentence is worth keeping
   * once the value in it is `***`.
   */
  redact(text: string): string
}

interface ToolOutcome {
  /** What the model sees. Compact JSON; never a secret, never a whole page. */
  result: unknown
  cards?: Array<ChatCard>
  /** One line for the transcript when the cards do not say it themselves. */
  detail?: string | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function preview(text: string): string {
  return text.length <= DESCRIPTION_PREVIEW ? text : `${text.slice(0, DESCRIPTION_PREVIEW)}…`
}

/** The JSON Schema dialect the AI SDK hands to every provider. */
type ToolSchema = Parameters<typeof jsonSchema>[0]

export function buildChatTools(context: ChatToolContext, bus: ChatToolBus) {
  const { db, projectId } = context

  /**
   * The one place a tool becomes a tool.
   *
   * The wrapper is what guarantees the two invariants the events depend on:
   * a `tool.started` before any work and a `tool.finished` after it, whatever
   * happened — and a summary line written here rather than derived from the
   * arguments, so a password in an argument has nowhere to escape to.
   */
  function define<Input>(config: {
    name: string
    description: string
    schema: ToolSchema
    summary: (input: Input) => string
    run: (input: Input) => Promise<ToolOutcome>
  }) {
    return tool({
      description: config.description,
      inputSchema: jsonSchema<Input>(config.schema),
      async execute(input, options) {
        const toolCallId = options.toolCallId

        // A summary that throws must not take the turn with it — the model gets
        // the complaint back and can fix its arguments.
        let summary: string
        try {
          summary = config.summary(input)
        } catch {
          summary = config.name.replaceAll('_', ' ')
        }

        await bus.started(toolCallId, config.name, summary)

        try {
          const outcome = await config.run(input)
          await bus.finished({
            toolCallId,
            name: config.name,
            ok: true,
            detail: outcome.detail ?? null,
            cards: outcome.cards ?? [],
          })
          return outcome.result
        } catch (error) {
          const message = messageOf(error)
          await bus.finished({ toolCallId, name: config.name, ok: false, detail: message })
          return { error: message }
        }
      },
    })
  }

  /* --------------------------------------------------------------- Loaders */

  /**
   * An intent of *this* project, or a complaint the model can act on.
   *
   * Scoping on `projectId` rather than on the organization is deliberate and
   * stricter: the project was checked when the turn began, and an id from a
   * sibling project is as invisible here as one from another tenant.
   */
  async function requireIntent(intentId: string) {
    const [row] = await db
      .select()
      .from(intent)
      .where(and(eq(intent.id, intentId), eq(intent.projectId, projectId)))
      .limit(1)

    if (!row) throw new ValidationError(`No test with id "${intentId}" in this project.`)
    return row
  }

  async function requireEnvironment(environmentId: string) {
    const [row] = await db
      .select()
      .from(environment)
      .where(and(eq(environment.id, environmentId), eq(environment.projectId, projectId)))
      .limit(1)

    if (!row)
      throw new ValidationError(`No environment with id "${environmentId}" in this project.`)
    return row
  }

  /** Null means "the project's default", which `resolveTargetEnvironment` finds. */
  async function targetEnvironment(environmentId: string | null | undefined, purpose: string) {
    const named = environmentId ? await requireEnvironment(environmentId) : null
    return resolveTargetEnvironment(db, projectId, named, purpose)
  }

  async function intentCard(intentId: string): Promise<IntentCard> {
    const row = await requireIntent(intentId)
    return {
      kind: 'intent',
      intentId: row.id,
      title: row.title,
      status: row.status,
      schedule: row.schedule,
    }
  }

  async function environmentCard(environmentId: string): Promise<EnvironmentCard> {
    const row = await requireEnvironment(environmentId)

    const variables = await db
      .select({ name: environmentVariable.name })
      .from(environmentVariable)
      .where(eq(environmentVariable.environmentId, row.id))
      .orderBy(environmentVariable.name)

    return {
      kind: 'environment',
      environmentId: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      isDefault: row.isDefault,
      variableNames: variables.map((variable) => variable.name),
    }
  }

  /* ----------------------------------------------------------------- Tests */

  const listIntents = define<Record<string, never>>({
    name: 'list_intents',
    description:
      'List every test in this project, with its id, status, whether it has a script, and when it last ran. Cheap — call it whenever you need an id.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    summary: () => 'Reading the tests in this project',
    async run() {
      const rows = await db
        .select({
          id: intent.id,
          title: intent.title,
          description: intent.description,
          status: intent.status,
          schedule: intent.schedule,
          version: scriptVersion.version,
          lastRunStatus: run.status,
          lastRunAt: run.startedAt,
        })
        .from(intent)
        .leftJoin(scriptVersion, eq(scriptVersion.id, intent.currentVersionId))
        .leftJoin(run, eq(run.id, intent.lastRunId))
        .where(eq(intent.projectId, projectId))
        .orderBy(desc(intent.updatedAt))

      return {
        result: {
          count: rows.length,
          intents: rows.map((row) => ({
            intentId: row.id,
            title: row.title,
            description: preview(row.description),
            status: row.status,
            hasScript: row.version !== null,
            schedule: row.schedule,
            lastRun: row.lastRunStatus,
          })),
        },
        cards: rows.slice(0, MAX_INTENT_CARDS).map((row): IntentCard => ({
          kind: 'intent',
          intentId: row.id,
          title: row.title,
          status: row.status,
          schedule: row.schedule,
        })),
        detail: rows.length === 0 ? 'This project has no tests yet.' : null,
      }
    },
  })

  const createIntent = define<{ title: string; description: string }>({
    name: 'create_intent',
    description:
      'Create a test from a plain-English description. The description is the permanent source of truth and must say both what happens and what must be true afterwards. This does not write or run a script — call generate_test next.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short capability, e.g. "Visitor can sign up".' },
        description: {
          type: 'string',
          description:
            'What a person does and what must be true at the end. Quote exact button and field labels. Never include a credential value; refer to variables by name.',
        },
      },
      required: ['title', 'description'],
      additionalProperties: false,
    },
    summary: (input) => `Creating the test “${input.title}”`,
    async run(input) {
      const created = await createIntentRecord(db, {
        projectId,
        title: str(input, 'title', { max: 120 }),
        description: str(input, 'description', { min: 10, max: 4000 }),
        createdBy: context.userId,
      })

      return {
        result: { intentId: created.id, title: created.title, status: created.status },
        cards: [await intentCard(created.id)],
      }
    },
  })

  const updateIntent = define<{
    intentId: string
    title?: string
    description?: string
    schedule?: string | null
  }>({
    name: 'update_intent',
    description:
      "Change a test's title, description or schedule. Only the fields you send are touched. Editing the description does not regenerate the script — call generate_test if the behaviour changed.",
    schema: {
      type: 'object',
      properties: {
        intentId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        schedule: {
          type: ['string', 'null'],
          description: 'Five-field UTC cron, or null to stop scheduling it.',
        },
      },
      required: ['intentId'],
      additionalProperties: false,
    },
    summary: () => 'Updating the test',
    async run(input) {
      const row = await requireIntent(input.intentId)

      await updateIntentRecord(db, {
        intentId: row.id,
        title: input.title === undefined ? undefined : str(input, 'title', { max: 120 }),
        description:
          input.description === undefined
            ? undefined
            : str(input, 'description', { min: 10, max: 4000 }),
        schedule: input.schedule === undefined ? undefined : cron(input, 'schedule'),
      })

      return { result: { ok: true }, cards: [await intentCard(row.id)] }
    },
  })

  const deleteIntent = define<{ intentId: string }>({
    name: 'delete_intent',
    description:
      'Permanently delete a test, its script history and its runs. Destructive and irreversible — say what will be deleted and get the user to agree before calling this.',
    schema: {
      type: 'object',
      properties: { intentId: { type: 'string' } },
      required: ['intentId'],
      additionalProperties: false,
    },
    summary: () => 'Deleting the test',
    async run(input) {
      const row = await requireIntent(input.intentId)
      await deleteIntentRecord(db, row.id)

      return { result: { ok: true, deleted: row.title }, detail: `Deleted “${row.title}”.` }
    },
  })

  const setSchedule = define<{ intentId: string; cron: string | null }>({
    name: 'set_schedule',
    description:
      'Run a test on a clock, or stop doing so. Five-field cron, always UTC. Pass null to clear it.',
    schema: {
      type: 'object',
      properties: {
        intentId: { type: 'string' },
        cron: {
          type: ['string', 'null'],
          description: 'e.g. "0 6 * * *" for 06:00 UTC daily. Null clears the schedule.',
        },
      },
      required: ['intentId', 'cron'],
      additionalProperties: false,
    },
    summary: () => 'Setting the schedule',
    async run(input) {
      const row = await requireIntent(input.intentId)
      const expression = cron(input, 'cron')

      await updateIntentRecord(db, { intentId: row.id, schedule: expression })

      return {
        result: {
          ok: true,
          schedule: expression,
          describes: expression ? `${describeCron(expression)}, UTC` : null,
        },
        cards: [await intentCard(row.id)],
      }
    },
  })

  /* ------------------------------------------------------------ Generation */

  const generateTest = define<{ intentId: string; environmentId?: string | null }>({
    name: 'generate_test',
    description:
      "Start the agent that writes this test's script: it opens a real browser on the environment, performs the flow described by the intent, and saves a version only if a full replay passes. Takes minutes. Returns immediately with a job whose card streams progress — do not wait for it or ask about it again.",
    schema: {
      type: 'object',
      properties: {
        intentId: { type: 'string' },
        environmentId: {
          type: ['string', 'null'],
          description: 'Omit for the project default.',
        },
      },
      required: ['intentId'],
      additionalProperties: false,
    },
    summary: () => 'Starting script generation',
    async run(input) {
      const row = await requireIntent(input.intentId)

      await assertNoGenerationInFlight(db, row.id, row.status)

      if (row.description.trim().length < 10) {
        throw new ValidationError(
          'This test has no usable description. Update it to say what should happen before generating.',
        )
      }

      const target = await targetEnvironment(input.environmentId, 'generate')

      const queued = await queueGeneration(db, {
        intentId: row.id,
        projectId,
        organizationId: context.organizationId,
        environment: target,
        createdBy: context.userId,
      })

      const card: GenerationCard = {
        kind: 'generation',
        jobId: queued.jobId,
        intentId: row.id,
        intentTitle: row.title,
        environmentName: target.name,
      }

      return {
        result: {
          jobId: queued.jobId,
          started: true,
          note: 'Generation is running in the background. The user is watching it live; do not poll.',
        },
        cards: [card],
      }
    },
  })

  /* ------------------------------------------------------- Explore & plans */

  const exploreProject = define<{ focus?: string | null }>({
    name: 'explore_project',
    description:
      'Send an agent round this app in a real browser — signing in if credentials are stored, reading any docs it is pointed at — to work out what the app does and propose the tests worth having. Takes minutes. Returns immediately with a card that streams what it is looking at; when it finishes, a reviewable plan appears in this conversation on its own. Do not wait for it, and do not call it twice.',
    schema: {
      type: 'object',
      properties: {
        focus: {
          type: ['string', 'null'],
          description:
            'What the user asked it to concentrate on, in their words — e.g. "checkout and refunds". Omit if they did not say.',
        },
      },
      additionalProperties: false,
    },
    summary: () => 'Exploring the app',
    async run(input) {
      const target = await targetEnvironment(null, 'explore')

      const queued = await queueExploration(db, {
        projectId,
        organizationId: context.organizationId,
        environment: target,
        createdBy: context.userId,
        focus: input.focus ? str(input, 'focus', { max: 500 }) : null,
      })

      const card: ExploreCard = {
        kind: 'explore',
        jobId: queued.jobId,
        environmentName: target.name,
        focus: input.focus ?? null,
      }

      return {
        result: {
          jobId: queued.jobId,
          started: true,
          note: 'The exploration is running in the background and will post its plan here when it is done. Say so in one sentence and stop — do not poll, and do not describe what it might find.',
        },
        cards: [card],
      }
    },
  })

  const approvePlan = define<{ intentIds: Array<string> }>({
    name: 'approve_plan',
    description:
      'Approve proposed tests and write their scripts. Each one stops being a proposal and becomes a real test, then the agent generates and verifies them one after another. Takes several minutes for a few tests. Returns immediately with a card that reports progress.',
    schema: {
      type: 'object',
      properties: {
        intentIds: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BATCH_INTENTS,
          items: { type: 'string' },
          description: 'The proposed tests to approve, in the order they should be generated.',
        },
      },
      required: ['intentIds'],
      additionalProperties: false,
    },
    summary: (input) =>
      `Approving ${input.intentIds?.length ?? 0} test${input.intentIds?.length === 1 ? '' : 's'}`,
    async run(input) {
      const ids = Array.isArray(input.intentIds) ? input.intentIds : []
      // Resolved one at a time so an id from another project is a complaint the
      // model can act on rather than a silently shorter batch.
      for (const intentId of ids) await requireIntent(intentId)

      const target = await targetEnvironment(null, 'generate')

      const queued = await queueBatchGeneration(db, {
        projectId,
        organizationId: context.organizationId,
        environment: target,
        createdBy: context.userId,
        intentIds: ids,
      })

      const card: BatchCard = {
        kind: 'batch',
        jobId: queued.jobId,
        environmentName: target.name,
        intentIds: queued.intentIds,
      }

      return {
        result: {
          jobId: queued.jobId,
          approved: queued.total,
          note: 'Generating in the background, one test at a time. The user is watching it live; do not poll.',
        },
        cards: [card],
      }
    },
  })

  const setProjectContext = define<{ text: string }>({
    name: 'set_project_context',
    description:
      'Store what you have been told about this app — what it does, how one signs in, what its documentation says, anything a test author would need. Replaces whatever is there. Every future exploration and every generated script starts from it, so keep it factual and short. Never include a credential value; name the variable instead.',
    schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'A short paragraph or a few bullets. Facts about the app, not instructions to yourself.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    summary: () => 'Saving what I know about this app',
    async run(input) {
      // Redacted before it is stored, not after: this is the one argument that
      // leaves the transcript for a durable column every later prompt reads, so
      // a credential that reached it would be read back out for ever.
      const text = bus.redact(str(input, 'text', { min: 10, max: MAX_PROJECT_CONTEXT_CHARS }))

      const stored = await setProjectContextRecord(db, projectId, text)

      return {
        result: { ok: true, characters: stored.length },
        detail: 'Saved what I know about this app.',
      }
    },
  })

  /* ------------------------------------------------------------------ Runs */

  const runTest = define<{ intentId: string; environmentId?: string | null }>({
    name: 'run_test',
    description:
      'Queue a run of one test against an environment. Requires a saved script. Returns immediately; the card reports the outcome.',
    schema: {
      type: 'object',
      properties: {
        intentId: { type: 'string' },
        environmentId: { type: ['string', 'null'], description: 'Omit for the project default.' },
      },
      required: ['intentId'],
      additionalProperties: false,
    },
    summary: () => 'Queueing a run',
    async run(input) {
      const row = await requireIntent(input.intentId)
      const target = await targetEnvironment(input.environmentId, 'run')

      const version = await loadCurrentVersion(db, row.currentVersionId)
      if (!version) {
        throw new ValidationError(
          `“${row.title}” has no script yet. Generate one with generate_test first.`,
        )
      }

      const queued = await queueIntentRun(db, {
        intentId: row.id,
        projectId,
        organizationId: context.organizationId,
        environment: target,
        scriptVersionId: version.id,
      })

      const card: RunCard = {
        kind: 'run',
        runId: queued.runId,
        intentId: row.id,
        intentTitle: row.title,
        environmentName: target.name,
        status: 'queued',
      }

      return { result: { runId: queued.runId, status: 'queued' }, cards: [card] }
    },
  })

  const runAll = define<{ environmentId?: string | null }>({
    name: 'run_all',
    description:
      'Queue every test in the project that has a script, one after another, against one environment. Returns immediately; the card reports progress and the aggregate.',
    schema: {
      type: 'object',
      properties: {
        environmentId: { type: ['string', 'null'], description: 'Omit for the project default.' },
      },
      additionalProperties: false,
    },
    summary: () => 'Queueing a run of every test',
    async run(input) {
      const target = await targetEnvironment(input.environmentId, 'run')

      const queued = await queueSuiteRun(db, {
        projectId,
        organizationId: context.organizationId,
        environment: target,
        createdBy: context.userId,
      })

      return {
        result: { suiteRunId: queued.suiteRunId, total: queued.total, status: 'queued' },
        cards: [
          {
            kind: 'suite',
            suiteRunId: queued.suiteRunId,
            environmentName: target.name,
            status: 'queued',
          },
        ],
      }
    },
  })

  const listRuns = define<{ intentId?: string | null }>({
    name: 'list_runs',
    description:
      'Recent runs, newest first — for the whole project, or for one test. Use it to answer "did that pass" and to find a run id.',
    schema: {
      type: 'object',
      properties: {
        intentId: { type: ['string', 'null'], description: 'Omit for the whole project.' },
      },
      additionalProperties: false,
    },
    summary: () => 'Reading recent runs',
    async run(input) {
      if (input.intentId) await requireIntent(input.intentId)

      const filters = [eq(run.projectId, projectId)]
      if (input.intentId) filters.push(eq(run.intentId, input.intentId))

      const rows = await db
        .select({
          id: run.id,
          status: run.status,
          trigger: run.trigger,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          intentId: run.intentId,
          intentTitle: intent.title,
          environmentName: environment.name,
          durationMs: sql<number | null>`sum(${attempt.durationMs})`,
        })
        .from(run)
        .innerJoin(intent, eq(intent.id, run.intentId))
        .innerJoin(environment, eq(environment.id, run.environmentId))
        .leftJoin(attempt, eq(attempt.runId, run.id))
        .where(and(...filters))
        .groupBy(run.id)
        .orderBy(desc(run.startedAt))
        .limit(RUN_LIMIT)

      return {
        result: {
          count: rows.length,
          runs: rows.map((row) => ({
            runId: row.id,
            intentId: row.intentId,
            test: row.intentTitle,
            status: row.status,
            trigger: row.trigger,
            environment: row.environmentName,
            durationMs: row.durationMs === null ? null : Number(row.durationMs),
            startedAt: row.startedAt.toISOString(),
          })),
        },
        detail: rows.length === 0 ? 'Nothing has run in this project yet.' : null,
      }
    },
  })

  const getRun = define<{ runId: string }>({
    name: 'get_run',
    description:
      'One run in detail: its verdict, how long it took, and the first line of the error if it failed.',
    schema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
    summary: () => 'Reading a run',
    async run(input) {
      const [row] = await db
        .select({
          run,
          intentTitle: intent.title,
          environmentName: environment.name,
        })
        .from(run)
        .innerJoin(intent, eq(intent.id, run.intentId))
        .innerJoin(environment, eq(environment.id, run.environmentId))
        .where(and(eq(run.id, input.runId), eq(run.projectId, projectId)))
        .limit(1)

      if (!row) throw new ValidationError(`No run with id "${input.runId}" in this project.`)

      const attempts = await db
        .select({
          outcome: attempt.outcome,
          errorMessage: attempt.errorMessage,
          durationMs: attempt.durationMs,
        })
        .from(attempt)
        .where(eq(attempt.runId, row.run.id))
        .orderBy(desc(attempt.attemptNumber))
        .limit(1)

      const last = attempts[0] ?? null

      const card: RunCard = {
        kind: 'run',
        runId: row.run.id,
        intentId: row.run.intentId,
        intentTitle: row.intentTitle,
        environmentName: row.environmentName,
        status: row.run.status,
      }

      return {
        result: {
          runId: row.run.id,
          status: row.run.status,
          trigger: row.run.trigger,
          environment: row.environmentName,
          durationMs: last?.durationMs ?? null,
          // One line: the whole Playwright error is a dozen, and the user can
          // open the run to read them.
          error: last?.errorMessage ? last.errorMessage.split('\n')[0] : null,
        },
        cards: [card],
      }
    },
  })

  /* --------------------------------------------------------- Environments */

  const listEnvironments = define<Record<string, never>>({
    name: 'list_environments',
    description:
      "The project's environments: base URL, which is the default, and the names of the credentials stored on each. Values are never returned.",
    schema: { type: 'object', properties: {}, additionalProperties: false },
    summary: () => 'Reading the environments',
    async run() {
      const rows = await db
        .select()
        .from(environment)
        .where(eq(environment.projectId, projectId))
        .orderBy(environment.createdAt)

      const cards = await Promise.all(rows.map((row) => environmentCard(row.id)))

      return {
        result: {
          count: cards.length,
          environments: cards.map((card) => ({
            environmentId: card.environmentId,
            name: card.name,
            baseUrl: card.baseUrl,
            isDefault: card.isDefault,
            variables: card.variableNames,
          })),
        },
        cards,
      }
    },
  })

  const createEnvironment = define<{ name: string; baseUrl: string }>({
    name: 'create_environment',
    description:
      'Add an environment — a name and the base URL its tests run against. The first environment in a project becomes the default.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'e.g. "Staging".' },
        baseUrl: { type: 'string', description: 'e.g. "https://staging.example.com".' },
      },
      required: ['name', 'baseUrl'],
      additionalProperties: false,
    },
    summary: (input) => `Creating the environment “${input.name}”`,
    async run(input) {
      const created = await createEnvironmentRecord(db, {
        projectId,
        name: str(input, 'name', { max: 60 }),
        baseUrl: url(input, 'baseUrl'),
        isDefault: false,
        createdBy: context.userId,
      })

      return { result: { environmentId: created.id }, cards: [await environmentCard(created.id)] }
    },
  })

  const updateEnvironment = define<{ environmentId: string; name?: string; baseUrl?: string }>({
    name: 'update_environment',
    description: 'Rename an environment or point it at a different base URL.',
    schema: {
      type: 'object',
      properties: {
        environmentId: { type: 'string' },
        name: { type: 'string' },
        baseUrl: { type: 'string' },
      },
      required: ['environmentId'],
      additionalProperties: false,
    },
    summary: () => 'Updating the environment',
    async run(input) {
      const row = await requireEnvironment(input.environmentId)

      await updateEnvironmentRecord(db, {
        environmentId: row.id,
        name: input.name === undefined ? undefined : str(input, 'name', { max: 60 }),
        baseUrl: input.baseUrl === undefined ? undefined : url(input, 'baseUrl'),
      })

      return { result: { ok: true }, cards: [await environmentCard(row.id)] }
    },
  })

  /**
   * Credential lifting.
   *
   * This is the one tool whose *argument* is a secret, and it is the reason the
   * wrapper above never streams or stores arguments. The value is encrypted into
   * the environment and then handed to `bus.liftSecret`, which rebuilds the
   * turn's redactor around it and rewrites the message the user typed it into —
   * so within a second of arriving, the value exists nowhere but the encrypted
   * column.
   *
   * The residual risk is real and documented: the value reached the model, so it
   * transited the configured LLM provider exactly once, in the user's own
   * message and in this tool call. Nothing after that point retains it.
   */
  const setEnvironmentVariable = define<{
    name: string
    value: string
    environmentId?: string | null
  }>({
    name: 'set_environment_variable',
    description:
      "Store a credential or other value on an environment, encrypted at rest. Scripts read it with secret('NAME'). Use this the moment a user gives you a password, token or key — then confirm by name only and never repeat the value.",
    schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Shouty snake case, e.g. "ADMIN_PASSWORD".',
        },
        value: { type: 'string', description: 'The value. Never echo this back to the user.' },
        environmentId: { type: ['string', 'null'], description: 'Omit for the project default.' },
      },
      required: ['name', 'value'],
      additionalProperties: false,
    },
    summary: (input) => `Storing ${assertVariableName(str(input, 'name', { max: 64 }))}`,
    async run(input) {
      const target = await targetEnvironment(input.environmentId, 'store credentials')
      const name = assertVariableName(str(input, 'name', { max: 64 }))
      const value = str(input, 'value', { max: 8000 })

      await setEnvironmentVariableRecord(db, { environmentId: target.id, name, value })

      // Before anything else is streamed or stored: from here the value is
      // `***` everywhere, including in the message that carried it.
      await bus.liftSecret(value)

      return {
        result: {
          ok: true,
          name,
          environment: target.name,
          note:
            "Stored encrypted. Refer to it as secret('" + name + "') and never repeat its value.",
        },
        cards: [await environmentCard(target.id)],
      }
    },
  })

  /* -------------------------------------------------------------- Overview */

  const getProjectOverview = define<Record<string, never>>({
    name: 'get_project_overview',
    description:
      'The shape of the project in one call: how many tests there are and what state they are in, plus the last few runs.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    summary: () => 'Reading the project overview',
    async run() {
      const statuses = await db
        .select({ status: intent.status, count: sql<number>`count(*)` })
        .from(intent)
        .where(eq(intent.projectId, projectId))
        .groupBy(intent.status)

      const recent = await db
        .select({
          id: run.id,
          status: run.status,
          intentTitle: intent.title,
          startedAt: run.startedAt,
        })
        .from(run)
        .innerJoin(intent, eq(intent.id, run.intentId))
        .where(eq(run.projectId, projectId))
        .orderBy(desc(run.startedAt))
        .limit(5)

      const byStatus: Record<string, number> = {}
      let total = 0
      for (const row of statuses) {
        const count = Number(row.count ?? 0)
        byStatus[row.status] = count
        total += count
      }

      return {
        result: {
          tests: total,
          byStatus,
          recentRuns: recent.map((row) => ({
            runId: row.id,
            test: row.intentTitle,
            status: row.status,
            startedAt: row.startedAt.toISOString(),
          })),
        },
      }
    },
  })

  return {
    list_intents: listIntents,
    create_intent: createIntent,
    update_intent: updateIntent,
    delete_intent: deleteIntent,
    set_schedule: setSchedule,
    explore_project: exploreProject,
    approve_plan: approvePlan,
    set_project_context: setProjectContext,
    generate_test: generateTest,
    run_test: runTest,
    run_all: runAll,
    list_runs: listRuns,
    get_run: getRun,
    list_environments: listEnvironments,
    create_environment: createEnvironment,
    update_environment: updateEnvironment,
    set_environment_variable: setEnvironmentVariable,
    get_project_overview: getProjectOverview,
  }
}
