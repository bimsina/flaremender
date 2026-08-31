import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { devOnly } from '#/routes/api/spike/-dev-only.ts'

async function handler({ request }: { request: Request }) {
  const blocked = devOnly()
  if (blocked) return blocked

  const id = new URL(request.url).searchParams.get('id')
  if (!id) return Response.json({ ok: false, error: 'Pass ?id=<instance id>.' }, { status: 400 })

  try {
    const instance = await env.RUN_WORKFLOW.get(id)
    return Response.json({ ok: true, id, status: await instance.status() })
  } catch (error) {
    return Response.json(
      { ok: false, error: String(error), stack: error instanceof Error ? error.stack : null },
      { status: 500 },
    )
  }
}

export const Route = createFileRoute('/api/spike/workflow-status')({
  server: { handlers: { GET: handler } },
})
