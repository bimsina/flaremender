import { queryOptions } from '@tanstack/react-query'

import type { RunStatus, RunTrigger } from '#/db/schema/app.ts'
import type { Provider } from '#/lib/models.ts'
import { getAdminStats, listAllMemberships, listAllOrganizations } from '#/server/admin.ts'
import { listChatMessages } from '#/server/chat.ts'
import { getDailyRunCounts, getOrgOverview } from '#/server/dashboard.ts'
import { listEnvironments } from '#/server/environments.ts'
import {
  getInstanceSettings,
  getInstanceSetupStatus,
  listAllowedModels,
} from '#/server/instance.ts'
import {
  getJob,
  getIntent,
  getIntentGeneration,
  getScriptVersion,
  listIntents,
  listScriptVersions,
} from '#/server/intents.ts'
import { listProviderModels } from '#/server/model-catalog.ts'
import { getProject, listProjects } from '#/server/projects.ts'
import { getRun, listProjectRuns, listRuns } from '#/server/runs.ts'
import { getQuickSearchResources } from '#/server/search.ts'
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

export const quickSearchQuery = () =>
  queryOptions({
    queryKey: ['quick-search'] as const,
    queryFn: () => getQuickSearchResources(),
    staleTime: 30_000,
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

export const intentGenerationQuery = (intentId: string) =>
  queryOptions({
    queryKey: ['intent-generation', intentId] as const,
    queryFn: () => getIntentGeneration({ data: { intentId } }),
  })

export const chatMessagesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['chat-messages', projectId] as const,
    queryFn: () => listChatMessages({ data: { projectId } }),
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

export const scriptVersionQuery = (versionId: string) =>
  queryOptions({
    queryKey: ['script-version', versionId] as const,
    queryFn: () => getScriptVersion({ data: { versionId } }),
    staleTime: Infinity,
  })

export const runsQuery = (intentId: string) =>
  queryOptions({
    queryKey: ['runs', intentId] as const,
    queryFn: () => listRuns({ data: { intentId } }),
  })

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

export const suiteRunQuery = (suiteRunId: string) =>
  queryOptions({
    queryKey: ['suite-run', suiteRunId] as const,
    queryFn: () => getSuiteRun({ data: { suiteRunId } }),
  })

export const instanceSettingsQuery = () =>
  queryOptions({
    queryKey: ['instance', 'settings'] as const,
    queryFn: () => getInstanceSettings(),
  })

export const instanceSetupStatusQuery = () =>
  queryOptions({
    queryKey: ['instance', 'setup-status'] as const,
    queryFn: () => getInstanceSetupStatus(),
  })

export const allowedModelsQuery = () =>
  queryOptions({
    queryKey: ['instance', 'allowed-models'] as const,
    queryFn: () => listAllowedModels(),
    staleTime: 5 * 60_000,
  })

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

export const jobQuery = (jobId: string) =>
  queryOptions({
    queryKey: ['job', jobId] as const,
    queryFn: () => getJob({ data: { jobId } }),
  })
