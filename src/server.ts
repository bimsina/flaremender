/**
 * Custom Worker entry.
 *
 * TanStack Start's default entry (`@tanstack/react-start/server-entry`) still
 * serves every request; this file only exists so the Workflow and Durable
 * Object classes are named exports of the deployed Worker, which is how the
 * runtime finds the classes referenced from `wrangler.jsonc`.
 */
import handler from '@tanstack/react-start/server-entry'

export { RunChannel } from '#/engine/run-channel.ts'
export { RunWorkflow } from '#/engine/run-workflow.ts'

export default {
  fetch(request) {
    // Start reads its bindings from `cloudflare:workers`, and its second
    // parameter is request options rather than `env`, so nothing is forwarded.
    return handler.fetch(request)
  },
} satisfies ExportedHandler<Cloudflare.Env>
