import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'

import { createAuth } from '#/lib/auth'

function handler({ request }: { request: Request }) {
  const auth = createAuth(env.DB, env)
  return auth.handler(request)
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
    },
  },
})
