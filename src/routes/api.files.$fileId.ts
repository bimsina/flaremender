import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { and, eq } from 'drizzle-orm'

import { project, projectFile } from '#/db/schema/app.ts'
import { readSession } from '#/server/auth.ts'
import { createDb } from '#/db/index.ts'

/** Streams a project file back to a signed-in member of its organization. */
export const Route = createFileRoute('/api/files/$fileId')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const session = await readSession()
        const organizationId = session?.session.activeOrganizationId
        if (!session?.user || !organizationId) return new Response('Unauthorized', { status: 401 })

        const db = createDb(env.DB)
        const [row] = await db
          .select({
            key: projectFile.key,
            name: projectFile.name,
            contentType: projectFile.contentType,
          })
          .from(projectFile)
          .innerJoin(project, eq(project.id, projectFile.projectId))
          .where(and(eq(projectFile.id, params.fileId), eq(project.organizationId, organizationId)))
          .limit(1)
        if (!row) return new Response('Not found', { status: 404 })

        const object = await env.ARTIFACTS.get(row.key)
        if (!object) return new Response('Not found', { status: 404 })

        return new Response(object.body, {
          headers: {
            'Content-Type': row.contentType,
            'Content-Length': String(object.size),
            'Content-Disposition': `inline; filename="${row.name.replace(/"/g, '')}"`,
            'Cache-Control': 'private, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
          },
        })
      },
    },
  },
})
