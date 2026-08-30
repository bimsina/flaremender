/**
 * Spike: create an instance of the Workflow exported from `src/server.ts`.
 * Poll `/api/spike/workflow-status?id=…` for the step output. Dev only.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { devOnly } from '#/routes/api/spike/-dev-only.ts'

async function handler() {
  const blocked = devOnly()
  if (blocked) return blocked

  try {
    const instance = await env.RUN_WORKFLOW.create({
      id: crypto.randomUUID(),
      params: { runId: 'spike' },
    })

    return Response.json({ ok: true, id: instance.id, status: await instance.status() })
  } catch (error) {
    return Response.json(
      { ok: false, error: String(error), stack: error instanceof Error ? error.stack : null },
      { status: 500 },
    )
  }
}

export const Route = createFileRoute('/api/spike/workflow')({
  server: { handlers: { GET: handler } },
})
