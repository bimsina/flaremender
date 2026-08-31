import { AuthError } from './auth-error.ts'
export { AuthError } from './auth-error.ts'
import { env } from 'cloudflare:workers'
import { createMiddleware, createServerOnlyFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import { createDb } from '#/db/index.ts'
import { createAuth } from '#/lib/auth.ts'

export const getAuth = createServerOnlyFn(() => createAuth(env.DB, env))

export const getDb = createServerOnlyFn(() => createDb(env.DB))

export const readSession = createServerOnlyFn(() =>
  getAuth().api.getSession({ headers: getRequest().headers }),
)

export const authMiddleware = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const result = await readSession()
  if (!result?.user) throw new AuthError('You must be signed in.', 401)

  return next({ context: { db: getDb(), user: result.user, session: result.session } })
})

/** Never accept the active organization ID from client input. */
export const orgMiddleware = createMiddleware({ type: 'function' })
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    const organizationId = context.session.activeOrganizationId
    if (!organizationId) throw new AuthError('Select or create an organization first.', 400)
    return next({ context: { organizationId } })
  })

export const adminMiddleware = createMiddleware({ type: 'function' })
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    if (context.user.role !== 'admin') throw new AuthError('Admins only.', 403)
    return next({ context: {} })
  })
