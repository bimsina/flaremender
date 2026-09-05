/**
 * The parts of the versioned API that create tests and drive generation. Unlike the
 * run triggers, these accept a signed-in browser session as well as a project API
 * key, so a script on a developer's machine (the eval harness, for one) can use the
 * same cookie the dashboard uses.
 */
import { env } from 'cloudflare:workers'
import { and, eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { intent, project, run, scriptVersion } from '#/db/schema/app.ts'
import { member } from '#/db/schema/auth.ts'
import { hasSupportedAssertions } from '#/lib/assertions.ts'
import { createAuth } from '#/lib/auth.ts'
import {
  assertNoGenerationInFlight,
  createIntentRecord,
  queueGeneration,
  resolveTargetEnvironment,
} from './actions.ts'
import { getDb } from './auth.ts'
import { readJob } from './reports.server.ts'
import { loadEnvironment } from './scope.ts'
import { ValidationError, has, str } from './validate.ts'
import {
  WebhookApiError,
  type WebhookPermission,
  applyRateLimit,
  assertProjectScope,
  authenticateWebhook,
} from './webhooks.ts'

export interface ApiPrincipal {
  via: 'api-key' | 'session'
  organizationId: string
  /** Null for a session, which may reach any project in its organization. */
  projectId: string | null
  userId: string
  limiterKey: string
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}

export async function sessionPrincipal(request: Request, db: Db): Promise<ApiPrincipal> {
  const session = await createAuth(env.DB, env).api.getSession({ headers: request.headers })
  if (!session?.user) {
    throw new WebhookApiError(
      'UNAUTHORIZED',
      'Provide a project API key as a Bearer token, or sign in.',
      401,
    )
  }

  // A cookie is sent by the browser on its own, so a state-changing call has to prove
  // it came from this site rather than a page somewhere else.
  if (request.method !== 'GET' && !sameOrigin(request)) {
    throw new WebhookApiError('FORBIDDEN', 'Cross-origin requests need an API key.', 403)
  }

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) {
    throw new WebhookApiError('FORBIDDEN', 'Select an organization first.', 403)
  }

  const [membership] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
    .limit(1)
  if (!membership) {
    throw new WebhookApiError('FORBIDDEN', 'You are not a member of that organization.', 403)
  }

  return {
    via: 'session',
    organizationId,
    projectId: null,
    userId: session.user.id,
    limiterKey: `user:${session.user.id}`,
  }
}

async function principalFor(
  request: Request,
  db: Db,
  permission: WebhookPermission,
  requestedProjectId: string | null,
): Promise<ApiPrincipal> {
  let principal: ApiPrincipal

  if (request.headers.get('authorization')) {
    const key = await authenticateWebhook(request, permission)
    if (requestedProjectId) assertProjectScope(key, requestedProjectId)
    if (!key.userId) {
      throw new WebhookApiError(
        'FORBIDDEN',
        'This API key predates test creation. Create a new key under Project Settings.',
        403,
      )
    }
    principal = {
      via: 'api-key',
      organizationId: key.organizationId,
      projectId: key.projectId,
      userId: key.userId,
      limiterKey: key.apiKeyId,
    }
  } else {
    principal = await sessionPrincipal(request, db)
  }

  await applyRateLimit(principal.limiterKey, permission)

  if (requestedProjectId) {
    const [owned] = await db
      .select({ id: project.id })
      .from(project)
      .where(
        and(
          eq(project.id, requestedProjectId),
          eq(project.organizationId, principal.organizationId),
        ),
      )
      .limit(1)
    if (!owned) throw new WebhookApiError('NOT_FOUND', 'Project not found.', 404)
  }

  return principal
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (!text.trim()) return {}
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new WebhookApiError('UNSUPPORTED_MEDIA_TYPE', 'Use application/json.', 415)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new WebhookApiError('INVALID_JSON', 'The request body is not valid JSON.', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebhookApiError('INVALID_BODY', 'The request body must be a JSON object.', 400)
  }
  return parsed as Record<string, unknown>
}

function invalid(error: unknown): never {
  if (error instanceof ValidationError) {
    throw new WebhookApiError('INVALID_BODY', error.message, 400)
  }
  throw error
}

function jobUrls(request: Request, input: { jobId: string; projectId: string; testId: string }) {
  return {
    statusUrl: new URL(`/api/v1/jobs/${encodeURIComponent(input.jobId)}`, request.url).toString(),
    dashboardUrl: new URL(
      `/projects/${encodeURIComponent(input.projectId)}/intents/${encodeURIComponent(input.testId)}`,
      request.url,
    ).toString(),
  }
}

export async function createTestApi(request: Request, projectId: string): Promise<Response> {
  const db = getDb()
  const principal = await principalFor(request, db, 'trigger', projectId)
  const body = await jsonBody(request)

  let title: string
  let description: string
  try {
    title = str(body, 'title', { max: 120 })
    description = str(body, 'description', { min: 10, max: 4000 })
  } catch (error) {
    invalid(error)
  }

  const created = await createIntentRecord(db, {
    projectId,
    title,
    description,
    createdBy: principal.userId,
  })

  return Response.json(
    {
      schemaVersion: 1,
      test: {
        id: created.id,
        projectId,
        title: created.title,
        status: created.status,
        dashboardUrl: new URL(
          `/projects/${encodeURIComponent(projectId)}/intents/${encodeURIComponent(created.id)}`,
          request.url,
        ).toString(),
      },
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function generateTestApi(
  request: Request,
  projectId: string,
  testId: string,
): Promise<Response> {
  const db = getDb()
  const principal = await principalFor(request, db, 'trigger', projectId)
  const body = await jsonBody(request)

  const [test] = await db
    .select()
    .from(intent)
    .where(and(eq(intent.id, testId), eq(intent.projectId, projectId)))
    .limit(1)
  if (!test) throw new WebhookApiError('NOT_FOUND', 'Test not found.', 404)

  if (test.description.trim().length < 10) {
    throw new WebhookApiError(
      'INVALID_BODY',
      'Describe what should happen, in a sentence or two, before generating a script.',
      400,
    )
  }

  try {
    await assertNoGenerationInFlight(db, test.id, test.status)
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new WebhookApiError('GENERATION_IN_FLIGHT', error.message, 409)
    }
    throw error
  }

  const environmentId = has(body, 'environmentId') ? str(body, 'environmentId') : null
  let target
  try {
    const named = environmentId
      ? (await loadEnvironment(db, principal.organizationId, environmentId)).environment
      : null
    target = await resolveTargetEnvironment(db, projectId, named, 'generate')
  } catch (error) {
    throw new WebhookApiError(
      'INVALID_ENVIRONMENT',
      error instanceof Error ? error.message : 'The environment is invalid.',
      400,
    )
  }

  const queued = await queueGeneration(db, {
    intentId: test.id,
    projectId,
    organizationId: principal.organizationId,
    environment: target,
    createdBy: principal.userId,
  })

  const urls = jobUrls(request, { jobId: queued.jobId, projectId, testId })
  return Response.json(
    {
      schemaVersion: 1,
      job: {
        id: queued.jobId,
        kind: 'generate',
        status: 'queued',
        projectId,
        testId,
        environmentId: target.id,
        ...urls,
      },
    },
    { status: 202, headers: { Location: urls.statusUrl, 'Cache-Control': 'no-store' } },
  )
}

export async function readJobApi(request: Request, jobId: string): Promise<Response> {
  const db = getDb()
  const principal = await principalFor(request, db, 'read', null)

  const job = await readJob(db, principal.organizationId, jobId)
  if (!job || (principal.projectId !== null && job.projectId !== principal.projectId)) {
    throw new WebhookApiError('NOT_FOUND', 'Job not found.', 404)
  }

  const [verification] = job.runId
    ? await db
        .select({ id: run.id, status: run.status, errorMessage: run.errorMessage })
        .from(run)
        .where(eq(run.id, job.runId))
        .limit(1)
    : []

  const [version] = job.scriptVersionId
    ? await db
        .select({
          id: scriptVersion.id,
          version: scriptVersion.version,
          code: scriptVersion.code,
        })
        .from(scriptVersion)
        .where(eq(scriptVersion.id, job.scriptVersionId))
        .limit(1)
    : []

  const [test] = job.intentId
    ? await db
        .select({
          id: intent.id,
          status: intent.status,
          readiness: intent.readiness,
          currentVersionId: intent.currentVersionId,
        })
        .from(intent)
        .where(eq(intent.id, job.intentId))
        .limit(1)
    : []

  const pending = job.status === 'queued' || job.status === 'running'

  return Response.json(
    {
      schemaVersion: 1,
      pollAfterMs: pending ? 5000 : null,
      job: {
        id: job.id,
        kind: job.kind,
        status: job.status,
        projectId: job.projectId,
        testId: job.intentId,
        environmentId: job.environmentId,
        modelId: job.modelId,
        turns: job.turns,
        inputTokens: job.inputTokens,
        outputTokens: job.outputTokens,
        stuckReason: job.stuckReason,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        verification: verification
          ? {
              runId: verification.id,
              status: verification.status,
              errorMessage: verification.errorMessage,
            }
          : null,
        script: version
          ? {
              versionId: version.id,
              version: version.version,
              hasAssertions: hasSupportedAssertions(version.code),
              statementCount: version.code.split('\n').filter((line) => /^\s+\S/.test(line)).length,
              isCurrent: test?.currentVersionId === version.id,
            }
          : null,
        test: test ? { id: test.id, status: test.status, readiness: test.readiness } : null,
      },
    },
    {
      headers: pending
        ? { 'Cache-Control': 'no-store', 'Retry-After': '5' }
        : { 'Cache-Control': 'no-store' },
    },
  )
}
