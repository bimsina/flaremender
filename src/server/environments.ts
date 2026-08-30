/**
 * Environments and their credentials.
 *
 * An environment is where a run points: a base URL plus the variables a script
 * reads through `secret('NAME')`. Values are stored as AES-GCM envelopes and
 * **never** leave the server in plaintext — listings decrypt only far enough to
 * compute a mask, so the UI can show "which value is this" without holding it.
 *
 * Exactly one environment per project carries `isDefault`. D1 has no
 * interactive transactions, so every write that could break that invariant goes
 * through a single `db.batch`.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, inArray, ne } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { environment, environmentVariable } from '#/db/schema/app.ts'
import {
  assertVariableName,
  createEnvironmentRecord,
  setEnvironmentVariableRecord,
  updateEnvironmentRecord,
} from './actions.ts'
import { orgMiddleware } from './auth.ts'
import { decryptSecret, maskSecret } from './crypto.ts'
import { assertProject, loadEnvironment, loadEnvironmentVariable } from './scope.ts'
import { ValidationError, bool, str, url } from './validate.ts'

function variableName(data: unknown): string {
  return assertVariableName(str(data, 'name', { max: 64 }))
}

/** Clears `isDefault` on every sibling; pair it with the row that wins. */
function clearDefaults(db: Db, projectId: string, keepId: string) {
  return db
    .update(environment)
    .set({ isDefault: false })
    .where(and(eq(environment.projectId, projectId), ne(environment.id, keepId)))
}

export const listEnvironments = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ projectId: str(data, 'projectId') }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    const rows = await context.db
      .select()
      .from(environment)
      .where(eq(environment.projectId, data.projectId))
      .orderBy(asc(environment.createdAt))

    if (rows.length === 0) return []

    // Scoped to the environments just read, which were themselves scoped to the
    // caller's organization — no variable from another tenant can be selected.
    const variables = await context.db
      .select()
      .from(environmentVariable)
      .where(
        inArray(
          environmentVariable.environmentId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(environmentVariable.name))

    const byEnvironment = new Map<
      string,
      Array<{ id: string; name: string; hint: string | null }>
    >()

    for (const variable of variables) {
      // Decrypt only to mask: the plaintext is discarded in this scope and the
      // client receives the last four characters at most.
      let hint: string | null
      try {
        hint = maskSecret(await decryptSecret(variable.encryptedValue))
      } catch {
        // A rotated ENCRYPTION_KEY must not take the whole page down — the UI
        // shows the variable as unreadable so the operator can re-enter it.
        hint = null
      }

      const list = byEnvironment.get(variable.environmentId) ?? []
      list.push({ id: variable.id, name: variable.name, hint })
      byEnvironment.set(variable.environmentId, list)
    }

    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      baseUrl: row.baseUrl,
      isDefault: row.isDefault,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      variables: byEnvironment.get(row.id) ?? [],
    }))
  })

export const createEnvironment = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    projectId: str(data, 'projectId'),
    name: str(data, 'name', { max: 60 }),
    baseUrl: url(data, 'baseUrl'),
    isDefault:
      (data as Record<string, unknown>)?.isDefault === undefined ? false : bool(data, 'isDefault'),
  }))
  .handler(async ({ data, context }) => {
    await assertProject(context.db, context.organizationId, data.projectId)

    const created = await createEnvironmentRecord(context.db, {
      projectId: data.projectId,
      name: data.name,
      baseUrl: data.baseUrl,
      isDefault: data.isDefault,
      createdBy: context.user.id,
    })

    return { id: created.id, isDefault: created.isDefault }
  })

export const updateEnvironment = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    environmentId: str(data, 'environmentId'),
    name: str(data, 'name', { max: 60 }),
    baseUrl: url(data, 'baseUrl'),
  }))
  .handler(async ({ data, context }) => {
    await loadEnvironment(context.db, context.organizationId, data.environmentId)

    await updateEnvironmentRecord(context.db, {
      environmentId: data.environmentId,
      name: data.name,
      baseUrl: data.baseUrl,
    })

    return { ok: true as const }
  })

export const setDefaultEnvironment = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ environmentId: str(data, 'environmentId') }))
  .handler(async ({ data, context }) => {
    const row = await loadEnvironment(context.db, context.organizationId, data.environmentId)

    await context.db.batch([
      clearDefaults(context.db, row.environment.projectId, row.environment.id),
      context.db
        .update(environment)
        .set({ isDefault: true })
        .where(eq(environment.id, row.environment.id)),
    ])

    return { ok: true as const }
  })

export const deleteEnvironment = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ environmentId: str(data, 'environmentId') }))
  .handler(async ({ data, context }) => {
    const row = await loadEnvironment(context.db, context.organizationId, data.environmentId)

    const siblings = await context.db
      .select({ id: environment.id })
      .from(environment)
      .where(
        and(
          eq(environment.projectId, row.environment.projectId),
          ne(environment.id, row.environment.id),
        ),
      )
      .orderBy(asc(environment.createdAt))

    // A project with no environment has nothing to run against, so the last one
    // is not deletable — the project itself is what you delete instead.
    if (siblings.length === 0) {
      throw new ValidationError(
        'This is the only environment in the project. Add another one before deleting it.',
      )
    }

    const successor = row.environment.isDefault ? siblings[0]! : null

    await context.db.batch([
      context.db.delete(environment).where(eq(environment.id, row.environment.id)),
      // Deleting the default would leave the project without one; the oldest
      // survivor inherits the flag in the same batch.
      ...(successor
        ? [
            context.db
              .update(environment)
              .set({ isDefault: true })
              .where(eq(environment.id, successor.id)),
          ]
        : []),
    ])

    return { ok: true as const, promoted: successor?.id ?? null }
  })

export const setEnvironmentVariable = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({
    environmentId: str(data, 'environmentId'),
    name: variableName(data),
    value: str(data, 'value', { max: 8000 }),
  }))
  .handler(async ({ data, context }) => {
    await loadEnvironment(context.db, context.organizationId, data.environmentId)

    return setEnvironmentVariableRecord(context.db, {
      environmentId: data.environmentId,
      name: data.name,
      value: data.value,
    })
  })

export const deleteEnvironmentVariable = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator((data: unknown) => ({ variableId: str(data, 'variableId') }))
  .handler(async ({ data, context }) => {
    await loadEnvironmentVariable(context.db, context.organizationId, data.variableId)

    await context.db.delete(environmentVariable).where(eq(environmentVariable.id, data.variableId))

    return { ok: true as const }
  })
