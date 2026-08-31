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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { ThemeToggle } from '#/components/theme-toggle.tsx'
import { authClient } from '#/lib/auth-client.ts'
import { slugify } from '#/lib/ids.ts'
import {
  DEFAULT_MODEL_ID,
  PROVIDER_LABELS,
  PROVIDER_SECRET_VARS,
  parseModelId,
} from '#/lib/models.ts'
import { instanceSettingsQuery, instanceSetupStatusQuery } from '#/lib/queries.ts'
import { useRefreshSession } from '#/lib/use-refresh-session.ts'
import { completeInstanceSetup, setProviderKey } from '#/server/instance.ts'

export const Route = createFileRoute('/onboarding')({
  beforeLoad: async ({ context, location }) => {
    if (!context.session) {
      throw redirect({ to: '/signin', search: { redirect: location.href } })
    }

    const status = await context.queryClient.ensureQueryData(instanceSetupStatusQuery())
    if (context.session.organizations.length > 0 && !status.needsSetup) {
      throw redirect({ to: '/dashboard' })
    }

    return { session: context.session, needsSetup: status.needsSetup }
  },
  loader: async ({ context }) => {
    if (!context.needsSetup) return
    await context.queryClient.ensureQueryData({
      ...instanceSettingsQuery(),
      revalidateIfStale: true,
    })
  },
  component: Onboarding,
})

const FALLBACK_SLUG = parseModelId(DEFAULT_MODEL_ID)?.slug ?? DEFAULT_MODEL_ID

function Onboarding() {
  const { session, needsSetup } = Route.useRouteContext()
  const navigate = useNavigate()

  const [step, setStep] = useState<1 | 2>(session.organizations.length > 0 ? 2 : 1)

  return (
    <div className="min-h-dvh bg-kumo-canvas">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-5 py-12">
        <div className="grid gap-1.5 text-center">
          {needsSetup ? (
            <Text variant="secondary">Step {step} of 2</Text>
          ) : (
            <Text variant="secondary">One more step before you can add a project.</Text>
          )}
        </div>

        {step === 1 ? (
          <CreateOrganizationStep
            onDone={async () => {
              if (needsSetup) setStep(2)
              else await navigate({ to: '/dashboard' })
            }}
          />
        ) : (
          <InstanceSetupStep />
        )}
      </div>
    </div>
  )
}

function CreateOrganizationStep({ onDone }: { onDone: () => Promise<void> }) {
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
    await onDone()
  }

  return (
    <LayerCard className="px-6 py-5">
      <form onSubmit={onSubmit} className="grid gap-5">
        <div className="grid gap-1.5">
          <Text as="h1" variant="heading">
            Create your organization
          </Text>
          <Text variant="secondary">
            Projects, intents and runs all live inside an organization. You can create more later
            and switch between them.
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
  )
}

function InstanceSetupStep() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const settings = useQuery(instanceSettingsQuery())
  const [keys, setKeys] = useState<Record<string, string>>({})

  const finish = useMutation({
    mutationFn: async (saveKeys: boolean) => {
      if (saveKeys) {
        for (const [provider, key] of Object.entries(keys)) {
          if (!key.trim()) continue
          await setProviderKey({
            data: { provider: provider as 'anthropic' | 'openai' | 'google', key: key.trim() },
          })
        }
      }
      await completeInstanceSetup()
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      await navigate({ to: '/dashboard' })
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not finish setup', description: error.message }),
  })

  const configurable = (settings.data?.providers ?? []).filter(
    (row) => row.provider !== 'workers-ai' && row.effectiveSource === 'none',
  )

  return (
    <LayerCard className="px-6 py-5">
      <form
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          finish.mutate(true)
        }}
      >
        <div className="grid gap-1.5">
          <Text as="h1" variant="heading">
            Set up this instance
          </Text>
          <Text variant="secondary">
            Generation runs on the model a project picks. Without one it uses Workers AI (
            <span className="font-mono text-[0.9em]">{FALLBACK_SLUG}</span>), which needs no key.
          </Text>
        </div>

        {settings.error ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="Could not read the instance settings"
            description={settings.error.message}
          />
        ) : null}

        <div className="grid gap-3">
          {(settings.data?.providers ?? []).map((row) => (
            <div key={row.provider} className="flex items-center justify-between gap-3">
              <Text as="span">{PROVIDER_LABELS[row.provider]}</Text>
              {row.provider === 'workers-ai' ? (
                <Badge variant="neutral">Built in</Badge>
              ) : row.secretDetected ? (
                <Badge variant="neutral">
                  Worker secret ({PROVIDER_SECRET_VARS[row.provider]})
                </Badge>
              ) : row.effectiveSource === 'database' ? (
                <Badge variant="neutral">Key stored</Badge>
              ) : (
                <Badge variant="neutral" appearance="dot">
                  No key
                </Badge>
              )}
            </div>
          ))}
        </div>

        {configurable.length > 0 ? (
          <div className="grid gap-4">
            {configurable.map((row) => (
              <Input
                key={row.provider}
                label={`${PROVIDER_LABELS[row.provider]} API key`}
                description="Optional. Stored encrypted; you can add it later."
                type="password"
                autoComplete="off"
                value={keys[row.provider] ?? ''}
                onChange={(event) =>
                  setKeys((current) => ({ ...current, [row.provider]: event.target.value }))
                }
              />
            ))}
          </div>
        ) : null}

        <div className="grid gap-2">
          <Button type="submit" variant="primary" loading={finish.isPending}>
            Finish setup
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={finish.isPending}
            onClick={() => finish.mutate(false)}
          >
            Skip for now
          </Button>
          <Text variant="secondary" size="base">
            Everything here can be changed later in Administration → Settings.
          </Text>
        </div>
      </form>
    </LayerCard>
  )
}
