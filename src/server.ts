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

import { project, run } from '#/db/schema/app.ts'
import { createAuth } from '#/lib/auth.ts'

export { RunChannel } from '#/engine/run-channel.ts'
export { RunWorkflow } from '#/engine/run-workflow.ts'
export { SuiteWorkflow } from '#/engine/suite-workflow.ts'

const LIVE_PATH = /^\/api\/runs\/([^/]+)\/live\/?$/

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
async function serveLive(request: Request, env: Cloudflare.Env, runId: string): Promise<Response> {
  const session = await createAuth(env.DB, env).api.getSession({ headers: request.headers })
  if (!session?.user) return new Response('Unauthorized', { status: 401 })

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) return notFound()

  const db = drizzle(env.DB)
  const [row] = await db
    .select({ id: run.id })
    .from(run)
    .innerJoin(project, eq(project.id, run.projectId))
    .where(and(eq(run.id, runId), eq(project.organizationId, organizationId)))
    .limit(1)

  if (!row) return notFound()

  return env.RUN_CHANNEL.getByName(runId).fetch(request)
}

export default {
  fetch(request, env) {
    // Only an actual upgrade is intercepted; a plain GET of the same path is
    // left to Start, which has no route for it and says so.
    if (request.method === 'GET' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const runId = LIVE_PATH.exec(new URL(request.url).pathname)?.[1]
      if (runId) return serveLive(request, env, decodeURIComponent(runId))
    }

    // Start reads its bindings from `cloudflare:workers`, and its second
    // parameter is request options rather than `env`, so nothing is forwarded.
    return handler.fetch(request)
  },
} satisfies ExportedHandler<Cloudflare.Env>
