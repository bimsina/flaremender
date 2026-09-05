/**
 * Files a person hands the agents about the app. Stored in R2 under the run
 * artifacts bucket, text extracted at upload time so prompts never touch R2 on the
 * hot path, images kept whole for models that can look at them.
 */
import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import { and, asc, eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { type ProjectFileKind, projectFile } from '#/db/schema/app.ts'
import { classify } from '#/engine/knowledge.ts'
import { createId } from '#/lib/ids.ts'
import { orgMiddleware } from './auth.ts'
import { assertProject } from './scope.ts'
import { ValidationError, str } from './validate.ts'

export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_FILES_PER_PROJECT = 20
/** Enough of a document to steer a test; the rest is noise to a prompt. */
export const MAX_EXTRACTED_CHARS = 40_000

export const FILES_ROOT = 'files'

export async function extractText(
  kind: ProjectFileKind,
  bytes: ArrayBuffer,
): Promise<string | null> {
  if (kind === 'text') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    return text.slice(0, MAX_EXTRACTED_CHARS)
  }
  if (kind === 'pdf') {
    const { extractText: extractPdf } = await import('unpdf')
    const { text } = await extractPdf(new Uint8Array(bytes), { mergePages: true })
    return (Array.isArray(text) ? text.join('\n') : text)
      .replace(/\n{3,}/g, '\n\n')
      .slice(0, MAX_EXTRACTED_CHARS)
  }
  return null
}

export function fileKey(input: {
  organizationId: string
  projectId: string
  fileId: string
  name: string
}) {
  const safe = input.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file'
  return `${FILES_ROOT}/${input.organizationId}/${input.projectId}/${input.fileId}/${safe}`
}

export async function storeProjectFile(
  env: Cloudflare.Env,
  db: Db,
  input: {
    organizationId: string
    projectId: string
    userId: string
    name: string
    contentType: string
    bytes: ArrayBuffer
  },
) {
  if (input.bytes.byteLength === 0) throw new ValidationError(`${input.name} is empty.`)
  if (input.bytes.byteLength > MAX_FILE_BYTES) {
    throw new ValidationError(`${input.name} is larger than 10 MB.`)
  }

  const existing = await db
    .select({ id: projectFile.id })
    .from(projectFile)
    .where(eq(projectFile.projectId, input.projectId))
  if (existing.length >= MAX_FILES_PER_PROJECT) {
    throw new ValidationError(
      `A project can hold ${MAX_FILES_PER_PROJECT} files. Remove one first.`,
    )
  }

  const kind = classify(input.name, input.contentType)
  let extractedText: string | null = null
  try {
    extractedText = await extractText(kind, input.bytes)
  } catch (error) {
    console.warn(`[files] could not extract text from ${input.name}:`, error)
  }

  const id = createId('file')
  const key = fileKey({
    organizationId: input.organizationId,
    projectId: input.projectId,
    fileId: id,
    name: input.name,
  })
  await env.ARTIFACTS.put(key, input.bytes, { httpMetadata: { contentType: input.contentType } })

  await db.insert(projectFile).values({
    id,
    projectId: input.projectId,
    name: input.name,
    kind,
    contentType: input.contentType,
    size: input.bytes.byteLength,
    key,
    extractedText,
    createdBy: input.userId,
  })

  return {
    id,
    name: input.name,
    kind,
    size: input.bytes.byteLength,
    extractedChars: extractedText?.length ?? 0,
  }
}

export const listProjectFiles = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId') }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)
    const rows = await context.db
      .select({
        id: projectFile.id,
        name: projectFile.name,
        kind: projectFile.kind,
        contentType: projectFile.contentType,
        size: projectFile.size,
        extractedChars: projectFile.extractedText,
        createdAt: projectFile.createdAt,
      })
      .from(projectFile)
      .where(eq(projectFile.projectId, data.projectId))
      .orderBy(asc(projectFile.createdAt))
    return rows.map((row) => ({ ...row, extractedChars: row.extractedChars?.length ?? 0 }))
  })

export const deleteProjectFile = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    fileId: str(data, 'fileId'),
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)
    const [row] = await context.db
      .select({ key: projectFile.key })
      .from(projectFile)
      .where(and(eq(projectFile.id, data.fileId), eq(projectFile.projectId, data.projectId)))
      .limit(1)
    if (!row) return { ok: true as const }
    await env.ARTIFACTS.delete(row.key).catch(() => {})
    await context.db.delete(projectFile).where(eq(projectFile.id, data.fileId))
    return { ok: true as const }
  })
