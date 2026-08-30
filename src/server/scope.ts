/**
 * The tenant boundary, expressed as loaders.
 *
 * Every org-scoped server function starts by resolving the row it was asked
 * about *through* its project's `organizationId`. A record belonging to another
 * organization is therefore indistinguishable from one that does not exist —
 * the caller learns nothing it should not know.
 */
import { and, eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import {
  environment,
  environmentVariable,
  intent,
  project,
  run,
  scriptVersion,
  suiteRun,
} from '#/db/schema/app.ts'
import { AuthError } from './auth.ts'

export async function assertProject(db: Db, organizationId: string, projectId: string) {
  const [row] = await db
    .select({ id: project.id, name: project.name, slug: project.slug })
    .from(project)
    .where(and(eq(project.id, projectId), eq(project.organizationId, organizationId)))
    .limit(1)

  if (!row) throw new AuthError('Project not found.', 404)
  return row
}

export async function loadEnvironment(db: Db, organizationId: string, environmentId: string) {
  const [row] = await db
    .select({ environment, project })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .where(and(eq(environment.id, environmentId), eq(project.organizationId, organizationId)))
    .limit(1)

  if (!row) throw new AuthError('Environment not found.', 404)
  return row
}

export async function loadEnvironmentVariable(db: Db, organizationId: string, variableId: string) {
  const [row] = await db
    .select({ variable: environmentVariable, environment, project })
    .from(environmentVariable)
    .innerJoin(environment, eq(environment.id, environmentVariable.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .where(and(eq(environmentVariable.id, variableId), eq(project.organizationId, organizationId)))
    .limit(1)

  if (!row) throw new AuthError('Variable not found.', 404)
  return row
}

export async function loadIntent(db: Db, organizationId: string, intentId: string) {
  const [row] = await db
    .select({ intent, project })
    .from(intent)
    .innerJoin(project, eq(project.id, intent.projectId))
    .where(and(eq(intent.id, intentId), eq(project.organizationId, organizationId)))
    .limit(1)

  if (!row) throw new AuthError('Intent not found.', 404)
  return row
}

export async function loadScriptVersion(db: Db, organizationId: string, versionId: string) {
  const [row] = await db
    .select({ version: scriptVersion, intent, project })
    .from(scriptVersion)
    .innerJoin(intent, eq(intent.id, scriptVersion.intentId))
    .innerJoin(project, eq(project.id, intent.projectId))
    .where(and(eq(scriptVersion.id, versionId), eq(project.organizationId, organizationId)))
    .limit(1)

  if (!row) throw new AuthError('Script version not found.', 404)
  return row
}

export async function loadRun(db: Db, organizationId: string, runId: string) {
  const [row] = await db
    .select({ run, project })
    .from(run)
    .innerJoin(project, eq(project.id, run.projectId))
    .where(and(eq(run.id, runId), eq(project.organizationId, organizationId)))
    .limit(1)

  if (!row) throw new AuthError('Run not found.', 404)
  return row
}

export async function loadSuiteRun(db: Db, organizationId: string, suiteRunId: string) {
  const [row] = await db
    .select({ suiteRun, project })
    .from(suiteRun)
    .innerJoin(project, eq(project.id, suiteRun.projectId))
    .where(and(eq(suiteRun.id, suiteRunId), eq(project.organizationId, organizationId)))
    .limit(1)

  if (!row) throw new AuthError('Suite run not found.', 404)
  return row
}

/** The environment a run points at when the caller did not name one. */
export async function loadDefaultEnvironment(db: Db, projectId: string) {
  const [row] = await db
    .select()
    .from(environment)
    .where(and(eq(environment.projectId, projectId), eq(environment.isDefault, true)))
    .limit(1)

  return row ?? null
}
