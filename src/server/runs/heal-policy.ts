/**
 * What happens when a ready test fails. Read in order: the test's own setting, then
 * the project's, then the organization's, which is where `off` lives by default.
 */
import { eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import {
  type HealPolicy,
  type HealPolicyChoice,
  intent,
  organizationSettings,
  project,
} from '#/db/schema/app.ts'

export interface ResolvedHealPolicy {
  effective: HealPolicy
  /** Which level supplied the effective value. */
  source: 'test' | 'project' | 'organization'
  test: HealPolicyChoice
  project: HealPolicyChoice
  organization: HealPolicy
}

export function combineHealPolicy(input: {
  test: HealPolicyChoice
  project: HealPolicyChoice
  organization: HealPolicy | null
}): ResolvedHealPolicy {
  const organization = input.organization ?? 'off'
  if (input.test !== 'inherit') {
    return { effective: input.test, source: 'test', ...input, organization }
  }
  if (input.project !== 'inherit') {
    return { effective: input.project, source: 'project', ...input, organization }
  }
  return { effective: organization, source: 'organization', ...input, organization }
}

export async function resolveHealPolicy(db: Db, intentId: string): Promise<ResolvedHealPolicy> {
  const [row] = await db
    .select({
      test: intent.healPolicy,
      project: project.healPolicy,
      organization: organizationSettings.healPolicy,
    })
    .from(intent)
    .innerJoin(project, eq(project.id, intent.projectId))
    .leftJoin(organizationSettings, eq(organizationSettings.organizationId, project.organizationId))
    .where(eq(intent.id, intentId))
    .limit(1)

  if (!row) return combineHealPolicy({ test: 'inherit', project: 'inherit', organization: null })
  return combineHealPolicy(row)
}

export async function resolveProjectHealPolicy(
  db: Db,
  projectId: string,
): Promise<{ effective: HealPolicy; project: HealPolicyChoice; organization: HealPolicy }> {
  const [row] = await db
    .select({ project: project.healPolicy, organization: organizationSettings.healPolicy })
    .from(project)
    .leftJoin(organizationSettings, eq(organizationSettings.organizationId, project.organizationId))
    .where(eq(project.id, projectId))
    .limit(1)

  const resolved = combineHealPolicy({
    test: 'inherit',
    project: row?.project ?? 'inherit',
    organization: row?.organization ?? null,
  })
  return {
    effective: resolved.effective,
    project: resolved.project,
    organization: resolved.organization,
  }
}
