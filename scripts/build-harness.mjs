import { mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'src/engine/harness/runtime.ts')
const outfile = resolve(root, 'src/engine/harness/harness.generated.js')

const userScriptSlot = {
  name: 'user-script-slot',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /(^|\/)user-script\.(ts|js)$/ }, () => ({
      path: './user-script.js',
      external: true,
    }))
  },
}

await mkdir(dirname(outfile), { recursive: true })

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['cloudflare:*', 'node:*'],
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
  define: { 'process.env.NODE_ENV': '"production"' },
  // Playwright assertions depend on Locator.constructor.name; preserve class names.
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [userScriptSlot],
})

const { size } = await stat(outfile)
console.log(`harness: ${(size / 1024 / 1024).toFixed(2)} MB → ${outfile.slice(root.length + 1)}`)
