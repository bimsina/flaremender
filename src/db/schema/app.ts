import { relations, sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

import { organization, user } from './auth.ts'

const now = sql`(cast(unixepoch('subsecond') * 1000 as integer))`

/** Lifecycle of a single test case, driven by the generate → run → repair loop. */
export const TEST_CASE_STATUSES = ['draft', 'generating', 'ready', 'passing', 'failing'] as const
export type TestCaseStatus = (typeof TEST_CASE_STATUSES)[number]

export const RUN_STATUSES = ['queued', 'running', 'passed', 'failed', 'error'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** What kicked a run off, so the timeline can explain itself. */
export const RUN_TRIGGERS = ['manual', 'regenerate', 'suite'] as const
export type RunTrigger = (typeof RUN_TRIGGERS)[number]

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
    baseUrl: text('base_url').notNull(),
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

export const testCase = sqliteTable(
  'test_case',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** The plain-English description the user writes; the prompt for codegen. */
    prompt: text('prompt').notNull(),
    status: text('status').$type<TestCaseStatus>().default('draft').notNull(),
    /** Latest generated Playwright spec. Null until the first generation. */
    generatedCode: text('generated_code'),
    /** How many times codegen has run for this case, including repairs. */
    generationCount: integer('generation_count').default(0).notNull(),
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
  (table) => [index('test_case_projectId_idx').on(table.projectId)],
)

export const testRun = sqliteTable(
  'test_run',
  {
    id: text('id').primaryKey(),
    testCaseId: text('test_case_id')
      .notNull()
      .references(() => testCase.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    status: text('status').$type<RunStatus>().default('queued').notNull(),
    trigger: text('trigger').$type<RunTrigger>().default('manual').notNull(),
    /** 1-based; increments each time the repair loop re-runs the same case. */
    attempt: integer('attempt').default(1).notNull(),
    code: text('code'),
    logs: text('logs'),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).default(now).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('test_run_testCaseId_idx').on(table.testCaseId),
    index('test_run_projectId_idx').on(table.projectId),
  ],
)

export const projectRelations = relations(project, ({ one, many }) => ({
  organization: one(organization, {
    fields: [project.organizationId],
    references: [organization.id],
  }),
  creator: one(user, { fields: [project.createdBy], references: [user.id] }),
  testCases: many(testCase),
  runs: many(testRun),
}))

export const testCaseRelations = relations(testCase, ({ one, many }) => ({
  project: one(project, { fields: [testCase.projectId], references: [project.id] }),
  creator: one(user, { fields: [testCase.createdBy], references: [user.id] }),
  runs: many(testRun),
}))

export const testRunRelations = relations(testRun, ({ one }) => ({
  testCase: one(testCase, { fields: [testRun.testCaseId], references: [testCase.id] }),
  project: one(project, { fields: [testRun.projectId], references: [project.id] }),
}))
