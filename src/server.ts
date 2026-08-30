/**
 * Custom Worker entry.
 *
 * TanStack Start's default entry (`@tanstack/react-start/server-entry`) serves
 * every request but one. This file exists for two reasons: so the Workflow and
 * Durable Object classes are named exports of the deployed Worker, which is how
 * the runtime finds the classes referenced from `wrangler.jsonc`, and so a
 * WebSocket upgrade can be answered before Start's router ever sees it — a 101
 * response is not something a route handler can return.
 */
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import handler from '@tanstack/react-start/server-entry'

import { generationJob, project, run } from '#/db/schema/app.ts'
import { sweepRetention } from '#/engine/retention.ts'
import { dispatchSchedules } from '#/engine/schedule-dispatch.ts'
import { createAuth } from '#/lib/auth.ts'

export { GenerateWorkflow } from '#/engine/generate-workflow.ts'
export { RunChannel } from '#/engine/run-channel.ts'
export { RunWorkflow } from '#/engine/run-workflow.ts'
export { SuiteWorkflow } from '#/engine/suite-workflow.ts'

const LIVE_PATH = /^\/api\/runs\/([^/]+)\/live\/?$/

/**
 * Generation jobs stream through the same path as runs, and are told apart by
 * their id. One socket route, one client, one Durable Object class: the only
 * thing that differs between watching a run and watching a script being written
 * is which table proves the caller is allowed to.
 */
const GENERATION_ID = /^gen_/

/**
 * The nightly branch of `triggers.crons`. Every other cron this Worker is given
 * is the minute tick, which is also what an unnamed trigger falls through to —
 * `wrangler`'s local scheduled endpoint sends no `cron` at all, and dispatching
 * schedules is the useful thing to do with an anonymous tick.
 */
const RETENTION_CRON = '30 3 * * *'

/** Deliberately indistinguishable from "that run does not exist". */
function notFound(): Response {
  return new Response('Not found', { status: 404 })
}

/**
 * The live progress socket.
 *
 * Everything the `RunChannel` knows about a run is readable to whoever holds one
 * of its sockets, so the whole tenant check happens here, once, before the
 * upgrade is forwarded: signed in, in an organization, and that organization
 * owns the run. The Durable Object itself trusts its caller completely, which is
 * only safe because this is the sole path to it.
 *
 * The query is written out longhand rather than reusing `server/scope.ts`: this
 * runs on the hot path of every upgrade and wants nothing but D1.
 */
async function serveLive(
  request: Request,
  env: Cloudflare.Env,
  channelId: string,
): Promise<Response> {
  const session = await createAuth(env.DB, env).api.getSession({ headers: request.headers })
  if (!session?.user) return new Response('Unauthorized', { status: 401 })

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) return notFound()

  const db = drizzle(env.DB)

  const [row] = GENERATION_ID.test(channelId)
    ? await db
        .select({ id: generationJob.id })
        .from(generationJob)
        .innerJoin(project, eq(project.id, generationJob.projectId))
        .where(and(eq(generationJob.id, channelId), eq(project.organizationId, organizationId)))
        .limit(1)
    : await db
        .select({ id: run.id })
        .from(run)
        .innerJoin(project, eq(project.id, run.projectId))
        .where(and(eq(run.id, channelId), eq(project.organizationId, organizationId)))
        .limit(1)

  if (!row) return notFound()

  return env.RUN_CHANNEL.getByName(channelId).fetch(request)
}

export default {
  fetch(request, env) {
    // Only an actual upgrade is intercepted; a plain GET of the same path is
    // left to Start, which has no route for it and says so.
    if (request.method === 'GET' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const channelId = LIVE_PATH.exec(new URL(request.url).pathname)?.[1]
      if (channelId) return serveLive(request, env, decodeURIComponent(channelId))
    }

    // Start reads its bindings from `cloudflare:workers`, and its second
    // parameter is request options rather than `env`, so nothing is forwarded.
    return handler.fetch(request)
  },

  /**
   * The clock.
   *
   * Two triggers, one handler, and no logic of its own beyond telling them
   * apart: the minute tick asks `schedule-dispatch` which intents are due, and
   * the nightly one asks `retention` to trim what has accumulated. Both are
   * awaited outright — a scheduled handler may take as long as the work does,
   * and `waitUntil` would only make it possible for the invocation to end
   * halfway through a sweep.
   */
  async scheduled(controller, env) {
    if (controller.cron === RETENTION_CRON) {
      await sweepRetention(env)
      return
    }

    await dispatchSchedules(env, controller.scheduledTime)
  },
} satisfies ExportedHandler<Cloudflare.Env>
