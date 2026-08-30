/**
 * What a run leaves behind, in R2.
 *
 * Keys are organization-first — `runs/{orgId}/{projectId}/{runId}/…` — so a
 * tenant's objects share a prefix that lifecycle rules, exports and deletions
 * can address in one operation, and so the read path can authorise a key by
 * looking at it rather than by consulting a table it does not have.
 *
 * The bucket binding deliberately lives out here rather than inside the Dynamic
 * Worker: bytes travel back over RPC, and the untrusted script never holds a
 * handle to storage shared with every other tenant.
 */
import type { ArtifactKeys } from '#/db/schema/app.ts'
import type { RunResult } from '#/engine/contract.ts'

export const ARTIFACT_ROOT = 'runs'

export const ARTIFACT_NAMES = {
  screenshot: 'fail.png',
  trace: 'trace.zip',
  logs: 'logs.json',
} as const

/** Trailing slash included: every key is `prefix + name`. */
export function artifactPrefix(input: {
  organizationId: string
  projectId: string
  runId: string
}): string {
  return `${ARTIFACT_ROOT}/${input.organizationId}/${input.projectId}/${input.runId}/`
}

/** The run an artifact key belongs to, or null if the key is not one of ours. */
export function runIdFromKey(key: string): string | null {
  const parts = key.split('/')
  // runs / orgId / projectId / runId / name
  if (parts.length !== 5 || parts[0] !== ARTIFACT_ROOT) return null
  return parts[3] || null
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.zip': 'application/zip',
  '.json': 'application/json',
}

export function contentTypeForKey(key: string): string {
  const dot = key.lastIndexOf('.')
  return (dot === -1 ? undefined : CONTENT_TYPES[key.slice(dot)]) ?? 'application/octet-stream'
}

export interface ArtifactInput {
  /** PNG bytes, present only when the attempt failed and a shot was possible. */
  screenshot: ArrayBuffer | null
  /** Playwright trace zip, present whenever tracing started. */
  trace: ArrayBuffer | null
  /** Already scrubbed by the time it arrives here. */
  result: RunResult
}

/**
 * Writes everything an attempt produced and returns the keys to record on it.
 *
 * A failed upload is not a failed run: the outcome is already known, and losing
 * a screenshot should not turn a green run red. Each put is therefore
 * independent and best-effort, and a key is only recorded once its object
 * exists.
 */
export async function writeArtifacts(
  bucket: R2Bucket,
  prefix: string,
  input: ArtifactInput,
): Promise<{ keys: ArtifactKeys; failures: Array<string> }> {
  const keys: ArtifactKeys = {}
  const failures: Array<string> = []

  async function put(
    name: string,
    body: ArrayBuffer | string,
    contentType: string,
  ): Promise<string | undefined> {
    const key = `${prefix}${name}`
    try {
      await bucket.put(key, body, { httpMetadata: { contentType } })
      return key
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  if (input.screenshot && input.screenshot.byteLength > 0) {
    keys.screenshot = await put(ARTIFACT_NAMES.screenshot, input.screenshot, 'image/png')
  }

  if (input.trace && input.trace.byteLength > 0) {
    keys.trace = await put(ARTIFACT_NAMES.trace, input.trace, 'application/zip')
  }

  keys.logs = await put(
    ARTIFACT_NAMES.logs,
    JSON.stringify(
      {
        outcome: input.result.outcome,
        durationMs: input.result.durationMs,
        errorMessage: input.result.errorMessage,
        steps: input.result.steps,
        logs: input.result.logs,
      },
      null,
      2,
    ),
    'application/json',
  )

  // `undefined` values would survive JSON round-trips as absent keys anyway,
  // but dropping them keeps the persisted column honest about what exists.
  for (const [name, value] of Object.entries(keys)) {
    if (value === undefined) delete keys[name as keyof ArtifactKeys]
  }

  return { keys, failures }
}
