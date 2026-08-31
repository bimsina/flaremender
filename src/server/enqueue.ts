import { ValidationError } from './validate.ts'

export async function enqueueWork(
  start: () => Promise<unknown>,
  lookup: () => Promise<unknown>,
  failed: () => Promise<unknown>,
) {
  try {
    await start()
  } catch {
    try {
      await lookup()
      return
    } catch {
      await failed()
      throw new ValidationError('The work could not be started. Please try again.')
    }
  }
}
