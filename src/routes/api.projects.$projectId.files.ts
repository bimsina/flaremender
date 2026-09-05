import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { sessionPrincipal } from '#/server/api-tests.ts'
import { getDb } from '#/server/auth.ts'
import { storeProjectFile } from '#/server/files.ts'
import { assertProject } from '#/server/scope.ts'
import { ValidationError } from '#/server/validate.ts'
import { WebhookApiError, webhookErrorResponse } from '#/server/webhooks.ts'

/** Multipart upload of one or more files into a project, from the dashboard. */
export const Route = createFileRoute('/api/projects/$projectId/files')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const db = getDb()
          const principal = await sessionPrincipal(request, db)
          await assertProject(db, principal.organizationId, params.projectId).catch(() => {
            throw new WebhookApiError('NOT_FOUND', 'Project not found.', 404)
          })

          const form = await request.formData()
          const files = form.getAll('file').filter((item): item is File => item instanceof File)
          if (files.length === 0) {
            throw new WebhookApiError('INVALID_BODY', 'Attach at least one file as "file".', 400)
          }

          const stored = []
          for (const file of files) {
            try {
              stored.push(
                await storeProjectFile(env, db, {
                  organizationId: principal.organizationId,
                  projectId: params.projectId,
                  userId: principal.userId,
                  name: file.name,
                  contentType: file.type || 'application/octet-stream',
                  bytes: await file.arrayBuffer(),
                }),
              )
            } catch (error) {
              if (error instanceof ValidationError) {
                throw new WebhookApiError('INVALID_FILE', error.message, 400)
              }
              throw error
            }
          }

          return Response.json({ schemaVersion: 1, files: stored }, { status: 201 })
        } catch (error) {
          return webhookErrorResponse(error)
        }
      },
    },
  },
})
