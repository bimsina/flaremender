import { createFileRoute } from '@tanstack/react-router'

import { readWebhookExecution, webhookErrorResponse } from '#/server/webhooks.ts'

export const Route = createFileRoute('/api/v1/executions/$executionId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          return await readWebhookExecution(request, params.executionId)
        } catch (error) {
          return webhookErrorResponse(error)
        }
      },
    },
  },
})
