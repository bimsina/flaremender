import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db } from '#/db/index.ts'
import {
  attempt,
  environment,
  generationJob,
  intent,
  project,
  run,
  scriptVersion,
} from '#/db/schema/app.ts'
import { loadRun, loadSuiteRun } from '#/server/auth/scope.ts'

export async function readRunReport(db: Db, organizationId: string, runId: string) {
  const scoped = await loadRun(db, organizationId, runId)

  const [row] = await db
    .select({
      run,
      environmentName: sql<string>`coalesce(${run.environmentName}, ${environment.name})`,
      baseUrl: environment.baseUrl,
      version: scriptVersion.version,
      intentId: intent.id,
      intentTitle: intent.title,
    })
    .from(run)
    .innerJoin(environment, eq(environment.id, run.environmentId))
    .innerJoin(scriptVersion, eq(scriptVersion.id, run.scriptVersionId))
    .innerJoin(intent, eq(intent.id, run.intentId))
    .where(eq(run.id, scoped.run.id))
    .limit(1)

  const attempts = await db
    .select({
      id: attempt.id,
      attemptNumber: attempt.attemptNumber,
      outcome: attempt.outcome,
      diagnosis: attempt.diagnosis,
      scriptVersionId: attempt.scriptVersionId,
      scriptUsed: attempt.scriptUsed,
      healApplied: attempt.healApplied,
      artifactKeys: attempt.artifactKeys,
      result: attempt.result,
      artifactWarnings: attempt.artifactWarnings,
      logs: attempt.logs,
      errorMessage: attempt.errorMessage,
      durationMs: attempt.durationMs,
      createdAt: attempt.createdAt,
    })
    .from(attempt)
    .where(eq(attempt.runId, scoped.run.id))
    .orderBy(asc(attempt.attemptNumber))

  return {
    run: row!.run,
    environment: {
      id: row!.run.environmentId,
      name: row!.run.environmentName ?? row!.environmentName,
      baseUrl: row!.run.baseUrl,
      currentBaseUrl: row!.baseUrl,
    },
    scriptVersion: { id: row!.run.scriptVersionId, version: row!.version },
    intent: { id: row!.intentId, title: row!.intentTitle },
    project: { id: scoped.project.id, name: scoped.project.name },
    attempts,
  }
}

export async function readSuiteReport(db: Db, organizationId: string, suiteRunId: string) {
  const scoped = await loadSuiteRun(db, organizationId, suiteRunId)
  const members = await db
    .select({ id: run.id })
    .from(run)
    .where(eq(run.suiteRunId, suiteRunId))
    .orderBy(asc(run.startedAt), asc(run.id))
  const runs = []
  for (const member of members) runs.push(await readRunReport(db, organizationId, member.id))
  return { suiteRun: scoped.suiteRun, runs }
}

export async function readJob(db: Db, organizationId: string, jobId: string) {
  const [row] = await db
    .select({ job: generationJob })
    .from(generationJob)
    .innerJoin(project, eq(project.id, generationJob.projectId))
    .where(
      and(
        eq(generationJob.id, jobId),
        eq(generationJob.organizationId, organizationId),
        eq(project.organizationId, organizationId),
      ),
    )
    .limit(1)
  return row?.job ?? null
}
