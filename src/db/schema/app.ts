import { relations, sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

import type { RunResult } from '#/engine/contract.ts'
import type { ChatMessageStatus, ChatPart, ChatRole } from '#/engine/chat/contract.ts'
import type { Provider } from '#/lib/models.ts'
import { organization, user } from './auth.ts'

const now = sql`(cast(unixepoch('subsecond') * 1000 as integer))`

export const INTENT_STATUSES = [
  'proposed',
  'draft',
  'generating',
  'ready',
  'passing',
  'failing',
] as const
export type IntentStatus = (typeof INTENT_STATUSES)[number]

export const UNADOPTED_INTENT_STATUSES = ['proposed'] as const

export const GENERATION_JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const
export type GenerationJobStatus = (typeof GENERATION_JOB_STATUSES)[number]

export const GENERATION_JOB_KINDS = ['generate', 'explore', 'batch', 'repair'] as const
export type GenerationJobKind = (typeof GENERATION_JOB_KINDS)[number]

/** `healed` is reserved for the repair loop and is not written by anything yet. */
export const RUN_STATUSES = ['queued', 'running', 'passed', 'healed', 'failed', 'error'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const RUN_TRIGGERS = ['manual', 'regenerate', 'schedule', 'webhook', 'repair'] as const
export const RUN_PURPOSES = [
  'regression',
  'draft-check',
  'generation-verification',
  'repair-verification',
] as const
export type RunPurpose = (typeof RUN_PURPOSES)[number]

export type RunTrigger = (typeof RUN_TRIGGERS)[number]

export const SUITE_RUN_STATUSES = ['queued', 'running', 'passed', 'failed', 'error'] as const
export type SuiteRunStatus = (typeof SUITE_RUN_STATUSES)[number]

export const SUITE_TRIGGERS = ['manual', 'schedule', 'webhook'] as const
export type SuiteTrigger = (typeof SUITE_TRIGGERS)[number]

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

export const SCRIPT_AUTHORS = ['user', 'agent'] as const
export type ScriptAuthor = (typeof SCRIPT_AUTHORS)[number]

/**
 * What to do when a ready test fails a regression run. `off` leaves it failing,
 * `draft` has the agent propose a repaired version for a person to accept, `auto`
 * adopts a repair that verifies and marks the run `healed`. Tests and projects can
 * also say `inherit`, so the organization's setting is the default for everything.
 */
export const HEAL_POLICIES = ['off', 'draft', 'auto'] as const
export type HealPolicy = (typeof HEAL_POLICIES)[number]
export const HEAL_POLICY_CHOICES = ['inherit', ...HEAL_POLICIES] as const
export type HealPolicyChoice = (typeof HEAL_POLICY_CHOICES)[number]

/** Recorded on the failing run's attempt once a repair has verified. */
export interface HealApplied {
  jobId: string
  versionId: string
  version: number
  /** The statement that failed, and what the run said about it. */
  whatFailed: string
  /** Whether the repaired version was adopted as the current one. */
  adopted: boolean
  policy: HealPolicy | 'manual'
}

export interface ArtifactKeys {
  screenshot?: string
  trace?: string
  logs?: string
  video?: string
}

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
    context: text('context'),
    modelId: text('model_id'),
    healPolicy: text('heal_policy').$type<HealPolicyChoice>().default('inherit').notNull(),
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

export const intent = sqliteTable(
  'intent',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull(),
    status: text('status').$type<IntentStatus>().default('draft').notNull(),
    readiness: text('readiness').$type<'draft' | 'ready'>().default('draft').notNull(),
    currentVersionId: text('current_version_id'),
    schedule: text('schedule'),
    lastRunId: text('last_run_id'),
    healPolicy: text('heal_policy').$type<HealPolicyChoice>().default('inherit').notNull(),
    /** A repaired version that verified and is waiting for a person to accept it. */
    pendingRepairVersionId: text('pending_repair_version_id'),
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

export const scriptVersion = sqliteTable(
  'script_version',
  {
    id: text('id').primaryKey(),
    intentId: text('intent_id')
      .notNull()
      .references(() => intent.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    code: text('code').notNull(),
    author: text('author').$type<ScriptAuthor>().default('user').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
  },
  (table) => [
    uniqueIndex('script_version_intent_version_uidx').on(table.intentId, table.version),
    index('script_version_intentId_idx').on(table.intentId),
  ],
)

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
    totalCount: integer('total_count').default(0).notNull(),
    passedCount: integer('passed_count').default(0).notNull(),
    failedCount: integer('failed_count').default(0).notNull(),
    errorCount: integer('error_count').default(0).notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    webhookApiKeyId: text('webhook_api_key_id'),
    webhookApiKeyName: text('webhook_api_key_name'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).default(now).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (table) => [index('suite_run_projectId_idx').on(table.projectId)],
)

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
    scriptVersionId: text('script_version_id')
      .notNull()
      .references(() => scriptVersion.id, { onDelete: 'cascade' }),
    suiteRunId: text('suite_run_id').references(() => suiteRun.id, { onDelete: 'set null' }),
    status: text('status').$type<RunStatus>().default('queued').notNull(),
    trigger: text('trigger').$type<RunTrigger>().default('manual').notNull(),
    purpose: text('purpose').$type<RunPurpose>().default('regression').notNull(),
    environmentName: text('environment_name'),
    baseUrl: text('base_url'),
    errorMessage: text('error_message'),
    modelId: text('model_id'),
    workflowInstanceId: text('workflow_instance_id'),
    artifactPrefix: text('artifact_prefix'),
    webhookApiKeyId: text('webhook_api_key_id'),
    webhookApiKeyName: text('webhook_api_key_name'),
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

export const apiExecutionRequest = sqliteTable(
  'api_execution_request',
  {
    id: text('id').primaryKey(),
    apiKeyId: text('api_key_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    executionKind: text('execution_kind').$type<'run' | 'suite'>().notNull(),
    executionId: text('execution_id').notNull(),
    dispatchState: text('dispatch_state')
      .$type<'pending' | 'accepted' | 'failed'>()
      .default('pending')
      .notNull(),
    lastError: text('last_error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('api_execution_request_key_idempotency_uidx').on(
      table.apiKeyId,
      table.idempotencyKey,
    ),
    index('api_execution_request_expiresAt_idx').on(table.expiresAt),
  ],
)

export const attempt = sqliteTable(
  'attempt',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    outcome: text('outcome').$type<AttemptOutcome>().notNull(),
    diagnosis: text('diagnosis').$type<FailureDiagnosis>(),
    scriptVersionId: text('script_version_id')
      .notNull()
      .references(() => scriptVersion.id, { onDelete: 'cascade' }),
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

export const generationJob = sqliteTable(
  'generation_job',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<GenerationJobKind>().default('generate').notNull(),
    intentId: text('intent_id').references(() => intent.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.id, { onDelete: 'cascade' }),
    /** Snapshot the session’s organization at enqueue time; do not infer it from a mutable project later. */
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    status: text('status').$type<GenerationJobStatus>().default('queued').notNull(),
    modelId: text('model_id'),
    scriptVersionId: text('script_version_id'),
    runId: text('run_id'),
    /** For a repair: the failed run it set out to fix. */
    sourceRunId: text('source_run_id'),
    turns: integer('turns').default(0).notNull(),
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
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
    index('generation_job_organizationId_idx').on(table.organizationId),
  ],
)

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
    modelId: text('model_id'),
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
  },
  (table) => [index('chat_message_project_created_idx').on(table.projectId, table.createdAt)],
)

/**
 * A row with `organizationId` null is the instance's key. An organization's own row
 * wins over both the instance row and the Worker secret for that provider.
 */
export const providerKey = sqliteTable(
  'provider_key',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
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
  (table) => [
    uniqueIndex('provider_key_org_provider_uidx').on(table.organizationId, table.provider),
    uniqueIndex('provider_key_instance_provider_uidx')
      .on(table.provider)
      .where(sql`organization_id is null`),
    index('provider_key_organizationId_idx').on(table.organizationId),
  ],
)

export const allowedModel = sqliteTable(
  'allowed_model',
  {
    id: text('id').primaryKey(),
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

export const PROJECT_FILE_KINDS = ['text', 'pdf', 'image', 'other'] as const
export type ProjectFileKind = (typeof PROJECT_FILE_KINDS)[number]

/**
 * Something a person handed the agents about the app: a README, an API spec, a PDF of
 * the manual, a screenshot of the flow. Text-like files are extracted into
 * `extractedText` for prompts; images are shown to models that can see.
 */
export const projectFile = sqliteTable(
  'project_file',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').$type<ProjectFileKind>().notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    /** R2 object key under files/{organizationId}/{projectId}/. */
    key: text('key').notNull(),
    extractedText: text('extracted_text'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
  },
  (table) => [index('project_file_projectId_idx').on(table.projectId)],
)

export const NOTIFICATION_KINDS = ['webhook', 'slack', 'discord', 'email'] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

/** Where a project's results are sent. `events` holds NotificationEventType names. */
export const notificationDestination = sqliteTable(
  'notification_destination',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<NotificationKind>().notNull(),
    name: text('name').notNull(),
    /** A URL, or an email address for `email`. */
    target: text('target').notNull(),
    /** Webhook signing secret, encrypted like every other secret. Null for other kinds. */
    encryptedSecret: text('encrypted_secret'),
    events: text('events', { mode: 'json' }).$type<Array<string>>().notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).default(true).notNull(),
    /** The origin the dashboard was reached at when this was created; links point here. */
    dashboardOrigin: text('dashboard_origin').notNull(),
    lastDeliveryAt: integer('last_delivery_at', { mode: 'timestamp_ms' }),
    lastDeliveryStatus: text('last_delivery_status').$type<'delivered' | 'failed'>(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(now)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('notification_destination_projectId_idx').on(table.projectId)],
)

export const notificationDelivery = sqliteTable(
  'notification_delivery',
  {
    id: text('id').primaryKey(),
    destinationId: text('destination_id')
      .notNull()
      .references(() => notificationDestination.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    /** The run, suite or job the event was about. */
    subjectId: text('subject_id').notNull(),
    status: text('status').$type<'delivered' | 'failed'>().notNull(),
    responseStatus: integer('response_status'),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
  },
  (table) => [
    index('notification_delivery_destination_created_idx').on(table.destinationId, table.createdAt),
  ],
)

export const organizationSettings = sqliteTable('organization_settings', {
  organizationId: text('organization_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  healPolicy: text('heal_policy').$type<HealPolicy>().default('off').notNull(),
  updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(now)
    .$onUpdate(() => new Date())
    .notNull(),
})

export const instanceSettings = sqliteTable('instance_settings', {
  id: text('id').primaryKey().default('default'),
  defaultModelId: text('default_model_id'),
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
