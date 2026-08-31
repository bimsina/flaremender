import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { devOnly } from '#/routes/api/spike/-dev-only.ts'

const DYNAMIC_MODULE = `
export default {
  fetch(request, env) {
    const deep = new URL(request.url).searchParams.get('browser') === '1'
    const browser = env.BROWSER

    // (a) prove the dynamic Worker actually ran code.
    let sum = 0
    for (let i = 1; i <= 100; i++) sum += i

    // (b) prove the BROWSER binding crossed the boundary.
    const introspection = {
      typeofBinding: typeof browser,
      truthy: Boolean(browser),
      hasFetch: Boolean(browser) && typeof browser.fetch === 'function',
    }

    if (deep && browser) {
      introspection.constructorName = browser.constructor ? browser.constructor.name : null
      introspection.ownKeys = Object.keys(browser)
      introspection.prototypeKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(browser))
    }

    // (c) hand the result back over the fetch boundary.
    return Response.json({
      executed: true,
      mode: deep ? 'browser-introspection' : 'basic',
      sumOneToHundred: sum,
      hostMessage: env.HOST_MESSAGE,
      envKeys: Object.keys(env).sort(),
      browser: introspection,
    })
  },
}
`

async function handler({ request }: { request: Request }) {
  const blocked = devOnly()
  if (blocked) return blocked

  const deep = new URL(request.url).searchParams.get('browser') === '1'
  const startedAt = Date.now()

  try {
    const worker = env.LOADER.load({
      compatibilityDate: '2025-09-02',
      mainModule: 'index.js',
      modules: { 'index.js': DYNAMIC_MODULE },
      env: {
        BROWSER: env.BROWSER,
        HOST_MESSAGE: 'passed through from the host worker',
      },
      globalOutbound: null,
    })

    const response = await worker
      .getEntrypoint()
      .fetch(`https://dynamic-worker.invalid/?browser=${deep ? '1' : '0'}`)
    const result = await response.json()

    return Response.json({
      ok: response.ok,
      dynamicWorkerStatus: response.status,
      result,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: String(error),
        stack: error instanceof Error ? error.stack : null,
        durationMs: Date.now() - startedAt,
      },
      { status: 500 },
    )
  }
}

export const Route = createFileRoute('/api/spike/loader/')({
  server: { handlers: { GET: handler } },
})
