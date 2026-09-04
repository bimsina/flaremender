import { createFileRoute } from '@tanstack/react-router'

import { triggerTestWebhook, webhookErrorResponse } from '#/server/webhooks.ts'

export const Route = createFileRoute('/api/v1/projects/$projectId/tests/$testId/runs')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          return await triggerTestWebhook(request, params.projectId, params.testId)
        } catch (error) {
          return webhookErrorResponse(error)
        }
      },
    },
  },
})
