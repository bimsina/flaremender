/**
 * The artifact read path.
 *
 * Screenshots and traces are bytes, not JSON, so they are served by a route
 * rather than a server function — but the authorisation is the same as
 * everywhere else: the session decides the organization, and the organization
 * decides which runs exist. A key is only served once the run it claims to
 * belong to resolves inside the caller's organization *and* the key sits under
 * that run's recorded prefix, so a guessed or edited path resolves to a 404
 * rather than to another tenant's screenshot.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { createDb } from '#/db/index.ts'
import { contentTypeForKey, runIdFromKey } from '#/engine/runner/artifacts.ts'
import { readSession } from '#/server/auth.ts'
import { loadRun } from '#/server/scope.ts'

const ROUTE_PREFIX = '/api/artifacts/'

/** Deliberately indistinguishable from "does not exist". */
function notFound(): Response {
  return new Response('Not found', { status: 404 })
}

async function handler({ request }: { request: Request }) {
  const session = await readSession()
  if (!session?.user) return new Response('Unauthorized', { status: 401 })

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) return new Response('Select an organization first.', { status: 403 })

  const { pathname } = new URL(request.url)
  if (!pathname.startsWith(ROUTE_PREFIX)) return notFound()

  const key = decodeURIComponent(pathname.slice(ROUTE_PREFIX.length))
  const runId = runIdFromKey(key)
  if (!runId) return notFound()

  let prefix: string | null
  try {
    const scoped = await loadRun(createDb(env.DB), organizationId, runId)
    prefix = scoped.run.artifactPrefix
  } catch {
    return notFound()
  }

  if (!prefix || !key.startsWith(prefix)) return notFound()

  const object = await env.ARTIFACTS.get(key)
  if (!object) return notFound()

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? contentTypeForKey(key),
      'Content-Length': String(object.size),
      // Artifacts are written once and never rewritten, but they are also
      // tenant data — no shared cache may hold a copy.
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: object.httpEtag,
    },
  })
}

export const Route = createFileRoute('/api/artifacts/$')({
  server: { handlers: { GET: handler } },
})
