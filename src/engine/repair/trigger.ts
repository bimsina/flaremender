/**
 * Decides, after a run has been persisted, whether the agent should try to repair it.
 * At most one automatic repair per test per script version, so a repair that fails
 * cannot loop forever, and never while another generation is touching the test.
 */
import { and, eq, inArray } from 'drizzle-orm'

import { createDb } from '#/db/index.ts'
import { generationJob, intent, project, run } from '#/db/schema/app.ts'
import { queueRepair } from '#/server/core/actions.ts'
import { resolveHealPolicy } from '#/server/runs/heal-policy.ts'

export interface RepairDecision {
  queued: boolean
  jobId: string | null
  reason: string
}

export async function maybeQueueAutomaticRepair(
  env: Cloudflare.Env,
  runId: string,
): Promise<RepairDecision> {
  const db = createDb(env.DB)

  const [row] = await db
    .select({ run, intent, organizationId: project.organizationId })
    .from(run)
    .innerJoin(intent, eq(intent.id, run.intentId))
    .innerJoin(project, eq(project.id, run.projectId))
    .where(eq(run.id, runId))
    .limit(1)

  if (!row) return { queued: false, jobId: null, reason: 'run not found' }
  if (row.run.status !== 'failed') return { queued: false, jobId: null, reason: row.run.status }
  if (row.run.purpose !== 'regression')
    return { queued: false, jobId: null, reason: row.run.purpose }
  if (row.intent.readiness !== 'ready' || row.intent.currentVersionId !== row.run.scriptVersionId) {
    return { queued: false, jobId: null, reason: 'not the current ready version' }
  }

  const policy = await resolveHealPolicy(db, row.intent.id)
  if (policy.effective === 'off') return { queued: false, jobId: null, reason: 'policy off' }

  const [inFlight] = await db
    .select({ id: generationJob.id })
    .from(generationJob)
    .where(
      and(
        eq(generationJob.intentId, row.intent.id),
        inArray(generationJob.status, ['queued', 'running']),
      ),
    )
    .limit(1)
  if (inFlight) return { queued: false, jobId: null, reason: `job ${inFlight.id} in flight` }

  const [tried] = await db
    .select({ id: generationJob.id })
    .from(generationJob)
    .innerJoin(run, eq(run.id, generationJob.sourceRunId))
    .where(
      and(
        eq(generationJob.intentId, row.intent.id),
        eq(generationJob.kind, 'repair'),
        eq(run.scriptVersionId, row.run.scriptVersionId),
      ),
    )
    .limit(1)
  if (tried)
    return { queued: false, jobId: null, reason: `version already repaired by ${tried.id}` }

  const queued = await queueRepair(db, {
    runId: row.run.id,
    intentId: row.intent.id,
    projectId: row.run.projectId,
    environmentId: row.run.environmentId,
    organizationId: row.organizationId,
    createdBy: row.intent.createdBy,
  })

  return { queued: true, jobId: queued.jobId, reason: policy.effective }
}
