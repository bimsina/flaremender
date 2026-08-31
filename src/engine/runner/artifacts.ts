import type { ArtifactKeys } from '#/db/schema/app.ts'
import type { RunResult } from '#/engine/contract.ts'

export const ARTIFACT_ROOT = 'runs'

export const ARTIFACT_NAMES = {
  screenshot: 'fail.png',
  trace: 'trace.zip',
  logs: 'logs.json',
} as const

export function artifactPrefix(input: {
  organizationId: string
  projectId: string
  runId: string
}): string {
  return `${ARTIFACT_ROOT}/${input.organizationId}/${input.projectId}/${input.runId}/`
}

export function runIdFromKey(key: string): string | null {
  const parts = key.split('/')
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
  screenshot: ArrayBuffer | null
  trace: ArrayBuffer | null
  result: RunResult
}

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

  for (const [name, value] of Object.entries(keys)) {
    if (value === undefined) delete keys[name as keyof ArtifactKeys]
  }

  return { keys, failures }
}
