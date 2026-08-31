import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'

export function useRefreshSession() {
  const queryClient = useQueryClient()
  const router = useRouter()

  return useCallback(async () => {
    await queryClient.invalidateQueries()
    await router.invalidate()
  }, [queryClient, router])
}
