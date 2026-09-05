/**
 * The consent page for the MCP server's OAuth flow. An MCP client (Claude, Cursor,
 * an agent) sends the person here; they sign in with their normal Flaremender
 * account, pick which organization the connection may act in, and approve. The
 * OAuth provider then issues the client a token that carries that choice.
 */
import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { asc, eq } from 'drizzle-orm'

import { createDb } from '#/db/index.ts'
import { member, organization } from '#/db/schema/auth.ts'
import { createAuth } from '#/lib/auth.ts'
import { MCP_SCOPES, type McpProps, type McpScope, SCOPE_DESCRIPTIONS } from './server.ts'

export const AUTHORIZE_PATH = '/oauth/authorize'
export const TOKEN_PATH = '/oauth/token'
export const REGISTER_PATH = '/oauth/register'

const CSRF_COOKIE = 'flaremender_oauth_csrf'
const CSRF_TTL_SECONDS = 600

type EnvWithOAuth = Cloudflare.Env & { OAUTH_PROVIDER: OAuthHelpers }

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function httpUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

function csrfCookie(request: Request, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${CSRF_COOKIE}=${value}; HttpOnly; Path=${AUTHORIZE_PATH}; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

function grantedScopes(requested: Array<string>): Array<McpScope> {
  const known = requested.filter((scope): scope is McpScope =>
    (MCP_SCOPES as readonly string[]).includes(scope),
  )
  // A client that asks for nothing in particular gets the full connection; the
  // person sees exactly what that means on the consent page.
  return known.length > 0 ? known : [...MCP_SCOPES]
}

function page(title: string, body: string, status = 200, headers: HeadersInit = {}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)} · Flaremender</title>
<style>
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #f6f8fa; --card: #fff; --line: #d1d9e0; --accent: #f6821f; --accent-fg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --bg: #0d1117; --card: #161b22; --line: #30363d; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
  main { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { margin: 0 0 16px; color: var(--muted); }
  .client { display: flex; gap: 12px; align-items: center; margin: 20px 0; }
  .client img { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; }
  .client strong { display: block; color: var(--fg); }
  .client a { color: var(--muted); font-size: 13px; }
  ul { list-style: none; padding: 0; margin: 0 0 20px; border: 1px solid var(--line); border-radius: 8px; }
  li { padding: 10px 14px; border-top: 1px solid var(--line); }
  li:first-child { border-top: 0; }
  li code { font-size: 12px; color: var(--muted); }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  select { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); font: inherit; margin-bottom: 20px; }
  .actions { display: flex; gap: 10px; justify-content: flex-end; }
  button { font: inherit; font-weight: 600; padding: 10px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .who { font-size: 13px; color: var(--muted); margin-top: 20px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src https: http:; form-action 'self'",
      ...headers,
    },
  })
}

function denied(authRequest: AuthRequest, description: string): Response {
  const redirect = new URL(authRequest.redirectUri)
  redirect.searchParams.set('error', 'access_denied')
  redirect.searchParams.set('error_description', description)
  if (authRequest.state) redirect.searchParams.set('state', authRequest.state)
  if (authRequest.issuer) redirect.searchParams.set('iss', authRequest.issuer)
  return Response.redirect(redirect.toString(), 302)
}

function authorizationFailed(error: unknown): Response {
  if (!(error instanceof AuthorizationError)) throw error
  if (!error.redirectUri) {
    return page(
      'Connection refused',
      `<h1>This connection request is not valid</h1><p>${escape(error.description)}</p>`,
      400,
    )
  }
  const redirect = new URL(error.redirectUri)
  redirect.searchParams.set('error', error.code)
  redirect.searchParams.set('error_description', error.description)
  if (error.state) redirect.searchParams.set('state', error.state)
  if (error.issuer) redirect.searchParams.set('iss', error.issuer)
  return Response.redirect(redirect.toString(), 302)
}

async function signedInUser(request: Request, env: Cloudflare.Env) {
  const session = await createAuth(env.DB, env).api.getSession({ headers: request.headers })
  return session?.user ?? null
}

function toSignIn(request: Request): Response {
  const url = new URL(request.url)
  const signIn = new URL('/signin', url.origin)
  signIn.searchParams.set('redirect', `${url.pathname}${url.search}`)
  return Response.redirect(signIn.toString(), 302)
}

async function membershipsOf(env: Cloudflare.Env, userId: string) {
  return createDb(env.DB)
    .select({ id: organization.id, name: organization.name })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(asc(organization.name))
}

function consentPage(input: {
  request: Request
  client: ClientInfo
  scopes: Array<McpScope>
  organizations: Array<{ id: string; name: string }>
  user: { email: string; name: string | null }
  csrf: string
}): Response {
  const { request, client, scopes, organizations, user } = input
  const logo = httpUrl(client.logoUri)
  const site = httpUrl(client.clientUri)
  const name = escape(client.clientName || 'An MCP client')
  const query = new URL(request.url).search

  const orgOptions = organizations
    .map((org) => `<option value="${escape(org.id)}">${escape(org.name)}</option>`)
    .join('')

  const body = `
<h1>Connect to Flaremender</h1>
<p>An AI assistant wants to use Flaremender on your behalf.</p>
<div class="client">
  ${logo ? `<img src="${escape(logo)}" alt="">` : ''}
  <div><strong>${name}</strong>${site ? `<a href="${escape(site)}" rel="noopener noreferrer">${escape(new URL(site).host)}</a>` : ''}</div>
</div>
<ul>
  ${scopes.map((scope) => `<li>${escape(SCOPE_DESCRIPTIONS[scope])} <code>${scope}</code></li>`).join('')}
</ul>
<form method="post" action="${AUTHORIZE_PATH}${escape(query)}">
  <input type="hidden" name="csrf" value="${escape(input.csrf)}">
  <label for="organizationId">Act in organization</label>
  <select id="organizationId" name="organizationId" required>${orgOptions}</select>
  <div class="actions">
    <button type="submit" name="decision" value="deny">Cancel</button>
    <button type="submit" name="decision" value="allow" class="primary">Allow</button>
  </div>
</form>
<div class="who">Signed in as ${escape(user.name || user.email)}. The assistant will act as you, within the organization you pick, until you revoke it.</div>`

  return page('Connect to Flaremender', body, 200, {
    'set-cookie': csrfCookie(request, input.csrf, CSRF_TTL_SECONDS),
  })
}

export async function handleAuthorize(request: Request, env: EnvWithOAuth): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } })
  }

  let authRequest: AuthRequest
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request)
  } catch (error) {
    return authorizationFailed(error)
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId)
  if (!client) {
    return page(
      'Connection refused',
      '<h1>Unknown client</h1><p>This MCP client is not registered.</p>',
      400,
    )
  }

  const user = await signedInUser(request, env)
  if (!user) return toSignIn(request)

  const organizations = await membershipsOf(env, user.id)
  if (organizations.length === 0) {
    return page(
      'No organization',
      '<h1>Nothing to connect to yet</h1><p>Your account is not a member of any organization. Create one in Flaremender first, then try again.</p>',
      403,
    )
  }

  const scopes = grantedScopes(authRequest.scope)

  if (request.method === 'GET') {
    return consentPage({
      request,
      client,
      scopes,
      organizations,
      user: { email: user.email, name: user.name },
      csrf: crypto.randomUUID(),
    })
  }

  const form = await request.formData()
  const csrf = form.get('csrf')
  if (typeof csrf !== 'string' || !csrf || csrf !== cookieValue(request, CSRF_COOKIE)) {
    return page(
      'Try again',
      '<h1>That page had expired</h1><p>Go back to your assistant and start the connection again.</p>',
      400,
      { 'set-cookie': csrfCookie(request, '', 0) },
    )
  }

  if (form.get('decision') !== 'allow') {
    return denied(authRequest, 'The user declined the connection.')
  }

  const organizationId = form.get('organizationId')
  const chosen = organizations.find((org) => org.id === organizationId)
  if (!chosen) {
    return page('Try again', '<h1>Pick an organization you belong to</h1>', 400)
  }

  const props: McpProps = {
    userId: user.id,
    organizationId: chosen.id,
    organizationName: chosen.name,
    scopes,
    origin: new URL(request.url).origin,
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: user.id,
    metadata: { clientName: client.clientName ?? null, organizationId: chosen.id },
    scope: scopes,
    props,
  })

  return new Response(null, {
    status: 302,
    headers: { location: redirectTo, 'set-cookie': csrfCookie(request, '', 0) },
  })
}
