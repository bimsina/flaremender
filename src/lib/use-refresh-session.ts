import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'

/**
 * Signing in and switching organizations change what every query returns, so
 * refetch the mounted ones and re-run the route guards on the new session.
 * Signing out clears the cache instead — nothing is left worth refetching.
 */
export function useRefreshSession() {
  const queryClient = useQueryClient()
  const router = useRouter()

  return useCallback(async () => {
    await queryClient.invalidateQueries()
    await router.invalidate()
  }, [queryClient, router])
}
