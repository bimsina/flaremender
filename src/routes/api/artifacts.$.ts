import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { createDb } from '#/db/index.ts'
import { contentTypeForKey, runIdFromKey } from '#/engine/runner/artifacts.ts'
import { readSession } from '#/server/auth.ts'
import { loadRun } from '#/server/scope.ts'
import { verifyArtifactSignature } from '#/server/sign.ts'

const ROUTE_PREFIX = '/api/artifacts/'

const TRACE_VIEWER_ORIGIN = 'https://trace.playwright.dev'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': TRACE_VIEWER_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type, ETag',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
}

function notFound(): Response {
  return new Response('Not found', { status: 404 })
}

function stream(object: R2ObjectBody, key: string, cors: boolean): Response {
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? contentTypeForKey(key),
      'Content-Length': String(object.size),
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: object.httpEtag,
      ...(cors ? CORS_HEADERS : {}),
    },
  })
}

function keyFor(request: Request): string | null {
  const { pathname } = new URL(request.url)
  if (!pathname.startsWith(ROUTE_PREFIX)) return null

  const key = decodeURIComponent(pathname.slice(ROUTE_PREFIX.length))
  return runIdFromKey(key) === null ? null : key
}

async function handler({ request }: { request: Request }) {
  const key = keyFor(request)
  if (key === null) return notFound()

  const { searchParams } = new URL(request.url)
  const exp = searchParams.get('exp')
  const sig = searchParams.get('sig')

  if (exp !== null && sig !== null) {
    let signed = false
    try {
      signed = await verifyArtifactSignature(key, exp, sig)
    } catch {
      signed = false
    }

    if (!signed) {
      return new Response('This link has expired.', { status: 403, headers: CORS_HEADERS })
    }

    const object = await env.ARTIFACTS.get(key)
    if (!object) return new Response('Not found', { status: 404, headers: CORS_HEADERS })

    return stream(object, key, true)
  }

  const session = await readSession()
  if (!session?.user) return new Response('Unauthorized', { status: 401 })

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) return new Response('Select an organization first.', { status: 403 })

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

  return stream(object, key, false)
}

function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

export const Route = createFileRoute('/api/artifacts/$')({
  server: { handlers: { GET: handler, OPTIONS: preflight } },
})
