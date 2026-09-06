import { createFileRoute } from '@tanstack/react-router'

import { generateTestApi } from '#/server/api/api-tests.ts'
import { webhookErrorResponse } from '#/server/api/webhooks.ts'

export const Route = createFileRoute('/api/v1/projects/$projectId/tests/$testId/generate')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          return await generateTestApi(request, params.projectId, params.testId)
        } catch (error) {
          return webhookErrorResponse(error)
        }
      },
    },
  },
})
