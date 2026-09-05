/**
 * The MCP server: what an AI assistant sees when a person connects Flaremender to
 * it. Every tool runs as the person who authorized the connection, inside the
 * organization they picked on the consent page, and goes through the same actions
 * the dashboard uses.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { getMcpAuthContext } from 'agents/mcp/server'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { createDb, type Db } from '#/db/index.ts'
import { environment, intent, project, run, scriptVersion } from '#/db/schema/app.ts'
import { env } from 'cloudflare:workers'
import {
  assertNoGenerationInFlight,
  countRunnableIntents,
  createIntentRecord,
  queueExploration,
  queueGeneration,
  queueIntentRun,
  queueRepair,
  queueSuiteRun,
  resolveTargetEnvironment,
} from '#/server/actions.ts'
import { AuthError } from '#/server/auth-error.ts'
import { readJob, readRunReport } from '#/server/reports.server.ts'
import { assertProject, loadEnvironment, loadRun, loadSuiteRun } from '#/server/scope.ts'
import { ValidationError } from '#/server/validate.ts'
import { WebhookApiError, applyRateLimit } from '#/server/webhooks.ts'
import { span } from '#/engine/tracing.ts'

export const MCP_SCOPES = ['read', 'write'] as const
export type McpScope = (typeof MCP_SCOPES)[number]

export const SCOPE_DESCRIPTIONS: Record<McpScope, string> = {
  read: 'See projects, tests, runs and reports',
  write: 'Create tests, start runs, and ask the AI to generate or repair scripts',
}

/** What the consent page stores in the token. Nothing here is secret. */
export interface McpProps extends Record<string, unknown> {
  userId: string
  organizationId: string
  organizationName: string
  scopes: Array<McpScope>
  /** Where this instance lives, so tools can hand back dashboard links. */
  origin: string
}

export const MCP_ROUTE = '/mcp'

class ToolError extends Error {}

function principal(): McpProps {
  const props = getMcpAuthContext()?.props as Partial<McpProps> | undefined
  if (!props?.userId || !props.organizationId || !Array.isArray(props.scopes)) {
    throw new ToolError('This connection is not authorized. Reconnect to Flaremender.')
  }
  return props as McpProps
}

function requireScope(who: McpProps, scope: McpScope) {
  if (!who.scopes.includes(scope)) {
    throw new ToolError(
      `This connection was authorized without the "${scope}" scope. Reconnect and grant it.`,
    )
  }
}

async function limited(who: McpProps, kind: 'read' | 'trigger') {
  await applyRateLimit(`mcp:${who.userId}`, kind)
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

function describe(error: unknown): string {
  if (error instanceof ToolError) return error.message
  if (error instanceof ValidationError) return error.message
  if (error instanceof AuthError) return error.message
  if (error instanceof WebhookApiError) return error.message
  console.error('mcp tool failed', error)
  return 'Flaremender could not complete that. Try again, or check the dashboard.'
}

/** Every tool runs through this so a thrown error becomes an honest tool result. */
function guarded<Input>(
  name: string,
  handler: (input: Input, who: McpProps, db: Db) => Promise<unknown>,
) {
  return (input: Input) =>
    span('mcp.tool', { 'tool.name': name }, async (set) => {
      try {
        const who = principal()
        set({ 'organization.id': who.organizationId, 'user.id': who.userId })
        const result = text(await handler(input, who, createDb(env.DB)))
        set({ ok: true })
        return result
      } catch (error) {
        set({ ok: false })
        return failure(describe(error))
      }
    })
}

function links(who: McpProps) {
  const at = (path: string) => new URL(path, who.origin).toString()
  return {
    project: (projectId: string) => at(`/projects/${encodeURIComponent(projectId)}`),
    test: (projectId: string, testId: string) =>
      at(`/projects/${encodeURIComponent(projectId)}/intents/${encodeURIComponent(testId)}`),
    run: (projectId: string, runId: string) =>
      at(`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`),
  }
}

async function pickEnvironment(
  db: Db,
  who: McpProps,
  projectId: string,
  environmentId: string | undefined,
  purpose: string,
) {
  const named = environmentId
    ? (await loadEnvironment(db, who.organizationId, environmentId)).environment
    : null
  return resolveTargetEnvironment(db, projectId, named, purpose)
}

async function loadTest(db: Db, who: McpProps, testId: string) {
  const [row] = await db
    .select({ test: intent, project })
    .from(intent)
    .innerJoin(project, eq(project.id, intent.projectId))
    .where(and(eq(intent.id, testId), eq(project.organizationId, who.organizationId)))
    .limit(1)
  if (!row) throw new ToolError('Test not found in this organization.')
  return row
}

function runSummary(report: Awaited<ReturnType<typeof readRunReport>>, who: McpProps) {
  const last = report.attempts.at(-1)
  const failed = last?.result?.steps.find((step) => !step.ok)
  return {
    id: report.run.id,
    status: report.run.status,
    trigger: report.run.trigger,
    purpose: report.run.purpose,
    test: report.intent,
    project: report.project,
    environment: { id: report.environment.id, name: report.environment.name },
    baseUrl: report.environment.baseUrl,
    scriptVersion: report.scriptVersion.version,
    startedAt: report.run.startedAt.toISOString(),
    finishedAt: report.run.finishedAt?.toISOString() ?? null,
    errorMessage: report.run.errorMessage ?? last?.errorMessage ?? null,
    attempts: report.attempts.length,
    diagnosis: last?.diagnosis ?? null,
    failedStep: failed ? { label: failed.label, error: failed.error ?? null } : null,
    steps: last?.result?.steps.map((step) => ({
      label: step.label,
      ok: step.ok,
      durationMs: step.durationMs,
    })),
    dashboardUrl: links(who).run(report.project.id, report.run.id),
  }
}

async function jobSummary(db: Db, who: McpProps, jobId: string) {
  const job = await readJob(db, who.organizationId, jobId)
  if (!job) throw new ToolError('Job not found in this organization.')

  const [verification] = job.runId
    ? await db
        .select({ id: run.id, status: run.status, errorMessage: run.errorMessage })
        .from(run)
        .where(eq(run.id, job.runId))
        .limit(1)
    : []

  const [version] = job.scriptVersionId
    ? await db
        .select({ version: scriptVersion.version, code: scriptVersion.code })
        .from(scriptVersion)
        .where(eq(scriptVersion.id, job.scriptVersionId))
        .limit(1)
    : []

  const [test] = job.intentId
    ? await db
        .select({ id: intent.id, title: intent.title, status: intent.status })
        .from(intent)
        .where(eq(intent.id, job.intentId))
        .limit(1)
    : []

  const pending = job.status === 'queued' || job.status === 'running'
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    pending,
    hint: pending
      ? 'Still working. Ask again in twenty seconds or so; generation usually takes one to three minutes.'
      : null,
    stuckReason: job.stuckReason,
    model: job.modelId,
    turns: job.turns,
    tokens: job.inputTokens + job.outputTokens,
    test: test ?? null,
    script: version ? { version: version.version, code: version.code } : null,
    verificationRun: verification ?? null,
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    dashboardUrl: test
      ? links(who).test(job.projectId, test.id)
      : links(who).project(job.projectId),
  }
}

export function createFlaremenderMcpServer() {
  const server = new McpServer(
    { name: 'flaremender', version: '1.0.0' },
    {
      instructions: `Flaremender runs AI-written end-to-end browser tests against a real web app. A project is one app; it has environments (a name and a base URL) and tests. A test is an intent in plain English plus a generated Playwright script; a run replays that script and reports pass or fail with the failing step. Generation, exploration and repair are background jobs: start one, then poll get_job until it is no longer pending. Use dashboardUrl values to point people at the full picture.`,
    },
  )

  server.registerTool(
    'list_projects',
    {
      description:
        'The projects in this organization, with their environments and how many tests each has.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guarded('list_projects', async (_input, who, db) => {
      requireScope(who, 'read')
      await limited(who, 'read')

      const rows = await db
        .select({
          id: project.id,
          name: project.name,
          slug: project.slug,
          description: project.description,
        })
        .from(project)
        .where(eq(project.organizationId, who.organizationId))
        .orderBy(asc(project.name))

      const counts = await db
        .select({ projectId: intent.projectId, tests: sql<number>`count(*)` })
        .from(intent)
        .innerJoin(project, eq(project.id, intent.projectId))
        .where(eq(project.organizationId, who.organizationId))
        .groupBy(intent.projectId)

      const environments = await db
        .select({
          id: environment.id,
          projectId: environment.projectId,
          name: environment.name,
          baseUrl: environment.baseUrl,
          isDefault: environment.isDefault,
        })
        .from(environment)
        .innerJoin(project, eq(project.id, environment.projectId))
        .where(eq(project.organizationId, who.organizationId))
        .orderBy(asc(environment.name))

      return {
        organization: who.organizationName,
        projects: rows.map((row) => ({
          ...row,
          testCount: counts.find((item) => item.projectId === row.id)?.tests ?? 0,
          environments: environments.filter((item) => item.projectId === row.id),
          dashboardUrl: links(who).project(row.id),
        })),
      }
    }),
  )

  server.registerTool(
    'list_tests',
    {
      description:
        'The tests in a project: title, status (proposed, draft, generating, ready, passing, failing), whether a script exists, and the latest run.',
      inputSchema: {
        projectId: z.string().describe('From list_projects.'),
        status: z
          .enum(['proposed', 'draft', 'generating', 'ready', 'passing', 'failing'])
          .optional()
          .describe('Only tests in this status.'),
      },
      annotations: { readOnlyHint: true },
    },
    guarded('list_tests', async ({ projectId, status }, who, db) => {
      requireScope(who, 'read')
      await limited(who, 'read')
      await assertProject(db, who.organizationId, projectId)

      const rows = await db
        .select({
          id: intent.id,
          title: intent.title,
          description: intent.description,
          status: intent.status,
          readiness: intent.readiness,
          hasScript: sql<number>`${intent.currentVersionId} is not null`,
          schedule: intent.schedule,
          lastRunId: intent.lastRunId,
          lastRunStatus: run.status,
          lastRunAt: run.startedAt,
          pendingRepair: sql<number>`${intent.pendingRepairVersionId} is not null`,
          updatedAt: intent.updatedAt,
        })
        .from(intent)
        .leftJoin(run, eq(run.id, intent.lastRunId))
        .where(
          status
            ? and(eq(intent.projectId, projectId), eq(intent.status, status))
            : eq(intent.projectId, projectId),
        )
        .orderBy(desc(intent.updatedAt))

      return {
        tests: rows.map((row) => ({
          ...row,
          hasScript: Boolean(row.hasScript),
          pendingRepair: Boolean(row.pendingRepair),
          lastRunAt: row.lastRunAt?.toISOString() ?? null,
          updatedAt: row.updatedAt.toISOString(),
          dashboardUrl: links(who).test(projectId, row.id),
        })),
      }
    }),
  )

  server.registerTool(
    'get_test',
    {
      description: 'One test in full: the intent, the current script, and its recent runs.',
      inputSchema: { testId: z.string() },
      annotations: { readOnlyHint: true },
    },
    guarded('get_test', async ({ testId }, who, db) => {
      requireScope(who, 'read')
      await limited(who, 'read')
      const { test, project: owner } = await loadTest(db, who, testId)

      const [version] = test.currentVersionId
        ? await db
            .select({ version: scriptVersion.version, code: scriptVersion.code })
            .from(scriptVersion)
            .where(eq(scriptVersion.id, test.currentVersionId))
            .limit(1)
        : []

      const runs = await db
        .select({
          id: run.id,
          status: run.status,
          trigger: run.trigger,
          purpose: run.purpose,
          environmentName: run.environmentName,
          errorMessage: run.errorMessage,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
        })
        .from(run)
        .where(eq(run.intentId, test.id))
        .orderBy(desc(run.startedAt))
        .limit(10)

      return {
        id: test.id,
        title: test.title,
        description: test.description,
        status: test.status,
        readiness: test.readiness,
        schedule: test.schedule,
        healPolicy: test.healPolicy,
        pendingRepair: Boolean(test.pendingRepairVersionId),
        project: { id: owner.id, name: owner.name },
        script: version ?? null,
        recentRuns: runs.map((row) => ({
          ...row,
          startedAt: row.startedAt.toISOString(),
          finishedAt: row.finishedAt?.toISOString() ?? null,
          dashboardUrl: links(who).run(owner.id, row.id),
        })),
        dashboardUrl: links(who).test(owner.id, test.id),
      }
    }),
  )

  server.registerTool(
    'create_test',
    {
      description:
        'Add a test to a project from a plain-English description of what a person does and what must be true at the end. Set generate to true to have the AI write and verify the script straight away.',
      inputSchema: {
        projectId: z.string(),
        title: z
          .string()
          .min(1)
          .max(120)
          .describe('A short capability, e.g. "Visitor can sign in".'),
        description: z
          .string()
          .min(10)
          .max(4000)
          .describe(
            'The steps and the expected result. Quote visible text exactly. Refer to credentials by their environment variable name.',
          ),
        generate: z.boolean().optional().describe('Generate the script now. Default true.'),
        environmentId: z.string().optional().describe('Defaults to the project default.'),
      },
    },
    guarded(
      'create_test',
      async ({ projectId, title, description, generate, environmentId }, who, db) => {
        requireScope(who, 'write')
        await limited(who, 'trigger')
        await assertProject(db, who.organizationId, projectId)

        const created = await createIntentRecord(db, {
          projectId,
          title: title.trim(),
          description: description.trim(),
          createdBy: who.userId,
        })

        let job: { id: string } | null = null
        if (generate ?? true) {
          const target = await pickEnvironment(db, who, projectId, environmentId, 'generate')
          const queued = await queueGeneration(db, {
            intentId: created.id,
            projectId,
            organizationId: who.organizationId,
            environment: target,
            createdBy: who.userId,
          })
          job = { id: queued.jobId }
        }

        return {
          test: {
            id: created.id,
            title: created.title,
            status: job ? 'generating' : created.status,
          },
          job: job ? { id: job.id, hint: 'Poll get_job with this id.' } : null,
          dashboardUrl: links(who).test(projectId, created.id),
        }
      },
    ),
  )

  server.registerTool(
    'generate_test',
    {
      description:
        'Ask the AI to write (or rewrite) the script for a test by performing the flow in a real browser. Returns a job to poll.',
      inputSchema: {
        testId: z.string(),
        environmentId: z.string().optional().describe('Defaults to the project default.'),
      },
    },
    guarded('generate_test', async ({ testId, environmentId }, who, db) => {
      requireScope(who, 'write')
      await limited(who, 'trigger')
      const { test, project: owner } = await loadTest(db, who, testId)

      if (test.description.trim().length < 10) {
        throw new ToolError(
          'Describe what should happen, in a sentence or two, before generating a script.',
        )
      }
      await assertNoGenerationInFlight(db, test.id, test.status)

      const target = await pickEnvironment(db, who, owner.id, environmentId, 'generate')
      const queued = await queueGeneration(db, {
        intentId: test.id,
        projectId: owner.id,
        organizationId: who.organizationId,
        environment: target,
        createdBy: who.userId,
      })

      return {
        job: { id: queued.jobId, kind: 'generate', status: 'queued' },
        environment: { id: target.id, name: target.name },
        dashboardUrl: links(who).test(owner.id, test.id),
      }
    }),
  )

  server.registerTool(
    'explore_project',
    {
      description:
        'Send the AI to browse an app and propose the tests worth having, then generate all of them. Use it for a project with no tests yet, or when asked to "cover" an area. Returns a job to poll; proposals appear as tests as they are generated.',
      inputSchema: {
        projectId: z.string(),
        focus: z
          .string()
          .max(500)
          .optional()
          .describe('What to concentrate on, e.g. "the checkout flow".'),
        environmentId: z.string().optional(),
      },
    },
    guarded('explore_project', async ({ projectId, focus, environmentId }, who, db) => {
      requireScope(who, 'write')
      await limited(who, 'trigger')
      await assertProject(db, who.organizationId, projectId)

      const target = await pickEnvironment(db, who, projectId, environmentId, 'explore')
      const queued = await queueExploration(db, {
        projectId,
        organizationId: who.organizationId,
        environment: target,
        createdBy: who.userId,
        focus: focus?.trim() || null,
        autoGenerate: true,
      })

      return {
        job: { id: queued.jobId, kind: 'explore', status: 'queued' },
        hint: 'Exploration takes a few minutes. Poll get_job, then list_tests to see what it proposed.',
        dashboardUrl: links(who).project(projectId),
      }
    }),
  )

  server.registerTool(
    'get_job',
    {
      description:
        'The state of a generation, exploration or repair job: pending, succeeded or failed, with the script it produced and its verification run.',
      inputSchema: { jobId: z.string() },
      annotations: { readOnlyHint: true },
    },
    guarded('get_job', async ({ jobId }, who, db) => {
      requireScope(who, 'read')
      await limited(who, 'read')
      return jobSummary(db, who, jobId)
    }),
  )

  server.registerTool(
    'run_test',
    {
      description:
        'Run one ready test now against an environment. Returns a run id to poll with get_run.',
      inputSchema: {
        testId: z.string(),
        environmentId: z.string().optional().describe('Defaults to the project default.'),
      },
    },
    guarded('run_test', async ({ testId, environmentId }, who, db) => {
      requireScope(who, 'write')
      await limited(who, 'trigger')
      const { test, project: owner } = await loadTest(db, who, testId)

      if (
        test.readiness !== 'ready' ||
        !test.currentVersionId ||
        !['ready', 'passing', 'failing'].includes(test.status)
      ) {
        throw new ToolError(
          test.status === 'generating'
            ? 'This test is still being generated. Poll get_job, then run it.'
            : 'This test has no script yet. Call generate_test first.',
        )
      }

      const target = await pickEnvironment(db, who, owner.id, environmentId, 'run')
      const queued = await queueIntentRun(db, {
        intentId: test.id,
        projectId: owner.id,
        organizationId: who.organizationId,
        environment: target,
        scriptVersionId: test.currentVersionId,
      })

      return {
        run: { id: queued.runId, status: queued.status },
        environment: { id: target.id, name: target.name },
        hint: 'Poll get_run. A run usually finishes within a minute.',
        dashboardUrl: links(who).run(owner.id, queued.runId),
      }
    }),
  )

  server.registerTool(
    'run_suite',
    {
      description:
        'Run every ready test in a project (or a chosen subset) against an environment. Returns a suite run id to poll with get_suite_run.',
      inputSchema: {
        projectId: z.string(),
        environmentId: z.string().optional(),
        testIds: z.array(z.string()).max(200).optional().describe('Restrict to these tests.'),
      },
    },
    guarded('run_suite', async ({ projectId, environmentId, testIds }, who, db) => {
      requireScope(who, 'write')
      await limited(who, 'trigger')
      await assertProject(db, who.organizationId, projectId)

      if ((await countRunnableIntents(db, projectId)) === 0) {
        throw new ToolError('This project has no ready tests to run.')
      }

      const target = await pickEnvironment(db, who, projectId, environmentId, 'run')
      const queued = await queueSuiteRun(db, {
        projectId,
        organizationId: who.organizationId,
        environment: target,
        createdBy: who.userId,
        intentIds: testIds,
      })

      return {
        suiteRun: { id: queued.suiteRunId, status: 'queued', total: queued.total },
        environment: { id: target.id, name: target.name },
        hint: 'Poll get_suite_run.',
        dashboardUrl: links(who).project(projectId),
      }
    }),
  )

  server.registerTool(
    'get_run',
    {
      description:
        'The result of one run: status, the step that failed and why, the diagnosis, and a dashboard link with the screenshot and trace.',
      inputSchema: { runId: z.string() },
      annotations: { readOnlyHint: true },
    },
    guarded('get_run', async ({ runId }, who, db) => {
      requireScope(who, 'read')
      await limited(who, 'read')
      const report = await readRunReport(db, who.organizationId, runId)
      const pending = report.run.status === 'queued' || report.run.status === 'running'
      return {
        ...runSummary(report, who),
        pending,
        hint: pending ? 'Still running. Ask again shortly.' : null,
        logs: report.attempts.at(-1)?.logs?.slice(-30) ?? [],
      }
    }),
  )

  server.registerTool(
    'get_suite_run',
    {
      description: 'The state of a suite run and a one-line result for each test in it.',
      inputSchema: { suiteRunId: z.string() },
      annotations: { readOnlyHint: true },
    },
    guarded('get_suite_run', async ({ suiteRunId }, who, db) => {
      requireScope(who, 'read')
      await limited(who, 'read')
      const scoped = await loadSuiteRun(db, who.organizationId, suiteRunId)

      const members = await db
        .select({
          id: run.id,
          status: run.status,
          errorMessage: run.errorMessage,
          testId: intent.id,
          title: intent.title,
          // Written out by hand: Drizzle drops table qualifiers inside a select
          // list, which would make the inner "id" mean the attempt's own id.
          failedStep: sql<string | null>`(
            select json_extract(step.value, '$.label')
            from attempt, json_each(json_extract(attempt.result, '$.steps')) as step
            where attempt.run_id = run.id and json_extract(step.value, '$.ok') = 0
            order by attempt.attempt_number desc limit 1
          )`,
        })
        .from(run)
        .innerJoin(intent, eq(intent.id, run.intentId))
        .where(eq(run.suiteRunId, suiteRunId))
        .orderBy(asc(run.startedAt), asc(run.id))

      const pending = scoped.suiteRun.status === 'queued' || scoped.suiteRun.status === 'running'
      return {
        id: scoped.suiteRun.id,
        status: scoped.suiteRun.status,
        pending,
        hint: pending ? 'Still running. Ask again shortly.' : null,
        project: { id: scoped.project.id, name: scoped.project.name },
        environment: scoped.suiteRun.environmentName,
        counts: {
          total: scoped.suiteRun.totalCount,
          passed: scoped.suiteRun.passedCount,
          failed: scoped.suiteRun.failedCount,
          error: scoped.suiteRun.errorCount,
        },
        errorMessage: scoped.suiteRun.errorMessage,
        startedAt: scoped.suiteRun.startedAt.toISOString(),
        finishedAt: scoped.suiteRun.finishedAt?.toISOString() ?? null,
        runs: members.map((row) => ({
          ...row,
          dashboardUrl: links(who).run(scoped.project.id, row.id),
        })),
        dashboardUrl: links(who).project(scoped.project.id),
      }
    }),
  )

  server.registerTool(
    'repair_run',
    {
      description:
        'Ask the AI to fix the script behind a failed run. It replays the flow in a real browser, patches the failing step, verifies the fix, and leaves the new version for a person to accept (or adopts it, if the heal policy is set to auto). Returns a job to poll.',
      inputSchema: { runId: z.string() },
    },
    guarded('repair_run', async ({ runId }, who, db) => {
      requireScope(who, 'write')
      await limited(who, 'trigger')
      const scoped = await loadRun(db, who.organizationId, runId)

      if (scoped.run.status !== 'failed') {
        throw new ToolError(
          scoped.run.status === 'error'
            ? 'This run stopped before the test could be judged, so there is no failing step to repair. Fix the environment and run it again.'
            : 'Only a failed run can be repaired.',
        )
      }

      const [test] = await db
        .select({ id: intent.id, currentVersionId: intent.currentVersionId })
        .from(intent)
        .where(eq(intent.id, scoped.run.intentId))
        .limit(1)
      if (!test) throw new ToolError('Test not found.')
      if (test.currentVersionId !== scoped.run.scriptVersionId) {
        throw new ToolError(
          'This run used an older version of the script. Run the current version first, then repair that.',
        )
      }

      const queued = await queueRepair(db, {
        runId: scoped.run.id,
        intentId: test.id,
        projectId: scoped.project.id,
        environmentId: scoped.run.environmentId,
        organizationId: who.organizationId,
        createdBy: who.userId,
      })

      return {
        job: { id: queued.jobId, kind: 'repair', status: 'queued' },
        hint: 'Poll get_job. When it succeeds, the repaired script waits on the test page for a person to accept it unless the heal policy is auto.',
        dashboardUrl: links(who).test(scoped.project.id, test.id),
      }
    }),
  )

  return server
}
