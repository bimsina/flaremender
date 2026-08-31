import type { ScriptContext } from './context.ts'

export default async function placeholder(_context: ScriptContext): Promise<void> {
  throw new Error('The Worker Loader replaces this module with the saved script.')
}
