import { queryOptions } from '@tanstack/react-query'

import { getAdminStats, listAllMemberships, listAllOrganizations } from '#/server/admin.ts'
import { getOrgOverview } from '#/server/dashboard.ts'
import { listEnvironments } from '#/server/environments.ts'
import { getIntent, getScriptVersion, listIntents, listScriptVersions } from '#/server/intents.ts'
import { getProject, listProjects } from '#/server/projects.ts'
import { getRun, listRuns } from '#/server/runs.ts'
import { fetchSession, fetchThemePreference } from '#/server/session.ts'
import { getSuiteRun, listSuiteRuns } from '#/server/suites.ts'

export const sessionQuery = () =>
  queryOptions({
    queryKey: ['session'] as const,
    queryFn: () => fetchSession(),
    staleTime: 30_000,
  })

export const themeQuery = () =>
  queryOptions({
    queryKey: ['theme'] as const,
    queryFn: () => fetchThemePreference(),
    staleTime: Infinity,
  })

export const overviewQuery = () =>
  queryOptions({
    queryKey: ['overview'] as const,
    queryFn: () => getOrgOverview(),
  })

export const projectsQuery = () =>
  queryOptions({
    queryKey: ['projects'] as const,
    queryFn: () => listProjects(),
  })

export const projectQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId] as const,
    queryFn: () => getProject({ data: { projectId } }),
  })

export const intentsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['intents', projectId] as const,
    queryFn: () => listIntents({ data: { projectId } }),
  })

export const intentQuery = (intentId: string) =>
  queryOptions({
    queryKey: ['intent', intentId] as const,
    queryFn: () => getIntent({ data: { intentId } }),
  })

export const environmentsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['environments', projectId] as const,
    queryFn: () => listEnvironments({ data: { projectId } }),
  })

export const scriptVersionsQuery = (intentId: string) =>
  queryOptions({
    queryKey: ['script-versions', intentId] as const,
    queryFn: () => listScriptVersions({ data: { intentId } }),
  })

/** One version's code, fetched only when the history panel opens it. */
export const scriptVersionQuery = (versionId: string) =>
  queryOptions({
    queryKey: ['script-version', versionId] as const,
    queryFn: () => getScriptVersion({ data: { versionId } }),
    // Versions are immutable, so a fetched one never needs refreshing.
    staleTime: Infinity,
  })

export const runsQuery = (intentId: string) =>
  queryOptions({
    queryKey: ['runs', intentId] as const,
    queryFn: () => listRuns({ data: { intentId } }),
  })

export const runQuery = (runId: string) =>
  queryOptions({
    queryKey: ['run', runId] as const,
    queryFn: () => getRun({ data: { runId } }),
  })

export const suiteRunsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['suite-runs', projectId] as const,
    queryFn: () => listSuiteRuns({ data: { projectId } }),
  })

/**
 * One suite and its members. Polled by the progress strip while a suite is
 * live; the caller supplies `refetchInterval`, because only it knows whether
 * what it is showing has stopped moving.
 */
export const suiteRunQuery = (suiteRunId: string) =>
  queryOptions({
    queryKey: ['suite-run', suiteRunId] as const,
    queryFn: () => getSuiteRun({ data: { suiteRunId } }),
  })

export const adminStatsQuery = () =>
  queryOptions({
    queryKey: ['admin', 'stats'] as const,
    queryFn: () => getAdminStats(),
  })

export const adminOrganizationsQuery = () =>
  queryOptions({
    queryKey: ['admin', 'organizations'] as const,
    queryFn: () => listAllOrganizations(),
  })

export const adminMembershipsQuery = (organizationId: string) =>
  queryOptions({
    queryKey: ['admin', 'memberships', organizationId] as const,
    queryFn: () => listAllMemberships({ data: { organizationId } }),
    enabled: organizationId.length > 0,
  })
