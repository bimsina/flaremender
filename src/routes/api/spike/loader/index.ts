/**
 * Spike: Dynamic Workers. Loads a code string with `env.LOADER.load()` and
 * proves two things at once — the dynamic Worker really executes, and a
 * BROWSER binding handed to it through the load options' `env` survives the
 * crossing.
 *
 * Actually driving Playwright from inside the dynamic Worker needs the library
 * bundled into the module string, which is a later milestone. This only checks
 * that the binding arrives intact.
 *
 * Dev only.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { devOnly } from '#/routes/api/spike/-dev-only.ts'

/**
 * Runs inside the dynamic Worker. Plain JS — there is no build step, so this
 * cannot be TypeScript and cannot import anything from the host bundle.
 */
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
    // Verified against `WorkerLoader` in worker-configuration.d.ts:
    // `load(code: WorkerLoaderWorkerCode): WorkerStub` — one argument, no id.
    const worker = env.LOADER.load({
      compatibilityDate: '2025-09-02',
      mainModule: 'index.js',
      modules: { 'index.js': DYNAMIC_MODULE },
      env: {
        BROWSER: env.BROWSER,
        HOST_MESSAGE: 'passed through from the host worker',
      },
      // The dynamic Worker gets no ambient network access; bindings still work.
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

// A directory route: `api/spike/loader.ts` would be read as a deprecated
// `.loader` suffix by the router CLI and collapse to `/api/spike`.
export const Route = createFileRoute('/api/spike/loader/')({
  server: { handlers: { GET: handler } },
})
