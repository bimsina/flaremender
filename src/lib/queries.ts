import { queryOptions } from '@tanstack/react-query'

import { getAdminStats, listAllMemberships, listAllOrganizations } from '#/server/admin.ts'
import { getOrgOverview } from '#/server/dashboard.ts'
import { getProject, listProjects } from '#/server/projects.ts'
import { fetchSession, fetchThemePreference } from '#/server/session.ts'
import { getTestCase, listTestCases } from '#/server/test-cases.ts'

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

export const testCasesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['test-cases', projectId] as const,
    queryFn: () => listTestCases({ data: { projectId } }),
  })

export const testCaseQuery = (testCaseId: string) =>
  queryOptions({
    queryKey: ['test-case', testCaseId] as const,
    queryFn: () => getTestCase({ data: { testCaseId } }),
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
