/** Keep playwright-core pinned to the Cloudflare fork’s upstream version so the viewer can read its traces. */
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
