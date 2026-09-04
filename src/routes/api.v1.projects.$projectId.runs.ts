import { createFileRoute } from '@tanstack/react-router'

import { triggerProjectWebhook, webhookErrorResponse } from '#/server/webhooks.ts'

export const Route = createFileRoute('/api/v1/projects/$projectId/runs')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          return await triggerProjectWebhook(request, params.projectId)
        } catch (error) {
          return webhookErrorResponse(error)
        }
      },
    },
  },
})
