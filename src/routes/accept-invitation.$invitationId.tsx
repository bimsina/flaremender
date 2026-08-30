import { Banner, Button, LayerCard, Loader, Text } from '@cloudflare/kumo'
import { WarningCircleIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'

import { ThemeToggle } from '#/components/theme-toggle.tsx'
import { authClient } from '#/lib/auth-client.ts'

export const Route = createFileRoute('/accept-invitation/$invitationId')({
  beforeLoad: ({ context, location }) => {
    if (!context.session) {
      throw redirect({ to: '/signin', search: { redirect: location.href } })
    }
  },
  component: AcceptInvitation,
})

function AcceptInvitation() {
  const { invitationId } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const invitation = useQuery({
    queryKey: ['invitation', invitationId] as const,
    queryFn: async () => {
      const { data, error } = await authClient.organization.getInvitation({
        query: { id: invitationId },
      })
      if (error || !data) throw new Error(error?.message ?? 'This invitation is no longer valid.')
      return data
    },
    retry: false,
  })

  const accept = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.acceptInvitation({ invitationId })
      if (error) throw new Error(error.message ?? 'Could not accept the invitation.')
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      await navigate({ to: '/dashboard' })
    },
  })

  const reject = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.rejectInvitation({ invitationId })
      if (error) throw new Error(error.message ?? 'Could not decline the invitation.')
    },
    onSuccess: () => navigate({ to: '/dashboard' }),
  })

  return (
    <div className="min-h-dvh bg-kumo-canvas">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-5 py-12">
        <LayerCard className="px-6 py-5">
          {invitation.isPending ? (
            <div className="flex justify-center py-6">
              <Loader size={20} />
            </div>
          ) : invitation.error ? (
            <div className="grid gap-4">
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" />}
                title="Invitation unavailable"
                description={invitation.error.message}
              />
              <Button variant="secondary" onClick={() => navigate({ to: '/dashboard' })}>
                Back to dashboard
              </Button>
            </div>
          ) : (
            <div className="grid gap-5">
              <div className="grid gap-1.5">
                <Text as="h1" variant="heading">
                  Join {invitation.data.organizationName}
                </Text>
                <Text variant="secondary">
                  You were invited as {invitation.data.role} by {invitation.data.inviterEmail}.
                </Text>
              </div>

              {(accept.error ?? reject.error) ? (
                <Banner
                  variant="error"
                  icon={<WarningCircleIcon weight="fill" />}
                  title="Something went wrong"
                  description={(accept.error ?? reject.error)!.message}
                />
              ) : null}

              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  loading={reject.isPending}
                  onClick={() => reject.mutate()}
                >
                  Decline
                </Button>
                <Button
                  variant="primary"
                  loading={accept.isPending}
                  onClick={() => accept.mutate()}
                >
                  Accept invitation
                </Button>
              </div>
            </div>
          )}
        </LayerCard>
      </div>
    </div>
  )
}
