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
 *
 * There is a second door, for one caller that cannot use the first. The
 * Playwright trace viewer is a page on trace.playwright.dev that fetches the
 * trace zip itself, cross-origin, where our cookie does not travel — so a
 * request carrying a valid, unexpired signature over this exact key is served
 * instead, with the CORS headers that let that one origin read the response.
 * The signature is minted by `getSignedArtifactUrl`, which does the ordinary
 * org check before it signs anything; it names one object and expires in ten
 * minutes, so it is never a substitute for a session.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { createDb } from '#/db/index.ts'
import { contentTypeForKey, runIdFromKey } from '#/engine/runner/artifacts.ts'
import { readSession } from '#/server/auth.ts'
import { loadRun } from '#/server/scope.ts'
import { verifyArtifactSignature } from '#/server/sign.ts'

const ROUTE_PREFIX = '/api/artifacts/'

/** The only origin allowed to read a signed artifact cross-origin. */
const TRACE_VIEWER_ORIGIN = 'https://trace.playwright.dev'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': TRACE_VIEWER_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type, ETag',
  'Access-Control-Max-Age': '600',
  // The response body differs by whether the request was signed, and a shared
  // cache keyed only on the path would serve one answer to the other caller.
  Vary: 'Origin',
}

/** Deliberately indistinguishable from "does not exist". */
function notFound(): Response {
  return new Response('Not found', { status: 404 })
}

function stream(object: R2ObjectBody, key: string, cors: boolean): Response {
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? contentTypeForKey(key),
      'Content-Length': String(object.size),
      // Artifacts are written once and never rewritten, but they are also
      // tenant data — no shared cache may hold a copy.
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: object.httpEtag,
      ...(cors ? CORS_HEADERS : {}),
    },
  })
}

/** The key this request is asking for, or null if the path is not one of ours. */
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
    // A signature is a complete answer on its own: it was minted after the org
    // check and it names this exact object, so there is nothing left to look up.
    let signed = false
    try {
      signed = await verifyArtifactSignature(key, exp, sig)
    } catch {
      // Only reachable when ENCRYPTION_KEY is missing, which is a server
      // problem rather than a caller's — but the caller still gets nothing.
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

/**
 * The preflight the trace viewer sends before its `fetch`. It discloses
 * nothing, so it does not check the signature — the GET that follows does.
 */
function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

export const Route = createFileRoute('/api/artifacts/$')({
  server: { handlers: { GET: handler, OPTIONS: preflight } },
})
