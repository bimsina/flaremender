import { createFileRoute } from '@tanstack/react-router'

import { readWebhookReport, webhookErrorResponse } from '#/server/webhooks.ts'

export const Route = createFileRoute('/api/v1/executions/$executionId/report')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          return await readWebhookReport(request, params.executionId)
        } catch (error) {
          return webhookErrorResponse(error)
        }
      },
    },
  },
})
