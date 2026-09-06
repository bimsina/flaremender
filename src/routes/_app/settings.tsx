import {
  Badge,
  Banner,
  Button,
  Input,
  LayerCard,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { WarningCircleIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { PageBody, PageHeader } from '#/components/layout/page.tsx'
import { ThemeSegmentedControl } from '#/components/layout/theme-toggle.tsx'
import { authClient } from '#/lib/auth/auth-client.ts'
import { formatDate } from '#/lib/format.ts'

export const Route = createFileRoute('/_app/settings')({ component: Settings })

function Settings() {
  const { session } = Route.useRouteContext()

  return (
    <>
      <PageHeader title="Settings" description="Your profile and appearance." />

      <PageBody>
        <div className="grid max-w-2xl gap-8">
          <ProfileSection name={session.user.name} email={session.user.email} />

          <section className="grid gap-3">
            <div className="grid gap-1.5">
              <Text as="h2" variant="heading">
                Appearance
              </Text>
              <Text variant="secondary">
                System follows your operating system's light and dark setting.
              </Text>
            </div>
            <LayerCard className="px-5 py-4">
              <ThemeSegmentedControl />
            </LayerCard>
          </section>

          <section className="grid gap-3">
            <div className="grid gap-1.5">
              <Text as="h2" variant="heading">
                Account
              </Text>
              <Text variant="secondary">Read-only details from your session.</Text>
            </div>
            <LayerCard className="px-5 py-4">
              <dl className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Text as="dt" variant="secondary" size="base">
                    Email
                  </Text>
                  <Text as="dd">{session.user.email}</Text>
                </div>
                <div className="grid gap-1.5">
                  <Text as="dt" variant="secondary" size="base">
                    Member since
                  </Text>
                  <Text as="dd">{formatDate(session.user.createdAt)}</Text>
                </div>
                <div className="grid gap-1.5">
                  <Text as="dt" variant="secondary" size="base">
                    Instance role
                  </Text>
                  <dd>
                    <Badge variant={session.user.role === 'admin' ? 'primary' : 'neutral'}>
                      {session.user.role ?? 'user'}
                    </Badge>
                  </dd>
                </div>
                <div className="grid gap-1.5">
                  <Text as="dt" variant="secondary" size="base">
                    Organizations
                  </Text>
                  <Text as="dd">{session.organizations.length}</Text>
                </div>
              </dl>
            </LayerCard>
          </section>
        </div>
      </PageBody>
    </>
  )
}

function ProfileSection({ name, email }: { name: string; email: string }) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const toast = useKumoToastManager()
  const [value, setValue] = useState(name)

  const mutation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.updateUser({ name: value.trim() })
      if (error) throw new Error(error.message ?? 'Could not save your profile.')
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      await router.invalidate()
      toast.add({ variant: 'success', title: 'Profile updated' })
    },
  })

  return (
    <section className="grid gap-3">
      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Profile
        </Text>
        <Text variant="secondary">How your name appears to the rest of your organization.</Text>
      </div>

      <LayerCard className="px-5 py-4">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            mutation.mutate()
          }}
        >
          {mutation.error ? (
            <Banner
              variant="error"
              icon={<WarningCircleIcon weight="fill" />}
              title="Could not save"
              description={mutation.error.message}
            />
          ) : null}

          <Input
            label="Display name"
            required
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Input label="Email" value={email} disabled readOnly />

          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              loading={mutation.isPending}
              disabled={!value.trim() || value.trim() === name}
            >
              Save changes
            </Button>
          </div>
        </form>
      </LayerCard>
    </section>
  )
}
