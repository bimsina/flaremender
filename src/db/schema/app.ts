import { relations, sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

import type { Provider } from '#/lib/models.ts'
import { organization, user } from './auth.ts'

const now = sql`(cast(unixepoch('subsecond') * 1000 as integer))`

/**
 * Lifecycle of an intent. `'generating'` returns once AI generation lands; a
 * hand-written script goes straight from `'draft'` to `'ready'` on first save.
 */
export const INTENT_STATUSES = ['draft', 'ready', 'passing', 'failing'] as const
export type IntentStatus = (typeof INTENT_STATUSES)[number]

/** `'healed'` is deliberately not collapsed into `'passed'` — it reads differently. */
export const RUN_STATUSES = ['queued', 'running', 'passed', 'healed', 'failed', 'error'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** What kicked a run off, so the timeline can explain itself. */
export const RUN_TRIGGERS = ['manual', 'regenerate', 'schedule'] as const
export type RunTrigger = (typeof RUN_TRIGGERS)[number]

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

/** R2 object keys written for one attempt. */
export interface ArtifactKeys {
  screenshot?: string
  trace?: string
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
    /**
     * Points at the `scriptVersion` that runs today. Deliberately *not* a
     * foreign key: `scriptVersion.intentId` already references this table, and
     * a reciprocal FK would be a cycle SQLite cannot satisfy on insert (the
     * version row and the pointer update cannot both come first). Integrity is
     * kept by the save path, which always inserts the version before pointing
     * at it.
     */
    currentVersionId: text('current_version_id'),
    /** Five-field cron, null when unscheduled. Column only until cron lands. */
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
    status: text('status').$type<RunStatus>().default('queued').notNull(),
    trigger: text('trigger').$type<RunTrigger>().default('manual').notNull(),
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
}))

export const environmentRelations = relations(environment, ({ one, many }) => ({
  project: one(project, { fields: [environment.projectId], references: [project.id] }),
  creator: one(user, { fields: [environment.createdBy], references: [user.id] }),
  variables: many(environmentVariable),
  runs: many(run),
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

export const runRelations = relations(run, ({ one, many }) => ({
  intent: one(intent, { fields: [run.intentId], references: [intent.id] }),
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
