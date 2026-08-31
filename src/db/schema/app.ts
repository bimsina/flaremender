import { relations, sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

import type { RunResult } from '#/engine/contract.ts'
import type { ChatMessageStatus, ChatPart, ChatRole } from '#/engine/chat/contract.ts'
import type { Provider } from '#/lib/models.ts'
import { organization, user } from './auth.ts'

const now = sql`(cast(unixepoch('subsecond') * 1000 as integer))`

/**
 * Lifecycle of an intent, in the order one moves through it.
 *
 * `'proposed'` comes first and is the only status that means *nobody has agreed
 * to this yet*: it is what the explorer writes when it has been round the site
 * and has an opinion about what ought to be tested. A proposed intent is a real
 * row — it can be read, edited and deleted like any other — but it is not part
 * of the suite: it is excluded from "run all", from the scheduler, and from the
 * counts that answer "how many tests does this project have". Approving it flips
 * it to `'draft'`, at which point it is waiting for a reviewed script.
 *
 * Every hand-written version starts as a draft and requires explicit readiness;
 * `'generating'` is the transient state an intent sits in while a
 * `GenerateWorkflow` is driving a browser on its behalf, and is always replaced
 * by whatever the verification run decided.
 */
export const INTENT_STATUSES = [
  'proposed',
  'draft',
  'generating',
  'ready',
  'passing',
  'failing',
] as const
export type IntentStatus = (typeof INTENT_STATUSES)[number]

/**
 * Statuses that are not yet a test anyone asked for. Everything that treats a
 * project as a suite — "run all", the scheduler, the dashboard's counts — reads
 * this rather than spelling out the exclusion, so a future status of the same
 * kind only has to be added here.
 */
export const UNADOPTED_INTENT_STATUSES = ['proposed'] as const

/**
 * How a generation job ended. Deliberately coarser than a run's statuses: a job
 * either produced a script that verified green, or it did not, and the reason it
 * did not is prose rather than an enum.
 */
export const GENERATION_JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const
export type GenerationJobStatus = (typeof GENERATION_JOB_STATUSES)[number]

/**
 * What a job on the `generation_job` table is actually doing.
 *
 * Three kinds of work, one table, because all three are the same *object*: a
 * long-running agent job, owned by an organization, streaming through a
 * `RunChannel` named after its id, that a socket has to be authorized against
 * before anyone may watch it. Splitting them into three tables would have
 * duplicated that row three times and forced `src/server.ts` to ask three
 * questions where it asks one.
 *
 * - `'generate'` — one intent's script. Has an `intentId`, and ends in a
 *   verified version and a run.
 * - `'explore'` — a browse of the site that ends in proposed intents. Has no
 *   `intentId`: it is about the project, not about one test.
 * - `'batch'` — the umbrella over the `'generate'` jobs an approved plan
 *   started. Also has no `intentId`, and owns no browser of its own.
 */
export const GENERATION_JOB_KINDS = ['generate', 'explore', 'batch'] as const
export type GenerationJobKind = (typeof GENERATION_JOB_KINDS)[number]

/** `'healed'` is deliberately not collapsed into `'passed'` — it reads differently. */
export const RUN_STATUSES = ['queued', 'running', 'passed', 'healed', 'failed', 'error'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** What kicked a run off, so the timeline can explain itself. */
export const RUN_TRIGGERS = ['manual', 'regenerate', 'schedule'] as const
export const RUN_PURPOSES = ['regression', 'draft-check', 'generation-verification'] as const
export type RunPurpose = (typeof RUN_PURPOSES)[number]

export type RunTrigger = (typeof RUN_TRIGGERS)[number]

/**
 * A suite's verdict, aggregated from its members. `'error'` outranks
 * `'failed'`: a suite that could not finish saying anything about one of its
 * intents is a worse state than one that ran everything and found a bug.
 * `'healed'` is deliberately absent — a suite is not the thing that gets
 * repaired, its members are.
 */
export const SUITE_RUN_STATUSES = ['queued', 'running', 'passed', 'failed', 'error'] as const
export type SuiteRunStatus = (typeof SUITE_RUN_STATUSES)[number]

/**
 * A suite is only ever started by a person or by the clock. `'regenerate'` has
 * no meaning here: regenerating is a single intent's business.
 */
export const SUITE_TRIGGERS = ['manual', 'schedule'] as const
export type SuiteTrigger = (typeof SUITE_TRIGGERS)[number]

/** A single execution inside a run; the healing loop adds attempts to one run. */
export const ATTEMPT_OUTCOMES = ['passed', 'failed', 'error'] as const
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number]

export const FAILURE_DIAGNOSES = [
  'broken-locator',
  'timing',
  'test-data',
  'runtime',
  'rendering',
] as const
export type FailureDiagnosis = (typeof FAILURE_DIAGNOSES)[number]

/** Who wrote a script version — a human editing it, or the generator. */
export const SCRIPT_AUTHORS = ['user', 'agent'] as const
export type ScriptAuthor = (typeof SCRIPT_AUTHORS)[number]

/** What a healing attempt tried, so the UI can explain the repair. */
export interface HealApplied {
  whatFailed: string
  proposed: string
  matched: boolean
  asserts: Array<string>
}

/**
 * R2 object keys written for one attempt, each a full key under the run's
 * `artifactPrefix`. Served only through `/api/artifacts/*`, which re-checks the
 * organization before streaming anything back.
 */
export interface ArtifactKeys {
  /** Page at the moment of failure. Absent when the attempt passed. */
  screenshot?: string
  /** Playwright trace zip, viewable in trace.playwright.dev. */
  trace?: string
  /** Scrubbed step + log transcript, for downloading a run in one piece. */
  logs?: string
  /** Reserved: the Cloudflare fork records no video. */
  video?: string
}

/** Prefix `prj_`. */
export const project = sqliteTable(
  'project',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    /**
     * What the agents know about this app that is not in any one intent: what it
     * is for, how to sign in, what the docs said, what the explorer found when
     * it went and looked. Written by `set_project_context` and appended to by
     * `ExploreWorkflow`; read by the chat's system prompt and by every
     * generation's opening message.
     *
     * Always redacted before it is written — a user pasting "log in with
     * ada@example.com / hunter2" is the *expected* way this column gets its
     * first paragraph, and the value goes to an environment variable while the
     * sentence around it goes here with `***` in the middle. Capped in
     * `server/actions.ts` rather than by the column, because the cap is about
     * what a prompt can afford, not what SQLite can hold.
     */
    context: text('context'),
    /** `"{provider}:{slug}"`; null falls through to the instance default. */
    modelId: text('model_id'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(now)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('project_org_slug_uidx').on(table.organizationId, table.slug),
    index('project_organizationId_idx').on(table.organizationId),
  ],
)

/**
 * Prefix `env_`. Where a run points: a base URL plus its own credentials.
 * Exactly one row per project carries `isDefault`; D1 has no interactive
 * transactions, so that invariant is kept by a `db.batch` in the server fn.
 */
export const environment = sqliteTable(
  'environment',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).default(false).notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(now)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('environment_project_name_uidx').on(table.projectId, table.name),
    index('environment_projectId_idx').on(table.projectId),
  ],
)

/**
 * Prefix `evar_`. Values are AES-GCM envelopes (`src/server/crypto.ts`) and
 * never leave the server in plaintext — listings return a mask instead.
 */
export const environmentVariable = sqliteTable(
  'environment_variable',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    encryptedValue: text('encrypted_value').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(now)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('environment_variable_env_name_uidx').on(table.environmentId, table.name),
    index('environment_variable_environmentId_idx').on(table.environmentId),
  ],
)

/**
 * Prefix `int_`. The plain-English description is the permanent source of
 * truth; scripts are derived artefacts kept in `scriptVersion`.
 */
export const intent = sqliteTable(
  'intent',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** Plain English, written by a human. Never overwritten by the generator. */
    description: text('description').notNull(),
    status: text('status').$type<IntentStatus>().default('draft').notNull(),
    readiness: text('readiness').$type<'draft' | 'ready'>().default('draft').notNull(),
    /**
     * Points at the `scriptVersion` that runs today. Deliberately *not* a
     * foreign key: `scriptVersion.intentId` already references this table, and
     * a reciprocal FK would be a cycle SQLite cannot satisfy on insert (the
     * version row and the pointer update cannot both come first). Integrity is
     * kept by the save path, which always inserts the version before pointing
     * at it.
     */
    currentVersionId: text('current_version_id'),
    /**
     * Five-field UTC cron, null when unscheduled. Parsed by `src/lib/cron.ts`,
     * which is also what the every-minute tick matches against.
     */
    schedule: text('schedule'),
    lastRunId: text('last_run_id'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(now)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('intent_projectId_idx').on(table.projectId)],
)

/**
 * Prefix `sv_`. Immutable: every save — by a human or the generator — inserts
 * a new row, and "restore" copies old code forward as the next version.
 */
export const scriptVersion = sqliteTable(
  'script_version',
  {
    id: text('id').primaryKey(),
    intentId: text('intent_id')
      .notNull()
      .references(() => intent.id, { onDelete: 'cascade' }),
    /** 1-based, contiguous per intent. */
    version: integer('version').notNull(),
    code: text('code').notNull(),
    author: text('author').$type<ScriptAuthor>().default('user').notNull(),
    /** For agent versions, the user who triggered generation. */
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Edit summary, e.g. "generated from intent" or "restored version 3". */
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
  },
  (table) => [
    uniqueIndex('script_version_intent_version_uidx').on(table.intentId, table.version),
    index('script_version_intentId_idx').on(table.intentId),
  ],
)

/**
 * Prefix `srun_`. One "run all": every intent in a project that has a script,
 * executed against one environment, one after another.
 *
 * The counts are denormalised on purpose. A suite is watched while it runs, and
 * a poll that has to aggregate its member runs to say "3 of 7" gets slower
 * exactly as the suite gets more interesting; the workflow updates them after
 * each member instead, so progress is one row read.
 */
export const suiteRun = sqliteTable(
  'suite_run',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.id, { onDelete: 'cascade' }),
    status: text('status').$type<SuiteRunStatus>().default('queued').notNull(),
    trigger: text('trigger').$type<SuiteTrigger>().default('manual').notNull(),
    environmentName: text('environment_name'),
    baseUrl: text('base_url'),
    errorMessage: text('error_message'),
    /** Members the suite set out to run; the three below sum to it once done. */
    totalCount: integer('total_count').default(0).notNull(),
    passedCount: integer('passed_count').default(0).notNull(),
    failedCount: integer('failed_count').default(0).notNull(),
    errorCount: integer('error_count').default(0).notNull(),
    /** Null when the clock started it rather than a person. */
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).default(now).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (table) => [index('suite_run_projectId_idx').on(table.projectId)],
)

/** Prefix `run_`. One workflow instance; the attempts inside it are rows below. */
export const run = sqliteTable(
  'run',
  {
    id: text('id').primaryKey(),
    intentId: text('intent_id')
      .notNull()
      .references(() => intent.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    /** The version that ran; attempts snapshot the exact source they used. */
    scriptVersionId: text('script_version_id')
      .notNull()
      .references(() => scriptVersion.id, { onDelete: 'cascade' }),
    /**
     * The suite this run was a member of, null for a run started on its own.
     * `set null` rather than `cascade`: a run is a complete record of one
     * execution and outlives the batch it happened to travel in — deleting a
     * suite must not take its members' history with it.
     */
    suiteRunId: text('suite_run_id').references(() => suiteRun.id, { onDelete: 'set null' }),
    status: text('status').$type<RunStatus>().default('queued').notNull(),
    trigger: text('trigger').$type<RunTrigger>().default('manual').notNull(),
    purpose: text('purpose').$type<RunPurpose>().default('regression').notNull(),
    environmentName: text('environment_name'),
    baseUrl: text('base_url'),
    errorMessage: text('error_message'),
    /** Set only when an agent was involved (generation or healing). */
    modelId: text('model_id'),
    workflowInstanceId: text('workflow_instance_id'),
    /** R2 prefix: `runs/{orgId}/{projectId}/{runId}/`. */
    artifactPrefix: text('artifact_prefix'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).default(now).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('run_intentId_idx').on(table.intentId),
    index('run_projectId_idx').on(table.projectId),
    index('run_environmentId_idx').on(table.environmentId),
    index('run_suiteRunId_idx').on(table.suiteRunId),
  ],
)

/** Prefix `att_`. One execution of one script inside a run. */
export const attempt = sqliteTable(
  'attempt',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    /** 1-based; the healing loop appends attempts to the same run. */
    attemptNumber: integer('attempt_number').notNull(),
    outcome: text('outcome').$type<AttemptOutcome>().notNull(),
    /** Null when the attempt passed. */
    diagnosis: text('diagnosis').$type<FailureDiagnosis>(),
    scriptVersionId: text('script_version_id')
      .notNull()
      .references(() => scriptVersion.id, { onDelete: 'cascade' }),
    /** Snapshot of the exact source executed, so history survives edits. */
    scriptUsed: text('script_used').notNull(),
    healApplied: text('heal_applied', { mode: 'json' }).$type<HealApplied>(),
    artifactKeys: text('artifact_keys', { mode: 'json' }).$type<ArtifactKeys>(),
    result: text('result', { mode: 'json' }).$type<RunResult>(),
    artifactWarnings: text('artifact_warnings', { mode: 'json' }).$type<Array<string>>(),
    logs: text('logs'),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
  },
  (table) => [
    uniqueIndex('attempt_run_number_uidx').on(table.runId, table.attemptNumber),
    index('attempt_runId_idx').on(table.runId),
  ],
)

/**
 * One long-running agent job: `gen_` writes a script, `exp_` explores the site
 * and proposes tests, `bat_` runs a plan's generations one after another.
 *
 * The row exists for three reasons, and the first is the load-bearing one:
 *
 * - **It is what authorizes the live socket.** Generation streams through the
 *   same `RunChannel` a run does, addressed by the job id — and `src/server.ts`
 *   has to be able to answer "does this organization own that channel?" before
 *   forwarding the upgrade. A run row answers that for runs; this answers it for
 *   generations.
 * - It gives the UI something to poll when the socket will not open.
 * - It is the history of what the generator was asked and what became of it,
 *   which outlives the workflow instance that did the asking.
 *
 * `scriptVersionId` and `runId` are plain columns rather than foreign keys: both
 * are written near the end of a job, and the nightly retention sweep deletes run
 * rows out from under old jobs on purpose.
 */
export const generationJob = sqliteTable(
  'generation_job',
  {
    id: text('id').primaryKey(),
    /**
     * Which of the three jobs this is. Defaulted rather than backfilled: every
     * row that predates the column was a script generation, which is exactly
     * what the default says.
     */
    kind: text('kind').$type<GenerationJobKind>().default('generate').notNull(),
    /**
     * Nullable since M9c. A `'generate'` job always has one — it is the whole
     * subject of the job — but an exploration is about the project and a batch
     * is about a list, and pointing either at some arbitrary member would be a
     * lie the UI would then have to unpick.
     */
    intentId: text('intent_id').references(() => intent.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.id, { onDelete: 'cascade' }),
    /**
     * Denormalised from the project on purpose: this is the organization the
     * *session* was in when the job was enqueued, which is the value the
     * workflow re-checks against and the one the socket is authorized on.
     */
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    status: text('status').$type<GenerationJobStatus>().default('queued').notNull(),
    /** `"{provider}:{slug}"` — which model actually wrote the script. */
    modelId: text('model_id'),
    /** The version the job produced, green or partial. Null if it wrote nothing. */
    scriptVersionId: text('script_version_id'),
    /** The verification run, which is a real run and shows up in run history. */
    runId: text('run_id'),
    /** How many model turns it took. Caps live in the workflow. */
    turns: integer('turns').default(0).notNull(),
    /** Why it stopped short, in the words the UI shows. Null when it succeeded. */
    stuckReason: text('stuck_reason'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).default(now).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('generation_job_intentId_idx').on(table.intentId),
    index('generation_job_projectId_idx').on(table.projectId),
  ],
)

/**
 * Prefix `msg_`. One turn of a project's chat, by a person or by the assistant.
 *
 * `parts` is the whole content: a typed array of text fragments and **cards**,
 * where a card is a reference to a row this conversation acted on — see
 * `src/engine/chat/contract.ts`. Prose and references are kept apart because
 * the references are the point: a card renders as a live intent, run or
 * generation, and everything it names can be opened in the ordinary UI.
 *
 * Nothing in here is ever a secret. Every part is passed through the run
 * engine's scrubber, built from the project's environment variable values,
 * before it is written — including the message that carried a credential in,
 * which is rewritten the moment the value reaches an environment.
 */
export const chatMessage = sqliteTable(
  'chat_message',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    role: text('role').$type<ChatRole>().notNull(),
    parts: text('parts', { mode: 'json' }).$type<Array<ChatPart>>().notNull(),
    status: text('status').$type<ChatMessageStatus>().default('complete').notNull(),
    /** Null for the assistant, which speaks for the project rather than a person. */
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
  },
  (table) => [index('chat_message_project_created_idx').on(table.projectId, table.createdAt)],
)

/**
 * Prefix `pk_`. Instance-wide provider credentials, managed from the admin
 * console. Inert whenever a Worker secret exists for the same provider.
 */
export const providerKey = sqliteTable(
  'provider_key',
  {
    id: text('id').primaryKey(),
    provider: text('provider').$type<Provider>().notNull(),
    encryptedKey: text('encrypted_key').notNull(),
    addedBy: text('added_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(now)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex('provider_key_provider_uidx').on(table.provider)],
)

/** Prefix `mdl_`. The admin-curated allowlist is all end users ever pick from. */
export const allowedModel = sqliteTable(
  'allowed_model',
  {
    id: text('id').primaryKey(),
    /** `"{provider}:{slug}"` — see `src/lib/models.ts`. */
    modelId: text('model_id').notNull(),
    provider: text('provider').$type<Provider>().notNull(),
    displayName: text('display_name').notNull(),
    addedBy: text('added_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
  },
  (table) => [
    uniqueIndex('allowed_model_modelId_uidx').on(table.modelId),
    index('allowed_model_provider_idx').on(table.provider),
  ],
)

/** Singleton, id `'default'`. */
export const instanceSettings = sqliteTable('instance_settings', {
  id: text('id').primaryKey().default('default'),
  /** Null means Workers AI, which needs no credentials. */
  defaultModelId: text('default_model_id'),
  /**
   * How many runs the nightly sweep keeps per intent. Null means the engine's
   * own default (`DEFAULT_RETENTION_RUNS`), so an instance that has never been
   * configured is not silently pinned to whatever the number was on the day it
   * was installed.
   */
  retentionRunsPerIntent: integer('retention_runs_per_intent'),
  setupCompletedAt: integer('setup_completed_at', { mode: 'timestamp_ms' }),
  updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(now)
    .$onUpdate(() => new Date())
    .notNull(),
})

export const projectRelations = relations(project, ({ one, many }) => ({
  organization: one(organization, {
    fields: [project.organizationId],
    references: [organization.id],
  }),
  creator: one(user, { fields: [project.createdBy], references: [user.id] }),
  environments: many(environment),
  intents: many(intent),
  runs: many(run),
  suiteRuns: many(suiteRun),
  chatMessages: many(chatMessage),
}))

export const chatMessageRelations = relations(chatMessage, ({ one }) => ({
  project: one(project, { fields: [chatMessage.projectId], references: [project.id] }),
  author: one(user, { fields: [chatMessage.createdBy], references: [user.id] }),
}))

export const environmentRelations = relations(environment, ({ one, many }) => ({
  project: one(project, { fields: [environment.projectId], references: [project.id] }),
  creator: one(user, { fields: [environment.createdBy], references: [user.id] }),
  variables: many(environmentVariable),
  runs: many(run),
  suiteRuns: many(suiteRun),
}))

export const environmentVariableRelations = relations(environmentVariable, ({ one }) => ({
  environment: one(environment, {
    fields: [environmentVariable.environmentId],
    references: [environment.id],
  }),
}))

export const intentRelations = relations(intent, ({ one, many }) => ({
  project: one(project, { fields: [intent.projectId], references: [project.id] }),
  creator: one(user, { fields: [intent.createdBy], references: [user.id] }),
  currentVersion: one(scriptVersion, {
    fields: [intent.currentVersionId],
    references: [scriptVersion.id],
    relationName: 'currentVersion',
  }),
  versions: many(scriptVersion, { relationName: 'versions' }),
  runs: many(run),
  generations: many(generationJob),
}))

export const generationJobRelations = relations(generationJob, ({ one }) => ({
  /** Null for `'explore'` and `'batch'` jobs, which are not about one test. */
  intent: one(intent, { fields: [generationJob.intentId], references: [intent.id] }),
  project: one(project, { fields: [generationJob.projectId], references: [project.id] }),
  environment: one(environment, {
    fields: [generationJob.environmentId],
    references: [environment.id],
  }),
  creator: one(user, { fields: [generationJob.createdBy], references: [user.id] }),
}))

export const scriptVersionRelations = relations(scriptVersion, ({ one, many }) => ({
  intent: one(intent, {
    fields: [scriptVersion.intentId],
    references: [intent.id],
    relationName: 'versions',
  }),
  author: one(user, { fields: [scriptVersion.createdBy], references: [user.id] }),
  runs: many(run),
}))

export const suiteRunRelations = relations(suiteRun, ({ one, many }) => ({
  project: one(project, { fields: [suiteRun.projectId], references: [project.id] }),
  environment: one(environment, {
    fields: [suiteRun.environmentId],
    references: [environment.id],
  }),
  creator: one(user, { fields: [suiteRun.createdBy], references: [user.id] }),
  runs: many(run),
}))

export const runRelations = relations(run, ({ one, many }) => ({
  intent: one(intent, { fields: [run.intentId], references: [intent.id] }),
  suiteRun: one(suiteRun, { fields: [run.suiteRunId], references: [suiteRun.id] }),
  environment: one(environment, { fields: [run.environmentId], references: [environment.id] }),
  project: one(project, { fields: [run.projectId], references: [project.id] }),
  scriptVersion: one(scriptVersion, {
    fields: [run.scriptVersionId],
    references: [scriptVersion.id],
  }),
  attempts: many(attempt),
}))

export const attemptRelations = relations(attempt, ({ one }) => ({
  run: one(run, { fields: [attempt.runId], references: [run.id] }),
  scriptVersion: one(scriptVersion, {
    fields: [attempt.scriptVersionId],
    references: [scriptVersion.id],
  }),
}))

export const providerKeyRelations = relations(providerKey, ({ one }) => ({
  addedBy: one(user, { fields: [providerKey.addedBy], references: [user.id] }),
}))

export const allowedModelRelations = relations(allowedModel, ({ one }) => ({
  addedBy: one(user, { fields: [allowedModel.addedBy], references: [user.id] }),
}))

export const instanceSettingsRelations = relations(instanceSettings, ({ one }) => ({
  updatedBy: one(user, { fields: [instanceSettings.updatedBy], references: [user.id] }),
}))
