import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import handler from '@tanstack/react-start/server-entry'

import { generationJob, project, run } from '#/db/schema/app.ts'
import { sweepRetention } from '#/engine/retention.ts'
import { dispatchSchedules } from '#/engine/schedule-dispatch.ts'
import { createAuth } from '#/lib/auth.ts'

export { BatchGenerateWorkflow } from '#/engine/batch-workflow.ts'
export { ExploreWorkflow } from '#/engine/explore-workflow.ts'
export { GenerateWorkflow } from '#/engine/generate-workflow.ts'
export { ProjectChat } from '#/engine/project-chat.ts'
export { RepairWorkflow } from '#/engine/repair-workflow.ts'
export { RunChannel } from '#/engine/run-channel.ts'
export { RunWorkflow } from '#/engine/run-workflow.ts'
export { SuiteWorkflow } from '#/engine/suite-workflow.ts'

const LIVE_PATH = /^\/api\/runs\/([^/]+)\/live\/?$/

const CHAT_PATH = /^\/api\/projects\/([^/]+)\/chat\/?$/

const JOB_ID = /^(gen|exp|bat|rep)_/

const RETENTION_CRON = '30 3 * * *'

function notFound(): Response {
  return new Response('Not found', { status: 404 })
}

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

  const [row] = JOB_ID.test(channelId)
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

async function serveChat(
  request: Request,
  env: Cloudflare.Env,
  projectId: string,
): Promise<Response> {
  const session = await createAuth(env.DB, env).api.getSession({ headers: request.headers })
  if (!session?.user) return new Response('Unauthorized', { status: 401 })

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) return notFound()

  const [row] = await drizzle(env.DB)
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.id, projectId), eq(project.organizationId, organizationId)))
    .limit(1)

  if (!row) return notFound()

  return env.PROJECT_CHAT.getByName(projectId).fetch(request)
}

export default {
  fetch(request, env) {
    if (request.method === 'GET' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const { pathname } = new URL(request.url)

      const channelId = LIVE_PATH.exec(pathname)?.[1]
      if (channelId) return serveLive(request, env, decodeURIComponent(channelId))

      const projectId = CHAT_PATH.exec(pathname)?.[1]
      if (projectId) return serveChat(request, env, decodeURIComponent(projectId))
    }

    return handler.fetch(request)
  },

  async scheduled(controller, env) {
    if (controller.cron === RETENTION_CRON) {
      await sweepRetention(env)
      return
    }

    await dispatchSchedules(env, controller.scheduledTime)
  },
} satisfies ExportedHandler<Cloudflare.Env>
