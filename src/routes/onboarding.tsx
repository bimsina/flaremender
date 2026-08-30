import { Banner, Button, Input, LayerCard, Text } from '@cloudflare/kumo'
import { WarningCircleIcon } from '@phosphor-icons/react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { ThemeToggle } from '#/components/theme-toggle.tsx'
import { authClient } from '#/lib/auth-client.ts'
import { slugify } from '#/lib/ids.ts'
import { useRefreshSession } from '#/lib/use-refresh-session.ts'

export const Route = createFileRoute('/onboarding')({
  beforeLoad: ({ context, location }) => {
    if (!context.session) {
      throw redirect({ to: '/signin', search: { redirect: location.href } })
    }
    if (context.session.organizations.length > 0) throw redirect({ to: '/dashboard' })
  },
  component: Onboarding,
})

function Onboarding() {
  const navigate = useNavigate()
  const refreshSession = useRefreshSession()

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const effectiveSlug = slugTouched ? slug : slugify(name)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const { data, error: createError } = await authClient.organization.create({
      name: name.trim(),
      slug: effectiveSlug,
    })

    if (createError || !data) {
      setError(createError?.message ?? 'Could not create the organization.')
      setPending(false)
      return
    }

    await authClient.organization.setActive({ organizationId: data.id })
    await refreshSession()
    await navigate({ to: '/dashboard' })
  }

  return (
    <div className="min-h-dvh bg-kumo-canvas">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-5 py-12">
        <div className="grid gap-1.5 text-center">
          <Text variant="secondary">One more step before you can add a project.</Text>
        </div>

        <LayerCard className="px-6 py-5">
          <form onSubmit={onSubmit} className="grid gap-5">
            <div className="grid gap-1.5">
              <Text as="h1" variant="heading">
                Create your organization
              </Text>
              <Text variant="secondary">
                Projects, intents and runs all live inside an organization. You can create more
                later and switch between them.
              </Text>
            </div>

            {error ? (
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" />}
                title="Could not create organization"
                description={error}
              />
            ) : null}

            <div className="grid gap-4">
              <Input
                label="Organization name"
                placeholder="Acme Inc."
                required
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Input
                label="Slug"
                description="Used in URLs. Lowercase letters, numbers and dashes."
                placeholder="acme-inc"
                required
                value={effectiveSlug}
                onChange={(event) => {
                  setSlugTouched(true)
                  setSlug(slugify(event.target.value))
                }}
              />
            </div>

            <Button type="submit" variant="primary" loading={pending} disabled={!name.trim()}>
              Continue
            </Button>
          </form>
        </LayerCard>
      </div>
    </div>
  )
}
