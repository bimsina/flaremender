/**
 * Bundles the Dynamic Worker harness.
 *
 * `src/engine/harness/runtime.ts` plus all of `@cloudflare/playwright` become a
 * single ES module string that `src/engine/runner/loader.ts` hands to the Worker
 * Loader. It has to be a string — the loader takes module *source*, not files —
 * and it has to be pre-built, because there is no compiler inside a Worker.
 *
 * The one import left unresolved is `./user-script.js`: that is the slot the
 * loader fills with the saved script at run time. It is written as
 * `./user-script.ts` in the source so the harness type-checks against the real
 * contract, and rewritten here.
 *
 * Output is generated, not committed — `pnpm dev` and `pnpm build` both run this
 * first. Run it by hand with `pnpm harness`.
 */
import { mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'src/engine/harness/runtime.ts')
const outfile = resolve(root, 'src/engine/harness/harness.generated.js')

/** Keeps the loader's module slot out of the bundle. */
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
  // workerd supplies these; bundling them is impossible and unnecessary.
  external: ['cloudflare:*', 'node:*'],
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
  // Playwright ships development-only branches that pull in far more code.
  define: { 'process.env.NODE_ENV': '"production"' },
  // Non-negotiable: Playwright dispatches on `constructor.name` (`expect()`
  // rejects anything that is not called `Locator`), and bundling renames
  // classes to avoid collisions. Without this, every assertion fails.
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [userScriptSlot],
})

const { size } = await stat(outfile)
console.log(`harness: ${(size / 1024 / 1024).toFixed(2)} MB → ${outfile.slice(root.length + 1)}`)
