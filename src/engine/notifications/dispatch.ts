/**
 * Delivers events to a project's notification destinations and records what happened.
 * Called from workflow steps after a run, suite or repair has been persisted, so a
 * destination that is down can never turn a recorded result into an error: every
 * failure ends up as a delivery row, not an exception.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { span } from '#/engine/tracing.ts'

import { createDb, type Db } from '#/db/index.ts'
import {
  attempt,
  environment,
  generationJob,
  intent,
  notificationDelivery,
  notificationDestination,
  project,
  run,
  scriptVersion,
  suiteRun,
} from '#/db/schema/app.ts'
import { createId } from '#/lib/ids.ts'
import { decryptSecret } from '#/server/core/crypto.ts'
import {
  type EventEnvironment,
  type NotificationEvent,
  type NotificationEventType,
  isNotificationEvent,
} from './events.ts'
import { discordBody, emailBody, slackBody } from './format.ts'
import { signPayload } from './sign.ts'

const DELIVERY_TIMEOUT_MS = 10_000
const ATTEMPTS = 2
const KEEP_DELIVERIES = 100

type Destination = typeof notificationDestination.$inferSelect

export interface DeliveryOutcome {
  destinationId: string
  status: 'delivered' | 'failed'
  responseStatus: number | null
  error: string | null
}

function url(origin: string, path: string): string {
  return new URL(path, origin).toString()
}

function environmentOf(row: {
  environmentId: string
  environmentName: string | null
  baseUrl: string | null
  fallbackName: string
}): EventEnvironment {
  return {
    id: row.environmentId,
    name: row.environmentName ?? row.fallbackName,
    baseUrl: row.baseUrl,
  }
}

export async function buildRunEvent(
  db: Db,
  runId: string,
  origin: string,
): Promise<NotificationEvent | null> {
  const [row] = await db
    .select({ run, project, testTitle: intent.title, environmentName: environment.name })
    .from(run)
    .innerJoin(project, eq(project.id, run.projectId))
    .innerJoin(intent, eq(intent.id, run.intentId))
    .innerJoin(environment, eq(environment.id, run.environmentId))
    .where(eq(run.id, runId))
    .limit(1)
  if (!row) return null

  const type: NotificationEventType | null =
    row.run.status === 'passed' || row.run.status === 'healed'
      ? 'run.passed'
      : row.run.status === 'failed'
        ? 'run.failed'
        : row.run.status === 'error'
          ? 'run.error'
          : null
  if (!type) return null

  const attempts = await db
    .select({ durationMs: attempt.durationMs, errorMessage: attempt.errorMessage })
    .from(attempt)
    .where(eq(attempt.runId, runId))
    .orderBy(desc(attempt.attemptNumber))
    .limit(1)

  return {
    type,
    project: { id: row.project.id, name: row.project.name },
    run: {
      id: row.run.id,
      status: row.run.status,
      trigger: row.run.trigger,
      test: { id: row.run.intentId, title: row.testTitle },
      environment: environmentOf({
        environmentId: row.run.environmentId,
        environmentName: row.run.environmentName,
        baseUrl: row.run.baseUrl,
        fallbackName: row.environmentName,
      }),
      errorMessage: attempts[0]?.errorMessage ?? row.run.errorMessage,
      durationMs: attempts[0]?.durationMs ?? null,
      startedAt: row.run.startedAt.toISOString(),
      finishedAt: row.run.finishedAt?.toISOString() ?? null,
      url: url(origin, `/projects/${row.project.id}/runs/${row.run.id}`),
      reportUrl: url(origin, `/api/reports/runs/${row.run.id}`),
    },
  }
}

export async function buildSuiteEvent(
  db: Db,
  suiteRunId: string,
  origin: string,
): Promise<NotificationEvent | null> {
  const [row] = await db
    .select({ suite: suiteRun, project, environmentName: environment.name })
    .from(suiteRun)
    .innerJoin(project, eq(project.id, suiteRun.projectId))
    .innerJoin(environment, eq(environment.id, suiteRun.environmentId))
    .where(eq(suiteRun.id, suiteRunId))
    .limit(1)
  if (!row) return null
  if (
    row.suite.status !== 'passed' &&
    row.suite.status !== 'failed' &&
    row.suite.status !== 'error'
  ) {
    return null
  }

  const failures = await db
    .select({
      id: run.id,
      status: run.status,
      intentId: run.intentId,
      title: intent.title,
      errorMessage: run.errorMessage,
    })
    .from(run)
    .innerJoin(intent, eq(intent.id, run.intentId))
    .where(and(eq(run.suiteRunId, suiteRunId), inArray(run.status, ['failed', 'error'])))
    .orderBy(run.startedAt)

  return {
    type: row.suite.status === 'passed' ? 'suite.passed' : 'suite.failed',
    project: { id: row.project.id, name: row.project.name },
    suite: {
      id: row.suite.id,
      status: row.suite.status,
      trigger: row.suite.trigger,
      environment: environmentOf({
        environmentId: row.suite.environmentId,
        environmentName: row.suite.environmentName,
        baseUrl: row.suite.baseUrl,
        fallbackName: row.environmentName,
      }),
      counts: {
        total: row.suite.totalCount,
        passed: row.suite.passedCount,
        failed: row.suite.failedCount,
        error: row.suite.errorCount,
      },
      failures: failures.map((failure) => ({
        id: failure.id,
        status: failure.status,
        test: { id: failure.intentId, title: failure.title },
        errorMessage: failure.errorMessage,
        url: url(origin, `/projects/${row.project.id}/runs/${failure.id}`),
      })),
      startedAt: row.suite.startedAt.toISOString(),
      finishedAt: row.suite.finishedAt?.toISOString() ?? null,
      url: url(origin, `/projects/${row.project.id}?tab=runs`),
      reportUrl: url(origin, `/api/reports/suites/${row.suite.id}`),
    },
  }
}

export async function buildRepairEvent(
  db: Db,
  jobId: string,
  origin: string,
): Promise<NotificationEvent | null> {
  const [row] = await db
    .select({
      job: generationJob,
      project,
      intent,
      environmentName: environment.name,
      baseUrl: environment.baseUrl,
    })
    .from(generationJob)
    .innerJoin(project, eq(project.id, generationJob.projectId))
    .innerJoin(intent, eq(intent.id, generationJob.intentId))
    .innerJoin(environment, eq(environment.id, generationJob.environmentId))
    .where(and(eq(generationJob.id, jobId), eq(generationJob.kind, 'repair')))
    .limit(1)
  if (!row || (row.job.status !== 'succeeded' && row.job.status !== 'failed')) return null

  const [version] = row.job.scriptVersionId
    ? await db
        .select({ version: scriptVersion.version, note: scriptVersion.note })
        .from(scriptVersion)
        .where(eq(scriptVersion.id, row.job.scriptVersionId))
        .limit(1)
    : []

  const [source] = row.job.sourceRunId
    ? await db
        .select({ healApplied: attempt.healApplied })
        .from(attempt)
        .where(eq(attempt.runId, row.job.sourceRunId))
        .orderBy(desc(attempt.attemptNumber))
        .limit(1)
    : []

  const adopted = source?.healApplied?.adopted === true
  const type: NotificationEventType =
    row.job.status === 'failed' ? 'repair.failed' : adopted ? 'repair.adopted' : 'repair.pending'

  return {
    type,
    project: { id: row.project.id, name: row.project.name },
    repair: {
      jobId: row.job.id,
      status: row.job.status,
      adopted,
      test: { id: row.intent.id, title: row.intent.title },
      environment: { id: row.job.environmentId, name: row.environmentName, baseUrl: row.baseUrl },
      version: version?.version ?? null,
      whatFailed: source?.healApplied?.whatFailed ?? null,
      reason: row.job.stuckReason,
      sourceRun: row.job.sourceRunId
        ? {
            id: row.job.sourceRunId,
            url: url(origin, `/projects/${row.project.id}/runs/${row.job.sourceRunId}`),
          }
        : null,
      url: url(origin, `/projects/${row.project.id}/intents/${row.intent.id}`),
    },
  }
}

async function post(target: string, body: string, headers: Record<string, string>) {
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Flaremender/1', ...headers },
    body,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  })
  return response
}

async function deliverOnce(
  env: Cloudflare.Env,
  destination: Destination,
  event: NotificationEvent,
  deliveryId: string,
): Promise<{ responseStatus: number | null; error: string | null }> {
  const occurredAt = new Date().toISOString()

  if (destination.kind === 'email') {
    const mailer = env.EMAIL
    if (!mailer) {
      return {
        responseStatus: null,
        error:
          'Email is not enabled on this instance: add the send_email binding and NOTIFY_FROM_ADDRESS. See docs/notifications.md.',
      }
    }
    const from = env.NOTIFY_FROM_ADDRESS
    if (!from) {
      return {
        responseStatus: null,
        error: 'NOTIFY_FROM_ADDRESS is not set, so there is no sender address.',
      }
    }
    const message = emailBody(event)
    await mailer.send({
      to: destination.target,
      from: { email: from, name: 'Flaremender' },
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: { 'X-Flaremender-Event': event.type, 'X-Flaremender-Delivery': deliveryId },
    })
    return { responseStatus: null, error: null }
  }

  const body =
    destination.kind === 'slack'
      ? slackBody(event)
      : destination.kind === 'discord'
        ? discordBody(event)
        : JSON.stringify({ schemaVersion: 1, deliveryId, occurredAt, ...event })

  const headers: Record<string, string> = {
    'X-Flaremender-Event': event.type,
    'X-Flaremender-Delivery': deliveryId,
  }
  if (destination.kind === 'webhook' && destination.encryptedSecret) {
    headers['X-Flaremender-Signature'] = await signPayload(
      await decryptSecret(destination.encryptedSecret),
      body,
    )
  }

  const response = await post(destination.target, body, headers)
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200)
    return {
      responseStatus: response.status,
      error: `${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
    }
  }
  return { responseStatus: response.status, error: null }
}

export function deliver(
  env: Cloudflare.Env,
  destination: Destination,
  event: NotificationEvent,
  subjectId: string,
): Promise<DeliveryOutcome> {
  return span(
    'notify.deliver',
    {
      'destination.kind': destination.kind,
      'destination.id': destination.id,
      'event.type': event.type,
    },
    async (set) => {
      const outcome = await deliverWithRetries(env, destination, event, subjectId)
      set({
        'delivery.status': outcome.status,
        'delivery.response_status': outcome.responseStatus,
        'delivery.error': outcome.error,
      })
      return outcome
    },
  )
}

async function deliverWithRetries(
  env: Cloudflare.Env,
  destination: Destination,
  event: NotificationEvent,
  subjectId: string,
): Promise<DeliveryOutcome> {
  const db = createDb(env.DB)
  const deliveryId = createId('dlv')

  let last: { responseStatus: number | null; error: string | null } = {
    responseStatus: null,
    error: 'not attempted',
  }
  for (let attemptNumber = 1; attemptNumber <= ATTEMPTS; attemptNumber += 1) {
    try {
      last = await deliverOnce(env, destination, event, deliveryId)
    } catch (error) {
      last = { responseStatus: null, error: error instanceof Error ? error.message : String(error) }
    }
    if (last.error === null) break
    // A configuration problem will not fix itself in three seconds.
    if (last.responseStatus === null && /not enabled|not set/.test(last.error)) break
    if (attemptNumber < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 3000))
  }

  const status = last.error === null ? 'delivered' : 'failed'
  await db.batch([
    db.insert(notificationDelivery).values({
      id: deliveryId,
      destinationId: destination.id,
      event: event.type,
      subjectId,
      status,
      responseStatus: last.responseStatus,
      error: last.error,
    }),
    db
      .update(notificationDestination)
      .set({ lastDeliveryAt: new Date(), lastDeliveryStatus: status })
      .where(eq(notificationDestination.id, destination.id)),
    // Keep the log short; the newest hundred per destination is plenty to debug with.
    db
      .delete(notificationDelivery)
      .where(
        and(
          eq(notificationDelivery.destinationId, destination.id),
          sql`${notificationDelivery.id} not in (select id from notification_delivery where destination_id = ${destination.id} order by created_at desc limit ${KEEP_DELIVERIES})`,
        ),
      ),
  ])

  return {
    destinationId: destination.id,
    status,
    responseStatus: last.responseStatus,
    error: last.error,
  }
}

async function destinationsFor(db: Db, projectId: string, type: NotificationEventType) {
  const rows = await db
    .select()
    .from(notificationDestination)
    .where(
      and(
        eq(notificationDestination.projectId, projectId),
        eq(notificationDestination.enabled, true),
      ),
    )
  return rows.filter((row) => row.events.some((name) => isNotificationEvent(name) && name === type))
}

async function fanOut(
  env: Cloudflare.Env,
  projectId: string,
  subjectId: string,
  build: (origin: string) => Promise<NotificationEvent | null>,
): Promise<Array<DeliveryOutcome>> {
  const db = createDb(env.DB)
  // Build once per origin: every destination remembers the origin it was created from,
  // which is the only way a Workflow knows what URL the dashboard lives at.
  const probe = await build('https://flaremender.invalid')
  if (!probe) return []
  const destinations = await destinationsFor(db, projectId, probe.type)
  if (destinations.length === 0) return []

  const outcomes: Array<DeliveryOutcome> = []
  const byOrigin = new Map<string, NotificationEvent>()
  for (const destination of destinations) {
    let event = byOrigin.get(destination.dashboardOrigin)
    if (!event) {
      event = (await build(destination.dashboardOrigin)) ?? probe
      byOrigin.set(destination.dashboardOrigin, event)
    }
    outcomes.push(await deliver(env, destination, event, subjectId))
  }
  return outcomes
}

/** Standalone runs only; a suite reports once for all its members. */
export async function notifyRun(
  env: Cloudflare.Env,
  runId: string,
): Promise<Array<DeliveryOutcome>> {
  const db = createDb(env.DB)
  const [row] = await db
    .select({ projectId: run.projectId, purpose: run.purpose, suiteRunId: run.suiteRunId })
    .from(run)
    .where(eq(run.id, runId))
    .limit(1)
  if (!row || row.purpose !== 'regression' || row.suiteRunId) return []
  return fanOut(env, row.projectId, runId, (origin) => buildRunEvent(db, runId, origin))
}

export async function notifySuite(
  env: Cloudflare.Env,
  suiteRunId: string,
): Promise<Array<DeliveryOutcome>> {
  const db = createDb(env.DB)
  const [row] = await db
    .select({ projectId: suiteRun.projectId })
    .from(suiteRun)
    .where(eq(suiteRun.id, suiteRunId))
    .limit(1)
  if (!row) return []
  return fanOut(env, row.projectId, suiteRunId, (origin) => buildSuiteEvent(db, suiteRunId, origin))
}

export async function notifyRepair(
  env: Cloudflare.Env,
  jobId: string,
): Promise<Array<DeliveryOutcome>> {
  const db = createDb(env.DB)
  const [row] = await db
    .select({ projectId: generationJob.projectId })
    .from(generationJob)
    .where(eq(generationJob.id, jobId))
    .limit(1)
  if (!row) return []
  return fanOut(env, row.projectId, jobId, (origin) => buildRepairEvent(db, jobId, origin))
}

/** Wraps a notify call so a workflow step records the outcome instead of failing. */
export async function notifyQuietly(
  label: string,
  work: () => Promise<Array<DeliveryOutcome>>,
): Promise<{ delivered: number; failed: number }> {
  try {
    const outcomes = await work()
    const failed = outcomes.filter((outcome) => outcome.status === 'failed')
    for (const outcome of failed) {
      console.warn(`[notify] ${label} → ${outcome.destinationId}: ${outcome.error}`)
    }
    return { delivered: outcomes.length - failed.length, failed: failed.length }
  } catch (error) {
    console.error(`[notify] ${label} could not fan out:`, error)
    return { delivered: 0, failed: 0 }
  }
}
