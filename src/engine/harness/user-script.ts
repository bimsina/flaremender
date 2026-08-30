/**
 * Placeholder for the module the Worker Loader supplies at run time.
 *
 * The harness statically imports `./user-script.js`; this file is what that
 * import resolves to while type-checking, and `scripts/build-harness.mjs`
 * externalises it so the bundle keeps the bare import for the loader to fill in
 * with the saved script. Nothing here ever executes.
 */
import type { ScriptContext } from './context.ts'

export default async function placeholder(_context: ScriptContext): Promise<void> {
  throw new Error('The Worker Loader replaces this module with the saved script.')
}
