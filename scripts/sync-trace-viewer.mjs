/**
 * Copies Playwright's prebuilt trace viewer into `public/pw-trace`.
 *
 * The viewer is a static SPA that loads traces entirely in the browser — no
 * data leaves the page. `@cloudflare/playwright` (which produces our traces)
 * does not ship the viewer bundle, so `playwright-core` is pinned as a dev
 * dependency to the fork's upstream base version: a viewer can read traces
 * produced by its own or older versions, never newer ones, so the pin must
 * move together with `@cloudflare/playwright` upgrades.
 *
 * Synced at build time rather than committed, so the viewer always tracks the
 * installed package. `public/pw-trace` is gitignored.
 */
import { cp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const pwRoot = path.dirname(require.resolve('playwright-core/package.json'))
const src = path.join(pwRoot, 'lib/vite/traceViewer')
const dest = path.resolve('public/pw-trace')

await rm(dest, { recursive: true, force: true })
await cp(src, dest, { recursive: true })

console.log(`[trace-viewer] synced ${src} -> ${dest}`)
