import { createFileRoute } from '@tanstack/react-router'

import { createTestApi } from '#/server/api-tests.ts'
import { webhookErrorResponse } from '#/server/webhooks.ts'

export const Route = createFileRoute('/api/v1/projects/$projectId/tests')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          return await createTestApi(request, params.projectId)
        } catch (error) {
          return webhookErrorResponse(error)
        }
      },
    },
  },
})
