import { createFileRoute } from '@tanstack/react-router'

import { readJobApi } from '#/server/api/api-tests.ts'
import { webhookErrorResponse } from '#/server/api/webhooks.ts'

export const Route = createFileRoute('/api/v1/jobs/$jobId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          return await readJobApi(request, params.jobId)
        } catch (error) {
          return webhookErrorResponse(error)
        }
      },
    },
  },
})
