import { queryOptions } from '@tanstack/react-query'

import type { RunStatus, RunTrigger } from '#/db/schema/app.ts'
import type { Provider } from '#/lib/models.ts'
import { getAdminStats, listAllMemberships, listAllOrganizations } from '#/server/admin.ts'
import { getDailyRunCounts, getOrgOverview } from '#/server/dashboard.ts'
import { listEnvironments } from '#/server/environments.ts'
import {
  getInstanceSettings,
  getInstanceSetupStatus,
  listAllowedModels,
} from '#/server/instance.ts'
import { getIntent, getScriptVersion, listIntents, listScriptVersions } from '#/server/intents.ts'
import { listProviderModels } from '#/server/model-catalog.ts'
import { getProject, listProjects } from '#/server/projects.ts'
import { getRun, listProjectRuns, listRuns } from '#/server/runs.ts'
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

/**
 * The last fortnight of runs, one row per UTC day, for the trend charts.
 *
 * With a project id it is the same window narrowed to that project, which is a
 * different cache entry rather than a filter over the org-wide one — the server
 * groups either shape in a single query, and a fortnight of one project cannot
 * be recovered from a fortnight of all of them.
 */
export const runTrendQuery = (projectId?: string) =>
  queryOptions({
    queryKey: ['run-trend', projectId ?? null] as const,
    queryFn: () => getDailyRunCounts({ data: projectId ? { projectId } : {} }),
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

/**
 * Every run in a project, filtered server-side.
 *
 * The filters are normalised to an all-null object so that "no filters" is one
 * cache key rather than several: the project Runs tab asks for the unfiltered
 * window to compute its summary and for the filtered window to fill its table,
 * and while nothing is filtered those are the same request.
 */
export interface ProjectRunFilters {
  status?: RunStatus | null
  environmentId?: string | null
  trigger?: RunTrigger | null
}

const PROJECT_RUNS_LIMIT = 50

export const projectRunsQuery = (projectId: string, filters: ProjectRunFilters = {}) => {
  const status = filters.status ?? null
  const environmentId = filters.environmentId ?? null
  const trigger = filters.trigger ?? null

  return queryOptions({
    queryKey: ['project-runs', projectId, { status, environmentId, trigger }] as const,
    queryFn: () =>
      listProjectRuns({
        data: {
          projectId,
          limit: PROJECT_RUNS_LIMIT,
          // Absent rather than null: the validator reads a present key as an
          // opinion, and `null` is not one of the values it accepts.
          ...(status ? { status } : {}),
          ...(environmentId ? { environmentId } : {}),
          ...(trigger ? { trigger } : {}),
        },
      }),
  })
}

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

/** Provider status, the default model and setup state. Admins only. */
export const instanceSettingsQuery = () =>
  queryOptions({
    queryKey: ['instance', 'settings'] as const,
    queryFn: () => getInstanceSettings(),
  })

/** Asked on the way into the app by everyone; false for non-admins. */
export const instanceSetupStatusQuery = () =>
  queryOptions({
    queryKey: ['instance', 'setup-status'] as const,
    queryFn: () => getInstanceSetupStatus(),
  })

/**
 * The curated model list, read by every project's picker as well as the admin
 * console. Allowlists change on the scale of weeks, so it is worth holding.
 */
export const allowedModelsQuery = () =>
  queryOptions({
    queryKey: ['instance', 'allowed-models'] as const,
    queryFn: () => listAllowedModels(),
    staleTime: 5 * 60_000,
  })

/**
 * One provider's live catalog. Matches the server's own half-hour cache, so
 * switching back and forth between providers costs nothing; the refresh button
 * passes `force` through its own request rather than invalidating this.
 */
export const providerModelsQuery = (provider: Provider) =>
  queryOptions({
    queryKey: ['instance', 'provider-models', provider] as const,
    queryFn: () => listProviderModels({ data: { provider } }),
    staleTime: 30 * 60_000,
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
