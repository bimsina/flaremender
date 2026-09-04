import { env } from 'cloudflare:workers'
import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { apiExecutionRequest, attempt, intent, project, run, suiteRun } from '#/db/schema/app.ts'
import { exportRun, junitReport } from '#/lib/report-export.ts'
import { createId } from '#/lib/ids.ts'
import { WEBHOOK_API_KEY_CONFIG, createAuth } from '#/lib/auth.ts'
import { queueIntentRun, queueSuiteRun, resolveTargetEnvironment } from './actions.ts'
import { getDb } from './auth.ts'
import { readRunReport, readSuiteReport } from './reports.server.ts'
import { loadEnvironment } from './scope.ts'

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const TERMINAL_RUN_STATUSES = ['passed', 'healed', 'failed', 'error'] as const
const TERMINAL_SUITE_STATUSES = ['passed', 'failed', 'error'] as const

export class WebhookApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly headers?: HeadersInit,
  ) {
    super(message)
  }
}

type WebhookPermission = 'trigger' | 'read'

interface WebhookPrincipal {
  apiKeyId: string
  apiKeyName: string
  organizationId: string
  projectId: string
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization')
  if (!authorization) {
    throw new WebhookApiError('UNAUTHORIZED', 'Provide an API key as a Bearer token.', 401)
  }
  const match = /^Bearer (flm_pk_[A-Za-z0-9_-]{32,160})$/.exec(authorization)
  if (!match?.[1]) throw new WebhookApiError('UNAUTHORIZED', 'The API key is invalid.', 401)
  return match[1]
}

async function authenticateWebhook(
  request: Request,
  permission: WebhookPermission,
): Promise<WebhookPrincipal> {
  const verified = await createAuth(env.DB, env).api.verifyApiKey({
    body: {
      configId: WEBHOOK_API_KEY_CONFIG,
      key: bearerToken(request),
      permissions: { webhook: [permission] },
    },
  })
  if (!verified.valid || !verified.key) {
    throw new WebhookApiError('UNAUTHORIZED', 'The API key is invalid, expired, or revoked.', 401)
  }

  const projectId =
    verified.key.metadata && typeof verified.key.metadata.projectId === 'string'
      ? verified.key.metadata.projectId
      : null
  if (!projectId) throw new WebhookApiError('FORBIDDEN', 'The API key has no project scope.', 403)

  const db = getDb()
  const [ownedProject] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.id, projectId), eq(project.organizationId, verified.key.referenceId)))
    .limit(1)
  if (!ownedProject)
    throw new WebhookApiError('FORBIDDEN', 'The API key project is unavailable.', 403)

  return {
    apiKeyId: verified.key.id,
    apiKeyName: verified.key.name ?? 'Unnamed key',
    organizationId: verified.key.referenceId,
    projectId,
  }
}

async function applyRateLimit(principal: WebhookPrincipal, permission: WebhookPermission) {
  const limiter =
    permission === 'trigger' ? env.WEBHOOK_TRIGGER_RATE_LIMITER : env.WEBHOOK_READ_RATE_LIMITER
  const result = await limiter.limit({ key: principal.apiKeyId })
  if (!result.success) {
    throw new WebhookApiError('RATE_LIMITED', 'Too many webhook API requests.', 429, {
      'Retry-After': '60',
    })
  }
}

function assertProjectScope(principal: WebhookPrincipal, requestedProjectId: string) {
  if (principal.projectId !== requestedProjectId) {
    throw new WebhookApiError('FORBIDDEN', 'This API key belongs to a different project.', 403)
  }
}

async function requestBody(request: Request): Promise<{ environmentId: string | null }> {
  const text = await request.text()
  if (!text.trim()) return { environmentId: null }
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
  const entries = Object.keys(parsed)
  if (entries.some((key) => key !== 'environmentId')) {
    throw new WebhookApiError('INVALID_BODY', 'Only environmentId is accepted.', 400)
  }
  const value = (parsed as Record<string, unknown>).environmentId
  if (value === undefined || value === null) return { environmentId: null }
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new WebhookApiError(
      'INVALID_ENVIRONMENT',
      'environmentId must be a non-empty string.',
      400,
    )
  }
  return { environmentId: value }
}

async function targetEnvironment(
  db: Db,
  principal: WebhookPrincipal,
  environmentId: string | null,
) {
  try {
    const named = environmentId
      ? (await loadEnvironment(db, principal.organizationId, environmentId)).environment
      : null
    return await resolveTargetEnvironment(db, principal.projectId, named, 'run')
  } catch (error) {
    throw new WebhookApiError(
      'INVALID_ENVIRONMENT',
      error instanceof Error ? error.message : 'The environment is invalid.',
      400,
    )
  }
}

function idempotencyKey(request: Request): string | null {
  const value = request.headers.get('idempotency-key')
  if (value === null) return null
  if (!/^[\x21-\x7E]{1,128}$/.test(value)) {
    throw new WebhookApiError(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must contain 1 to 128 visible ASCII characters without spaces.',
      400,
    )
  }
  return value
}

async function fingerprint(value: Record<string, string>) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface IdempotencyClaim {
  executionId: string
  replayed: boolean
  accepted: boolean
  recordId: string | null
}

async function claimIdempotency(
  db: Db,
  input: {
    apiKeyId: string
    key: string | null
    requestFingerprint: string
    executionKind: 'run' | 'suite'
  },
): Promise<IdempotencyClaim> {
  const executionId = createId(input.executionKind === 'run' ? 'run' : 'srun')
  if (!input.key) return { executionId, replayed: false, accepted: false, recordId: null }

  const now = new Date()
  await db
    .delete(apiExecutionRequest)
    .where(
      and(
        eq(apiExecutionRequest.apiKeyId, input.apiKeyId),
        eq(apiExecutionRequest.idempotencyKey, input.key),
        lte(apiExecutionRequest.expiresAt, now),
      ),
    )

  const id = createId('idem')
  const inserted = await db
    .insert(apiExecutionRequest)
    .values({
      id,
      apiKeyId: input.apiKeyId,
      idempotencyKey: input.key,
      requestFingerprint: input.requestFingerprint,
      executionKind: input.executionKind,
      executionId,
      dispatchState: 'pending',
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
    })
    .onConflictDoNothing()
    .returning({ id: apiExecutionRequest.id })

  if (inserted.length > 0) {
    return { executionId, replayed: false, accepted: false, recordId: id }
  }

  const [existing] = await db
    .select()
    .from(apiExecutionRequest)
    .where(
      and(
        eq(apiExecutionRequest.apiKeyId, input.apiKeyId),
        eq(apiExecutionRequest.idempotencyKey, input.key),
      ),
    )
    .limit(1)
  if (!existing) throw new WebhookApiError('IDEMPOTENCY_CONFLICT', 'Retry the request.', 409)
  if (
    existing.requestFingerprint !== input.requestFingerprint ||
    existing.executionKind !== input.executionKind
  ) {
    throw new WebhookApiError(
      'IDEMPOTENCY_CONFLICT',
      'This Idempotency-Key was already used with different request data.',
      409,
    )
  }

  return {
    executionId: existing.executionId,
    replayed: true,
    accepted: existing.dispatchState === 'accepted',
    recordId: existing.id,
  }
}

async function setDispatchState(
  db: Db,
  recordId: string | null,
  state: 'accepted' | 'failed',
  error?: string,
) {
  if (!recordId) return
  await db
    .update(apiExecutionRequest)
    .set({ dispatchState: state, lastError: error ?? null })
    .where(eq(apiExecutionRequest.id, recordId))
}

function executionUrls(
  request: Request,
  input: {
    executionId: string
    projectId: string
    testId: string | null
  },
) {
  const statusUrl = new URL(
    `/api/v1/executions/${encodeURIComponent(input.executionId)}`,
    request.url,
  )
  return {
    statusUrl: statusUrl.toString(),
    reportUrl: new URL(`${statusUrl.pathname}/report`, request.url).toString(),
    dashboardUrl: new URL(
      input.testId
        ? `/projects/${encodeURIComponent(input.projectId)}/runs/${encodeURIComponent(input.executionId)}`
        : `/projects/${encodeURIComponent(input.projectId)}?tab=runs`,
      request.url,
    ).toString(),
  }
}

async function triggerResponse(
  request: Request,
  input: {
    claim: IdempotencyClaim
    kind: 'run' | 'suite'
    projectId: string
    testId: string | null
    environmentId: string
  },
) {
  const db = getDb()
  const [stored] =
    input.kind === 'run'
      ? await db
          .select({ status: run.status })
          .from(run)
          .where(eq(run.id, input.claim.executionId))
          .limit(1)
      : await db
          .select({ status: suiteRun.status })
          .from(suiteRun)
          .where(eq(suiteRun.id, input.claim.executionId))
          .limit(1)
  const urls = executionUrls(request, {
    executionId: input.claim.executionId,
    projectId: input.projectId,
    testId: input.testId,
  })
  const headers = new Headers({ Location: urls.statusUrl, 'Cache-Control': 'no-store' })
  if (input.claim.replayed) headers.set('Idempotency-Replayed', 'true')
  return Response.json(
    {
      schemaVersion: 1,
      replayed: input.claim.replayed,
      execution: {
        id: input.claim.executionId,
        kind: input.kind,
        status: stored?.status ?? 'queued',
        projectId: input.projectId,
        testId: input.testId,
        environmentId: input.environmentId,
        ...urls,
      },
    },
    { status: input.claim.replayed ? 200 : 202, headers },
  )
}

export async function triggerProjectWebhook(request: Request, requestedProjectId: string) {
  const principal = await authenticateWebhook(request, 'trigger')
  assertProjectScope(principal, requestedProjectId)
  await applyRateLimit(principal, 'trigger')
  const db = getDb()
  const body = await requestBody(request)
  const target = await targetEnvironment(db, principal, body.environmentId)
  const claim = await claimIdempotency(db, {
    apiKeyId: principal.apiKeyId,
    key: idempotencyKey(request),
    requestFingerprint: await fingerprint({
      kind: 'suite',
      projectId: principal.projectId,
      environmentId: target.id,
    }),
    executionKind: 'suite',
  })
  if (claim.accepted) {
    return triggerResponse(request, {
      claim,
      kind: 'suite',
      projectId: principal.projectId,
      testId: null,
      environmentId: target.id,
    })
  }
  const members = await db
    .select({ id: intent.id })
    .from(intent)
    .where(
      and(
        eq(intent.projectId, principal.projectId),
        eq(intent.readiness, 'ready'),
        isNotNull(intent.currentVersionId),
        inArray(intent.status, ['ready', 'passing', 'failing']),
      ),
    )
    .orderBy(asc(intent.createdAt))
  if (members.length === 0) {
    throw new WebhookApiError('NO_READY_TESTS', 'This project has no ready tests.', 409)
  }

  await db
    .update(suiteRun)
    .set({ status: 'queued', errorMessage: null, finishedAt: null })
    .where(
      and(
        eq(suiteRun.id, claim.executionId),
        eq(suiteRun.webhookApiKeyId, principal.apiKeyId),
        eq(suiteRun.status, 'error'),
      ),
    )
  try {
    await queueSuiteRun(db, {
      projectId: principal.projectId,
      organizationId: principal.organizationId,
      environment: target,
      createdBy: null,
      suiteRunId: claim.executionId,
      trigger: 'webhook',
      intentIds: members.map((row) => row.id),
      webhookApiKeyId: principal.apiKeyId,
      webhookApiKeyName: principal.apiKeyName,
    })
    await setDispatchState(db, claim.recordId, 'accepted')
  } catch (error) {
    await setDispatchState(
      db,
      claim.recordId,
      'failed',
      error instanceof Error ? error.message : 'Workflow dispatch failed.',
    )
    throw new WebhookApiError(
      'DISPATCH_FAILED',
      'The suite could not be started. Retry safely with the same Idempotency-Key.',
      503,
    )
  }

  return triggerResponse(request, {
    claim,
    kind: 'suite',
    projectId: principal.projectId,
    testId: null,
    environmentId: target.id,
  })
}

export async function triggerTestWebhook(
  request: Request,
  requestedProjectId: string,
  testId: string,
) {
  const principal = await authenticateWebhook(request, 'trigger')
  assertProjectScope(principal, requestedProjectId)
  await applyRateLimit(principal, 'trigger')
  const db = getDb()
  const body = await requestBody(request)
  const target = await targetEnvironment(db, principal, body.environmentId)
  const claim = await claimIdempotency(db, {
    apiKeyId: principal.apiKeyId,
    key: idempotencyKey(request),
    requestFingerprint: await fingerprint({
      kind: 'run',
      projectId: principal.projectId,
      testId,
      environmentId: target.id,
    }),
    executionKind: 'run',
  })
  if (claim.accepted) {
    return triggerResponse(request, {
      claim,
      kind: 'run',
      projectId: principal.projectId,
      testId,
      environmentId: target.id,
    })
  }
  const [test] = await db
    .select({
      id: intent.id,
      currentVersionId: intent.currentVersionId,
      readiness: intent.readiness,
      status: intent.status,
    })
    .from(intent)
    .where(and(eq(intent.id, testId), eq(intent.projectId, principal.projectId)))
    .limit(1)
  if (!test) throw new WebhookApiError('NOT_FOUND', 'Test not found.', 404)
  if (
    test.readiness !== 'ready' ||
    !test.currentVersionId ||
    !['ready', 'passing', 'failing'].includes(test.status)
  ) {
    throw new WebhookApiError(
      'TEST_NOT_READY',
      'This test must be ready before it can be triggered.',
      409,
    )
  }

  await db
    .update(run)
    .set({ status: 'queued', errorMessage: null, finishedAt: null })
    .where(
      and(
        eq(run.id, claim.executionId),
        eq(run.webhookApiKeyId, principal.apiKeyId),
        eq(run.status, 'error'),
      ),
    )
  try {
    await queueIntentRun(db, {
      intentId: test.id,
      projectId: principal.projectId,
      organizationId: principal.organizationId,
      environment: target,
      scriptVersionId: test.currentVersionId,
      runId: claim.executionId,
      trigger: 'webhook',
      webhookApiKeyId: principal.apiKeyId,
      webhookApiKeyName: principal.apiKeyName,
    })
    await setDispatchState(db, claim.recordId, 'accepted')
  } catch (error) {
    await setDispatchState(
      db,
      claim.recordId,
      'failed',
      error instanceof Error ? error.message : 'Workflow dispatch failed.',
    )
    throw new WebhookApiError(
      'DISPATCH_FAILED',
      'The run could not be started. Retry safely with the same Idempotency-Key.',
      503,
    )
  }

  return triggerResponse(request, {
    claim,
    kind: 'run',
    projectId: principal.projectId,
    testId,
    environmentId: target.id,
  })
}

export async function readWebhookExecution(request: Request, executionId: string) {
  const principal = await authenticateWebhook(request, 'read')
  await applyRateLimit(principal, 'read')
  const db = getDb()

  if (executionId.startsWith('run_')) {
    const [row] = await db
      .select({ run, testTitle: intent.title })
      .from(run)
      .innerJoin(intent, eq(intent.id, run.intentId))
      .where(and(eq(run.id, executionId), eq(run.projectId, principal.projectId)))
      .limit(1)
    if (!row) throw new WebhookApiError('NOT_FOUND', 'Execution not found.', 404)
    const attempts = await db
      .select({ durationMs: attempt.durationMs, errorMessage: attempt.errorMessage })
      .from(attempt)
      .where(eq(attempt.runId, executionId))
      .orderBy(asc(attempt.attemptNumber))
    const pending = row.run.status === 'queued' || row.run.status === 'running'
    return Response.json(
      {
        schemaVersion: 1,
        pollAfterMs: pending ? 2500 : null,
        execution: {
          id: row.run.id,
          kind: 'run',
          status: row.run.status,
          projectId: row.run.projectId,
          testId: row.run.intentId,
          testTitle: row.testTitle,
          environmentId: row.run.environmentId,
          environmentName: row.run.environmentName,
          baseUrl: row.run.baseUrl,
          startedAt: row.run.startedAt,
          finishedAt: row.run.finishedAt,
          attemptCount: attempts.length,
          durationMs: attempts.reduce((total, item) => total + (item.durationMs ?? 0), 0),
          errorMessage: attempts.at(-1)?.errorMessage ?? row.run.errorMessage,
        },
      },
      {
        headers: pending
          ? { 'Cache-Control': 'no-store', 'Retry-After': '3' }
          : { 'Cache-Control': 'no-store' },
      },
    )
  }

  if (executionId.startsWith('srun_')) {
    const [suite] = await db
      .select()
      .from(suiteRun)
      .where(and(eq(suiteRun.id, executionId), eq(suiteRun.projectId, principal.projectId)))
      .limit(1)
    if (!suite) throw new WebhookApiError('NOT_FOUND', 'Execution not found.', 404)
    const children = await db
      .select({
        id: run.id,
        status: run.status,
        testId: run.intentId,
        testTitle: intent.title,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        attemptCount: sql<number>`count(${attempt.id})`,
        durationMs: sql<number | null>`sum(${attempt.durationMs})`,
      })
      .from(run)
      .innerJoin(intent, eq(intent.id, run.intentId))
      .leftJoin(attempt, eq(attempt.runId, run.id))
      .where(eq(run.suiteRunId, suite.id))
      .groupBy(run.id)
      .orderBy(asc(run.startedAt), asc(run.id))
    const pending = suite.status === 'queued' || suite.status === 'running'
    return Response.json(
      {
        schemaVersion: 1,
        pollAfterMs: pending ? 2500 : null,
        execution: {
          id: suite.id,
          kind: 'suite',
          status: suite.status,
          projectId: suite.projectId,
          testId: null,
          environmentId: suite.environmentId,
          environmentName: suite.environmentName,
          baseUrl: suite.baseUrl,
          startedAt: suite.startedAt,
          finishedAt: suite.finishedAt,
          errorMessage: suite.errorMessage,
          counts: {
            total: suite.totalCount,
            passed: suite.passedCount,
            failed: suite.failedCount,
            error: suite.errorCount,
          },
          runs: children.map((child) => ({
            ...child,
            attemptCount: Number(child.attemptCount ?? 0),
            durationMs: child.durationMs === null ? null : Number(child.durationMs),
          })),
        },
      },
      {
        headers: pending
          ? { 'Cache-Control': 'no-store', 'Retry-After': '3' }
          : { 'Cache-Control': 'no-store' },
      },
    )
  }

  throw new WebhookApiError('NOT_FOUND', 'Execution not found.', 404)
}

export async function readWebhookReport(request: Request, executionId: string) {
  const principal = await authenticateWebhook(request, 'read')
  await applyRateLimit(principal, 'read')
  const format = new URL(request.url).searchParams.get('format') ?? 'json'
  if (format !== 'json' && format !== 'junit') {
    throw new WebhookApiError('INVALID_FORMAT', 'Use json or junit.', 400)
  }
  const db = getDb()
  const isSuite = executionId.startsWith('srun_')
  if (!isSuite && !executionId.startsWith('run_')) {
    throw new WebhookApiError('NOT_FOUND', 'Execution not found.', 404)
  }

  const [status] = isSuite
    ? await db
        .select({ value: suiteRun.status })
        .from(suiteRun)
        .where(and(eq(suiteRun.id, executionId), eq(suiteRun.projectId, principal.projectId)))
        .limit(1)
    : await db
        .select({ value: run.status })
        .from(run)
        .where(and(eq(run.id, executionId), eq(run.projectId, principal.projectId)))
        .limit(1)
  if (!status) throw new WebhookApiError('NOT_FOUND', 'Execution not found.', 404)
  const terminal = isSuite
    ? TERMINAL_SUITE_STATUSES.includes(status.value as (typeof TERMINAL_SUITE_STATUSES)[number])
    : TERMINAL_RUN_STATUSES.includes(status.value as (typeof TERMINAL_RUN_STATUSES)[number])
  if (!terminal)
    throw new WebhookApiError(
      'REPORT_NOT_READY',
      'The report is available after the execution finishes.',
      409,
    )

  const suite = isSuite ? await readSuiteReport(db, principal.organizationId, executionId) : null
  const reports = suite
    ? suite.runs
    : [await readRunReport(db, principal.organizationId, executionId)]
  const runs = reports.map(exportRun)
  const payload = suite
    ? { schemaVersion: 1, suite: suite.suiteRun, runs }
    : { schemaVersion: 1, run: runs[0] }
  const extension = format === 'junit' ? 'xml' : 'json'
  return new Response(
    format === 'junit'
      ? junitReport(executionId, runs, suite?.suiteRun)
      : JSON.stringify(payload, null, 2),
    {
      headers: {
        'Content-Type':
          format === 'junit' ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="execution-${executionId.replace(/[^a-zA-Z0-9_-]/g, '')}.${extension}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  )
}

export function webhookErrorResponse(error: unknown): Response {
  if (error instanceof WebhookApiError) {
    return Response.json(
      { schemaVersion: 1, error: { code: error.code, message: error.message } },
      { status: error.status, headers: error.headers },
    )
  }
  console.error('Webhook API request failed', error)
  return Response.json(
    {
      schemaVersion: 1,
      error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' },
    },
    { status: 500 },
  )
}
