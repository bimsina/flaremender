import {
  Badge,
  Banner,
  Button,
  Dialog,
  Input,
  LayerCard,
  Loader,
  Select,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { CheckIcon, PlusIcon, TrashIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { InlineEmpty, ListToolbar, Section, SettingRow } from '#/components/list.tsx'
import { PageBody } from '#/components/page.tsx'
import {
  DEFAULT_MODEL_ID,
  PROVIDER_LABELS,
  PROVIDER_SECRET_VARS,
  type Provider,
  formatModelId,
  parseModelId,
} from '#/lib/models.ts'
import { allowedModelsQuery, instanceSettingsQuery, providerModelsQuery } from '#/lib/queries.ts'
import type { ProviderStatus } from '#/server/instance.ts'
import {
  addAllowedModel,
  deleteProviderKey,
  removeAllowedModel,
  setProviderKey,
  updateInstanceSettings,
} from '#/server/instance.ts'
import { listProviderModels } from '#/server/model-catalog.ts'

export const Route = createFileRoute('/_app/admin/settings')({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData({
        ...instanceSettingsQuery(),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({ ...allowedModelsQuery(), revalidateIfStale: true }),
    ])
  },
  component: AdminSettings,
})

/** The slug an operator sees when the chain falls through to Workers AI. */
const FALLBACK_SLUG = parseModelId(DEFAULT_MODEL_ID)?.slug ?? DEFAULT_MODEL_ID

const PROVIDER_ITEMS: Record<Provider, string> = PROVIDER_LABELS

type AllowedModel = {
  id: string
  modelId: string
  provider: Provider
  displayName: string
}

function AdminSettings() {
  const { data: settings } = useSuspenseQuery(instanceSettingsQuery())
  const { data: allowed } = useSuspenseQuery(allowedModelsQuery())

  return (
    <PageBody>
      <div className="grid max-w-3xl gap-8">
        <Section
          title="Provider keys"
          description="Where this instance gets its model credentials. A key bound as a Worker secret always wins, and cannot be changed from here."
        >
          <div className="grid gap-3">
            {settings.providers.map((status) => (
              <ProviderKeyRow key={status.provider} status={status} />
            ))}
          </div>
        </Section>

        <Section
          title="Model catalog"
          description="Read live from each provider. Adding a model to the allowlist is what makes it selectable in a project."
        >
          <CatalogBrowser allowed={allowed} />
        </Section>

        <Section
          title="Allowed models"
          description="The list every project's model picker reads from."
        >
          <div className="grid gap-3">
            <AllowlistCard allowed={allowed} defaultModelId={settings.defaultModelId} />
            <ManualEntryCard />
          </div>
        </Section>

        <Section
          title="Defaults"
          description="What a project uses when it has no model of its own."
        >
          <DefaultModelRow allowed={allowed} defaultModelId={settings.defaultModelId} />
        </Section>
      </div>
    </PageBody>
  )
}

function ProviderKeyRow({ status }: { status: ProviderStatus }) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const [editing, setEditing] = useState(false)

  const label = PROVIDER_LABELS[status.provider]
  const secretVar = PROVIDER_SECRET_VARS[status.provider]

  const remove = useMutation({
    mutationFn: () => deleteProviderKey({ data: { provider: status.provider } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Key removed', description: label })
    },
    onError: (error: Error) =>
      toast.add({
        variant: 'error',
        title: 'Could not remove the key',
        description: error.message,
      }),
  })

  if (status.provider === 'workers-ai') {
    return (
      <SettingRow label={label} hint="Built in — uses this account’s AI binding.">
        <Badge variant="neutral">No key needed</Badge>
      </SettingRow>
    )
  }

  if (status.secretDetected) {
    return (
      <SettingRow
        label={label}
        hint={`Configured via Worker secret (${secretVar}). A secret takes precedence over anything saved here, so this key is read-only.`}
      >
        <Badge variant="neutral">Worker secret</Badge>
      </SettingRow>
    )
  }

  const stored = status.effectiveSource === 'database'

  return (
    <>
      <SettingRow
        label={label}
        hint={
          stored
            ? status.dbKeyHint
              ? `Stored in this instance — ${status.dbKeyHint}`
              : 'Stored in this instance, but unreadable. ENCRYPTION_KEY has probably changed — replace the key.'
            : `No key. Set one here, or bind ${secretVar} as a Worker secret.`
        }
      >
        {stored ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Replace
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Add key
          </Button>
        )}
      </SettingRow>

      <ProviderKeyDialog
        provider={status.provider}
        replacing={stored}
        open={editing}
        onOpenChange={setEditing}
      />
    </>
  )
}

function ProviderKeyDialog({
  provider,
  replacing,
  open,
  onOpenChange,
}: {
  provider: Provider
  replacing: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const [key, setKey] = useState('')

  const label = PROVIDER_LABELS[provider]

  const mutation = useMutation({
    mutationFn: () => setProviderKey({ data: { provider, key: key.trim() } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Key saved', description: label })
      setKey('')
      onOpenChange(false)
    },
  })

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="px-6 py-5">
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            mutation.mutate()
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1.5">
              <Dialog.Title>
                <Text as="span" variant="heading">
                  {replacing ? `Replace the ${label} key` : `Add a ${label} key`}
                </Text>
              </Dialog.Title>
              <Dialog.Description>
                <Text as="span" variant="secondary">
                  Stored encrypted. It is never shown again — only the last four characters.
                </Text>
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close"
              render={(props) => (
                <Button {...props} variant="ghost" shape="square" size="sm" aria-label="Close">
                  <XIcon size={16} />
                </Button>
              )}
            />
          </div>

          {mutation.error ? (
            <Banner
              variant="error"
              icon={<WarningCircleIcon weight="fill" />}
              title="Could not save the key"
              description={mutation.error.message}
            />
          ) : null}

          <Input
            label="API key"
            type="password"
            autoComplete="off"
            required
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />

          <div className="flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button {...props} variant="secondary">
                  Cancel
                </Button>
              )}
            />
            <Button
              type="submit"
              variant="primary"
              loading={mutation.isPending}
              disabled={!key.trim()}
            >
              Save key
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}

function CatalogBrowser({ allowed }: { allowed: Array<AllowedModel> }) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [provider, setProvider] = useState<Provider>('workers-ai')
  const [search, setSearch] = useState('')

  const catalog = useQuery(providerModelsQuery(provider))

  const refresh = useMutation({
    mutationFn: () => listProviderModels({ data: { provider, force: true } }),
    onSuccess: (data) => {
      queryClient.setQueryData(providerModelsQuery(provider).queryKey, data)
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not refresh', description: error.message }),
  })

  const add = useMutation({
    mutationFn: (model: { slug: string; displayName: string }) =>
      addAllowedModel({
        data: { modelId: formatModelId(provider, model.slug), displayName: model.displayName },
      }),
    onSuccess: async (_data, model) => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Added to the allowlist', description: model.slug })
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not add the model', description: error.message }),
  })

  const allowedIds = useMemo(() => new Set(allowed.map((row) => row.modelId)), [allowed])

  const models = useMemo(() => {
    if (!catalog.data?.available) return []
    const needle = search.trim().toLowerCase()
    if (!needle) return catalog.data.models
    return catalog.data.models.filter(
      (model) =>
        model.slug.toLowerCase().includes(needle) ||
        model.displayName.toLowerCase().includes(needle),
    )
  }, [catalog.data, search])

  return (
    <div className="grid gap-3">
      <ListToolbar
        value={search}
        onValueChange={setSearch}
        placeholder="Filter models"
        onRefresh={() => refresh.mutate()}
        refreshing={refresh.isPending || catalog.isFetching}
      >
        <Select
          aria-label="Provider"
          className="w-44"
          items={PROVIDER_ITEMS}
          value={provider}
          onValueChange={(value: Provider | null) => setProvider(value ?? 'workers-ai')}
        />
      </ListToolbar>

      <LayerCard className="px-5 py-4">
        {catalog.isPending ? (
          <div className="flex justify-center py-6">
            <Loader size={20} />
          </div>
        ) : catalog.error ? (
          <InlineEmpty message={catalog.error.message} />
        ) : catalog.data?.available === false ? (
          <InlineEmpty message={catalog.data.reason} />
        ) : models.length === 0 ? (
          <InlineEmpty message="No models match that filter." />
        ) : (
          <div className="grid gap-3">
            {catalog.data?.available && catalog.data.fallback ? (
              <Text variant="secondary" size="xs">
                The live catalog was unreachable, so this is the built-in list.
              </Text>
            ) : null}

            <div className="grid max-h-96 gap-px overflow-y-auto">
              {models.map((model) => {
                const modelId = formatModelId(provider, model.slug)
                const already = allowedIds.has(modelId)

                return (
                  <div
                    key={model.slug}
                    className="flex flex-wrap items-center justify-between gap-3 py-1.5"
                  >
                    <div className="grid min-w-0 gap-0.5">
                      <Text as="span">{model.displayName}</Text>
                      <span className="truncate font-mono text-xs text-kumo-subtle">
                        {model.slug}
                      </span>
                    </div>
                    {already ? (
                      <Badge variant="neutral" icon={CheckIcon}>
                        Allowed
                      </Badge>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={add.isPending && add.variables?.slug === model.slug}
                        onClick={() =>
                          add.mutate({ slug: model.slug, displayName: model.displayName })
                        }
                      >
                        Add
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </LayerCard>
    </div>
  )
}

function AllowlistCard({
  allowed,
  defaultModelId,
}: {
  allowed: Array<AllowedModel>
  defaultModelId: string | null
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const remove = useMutation({
    mutationFn: (modelId: string) => removeAllowedModel({ data: { modelId } }),
    onSuccess: async (_data, modelId) => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: 'success',
        title: 'Removed from the allowlist',
        description:
          modelId === defaultModelId
            ? 'It was the instance default, which is now the Workers AI fallback.'
            : modelId,
      })
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not remove', description: error.message }),
  })

  return (
    <LayerCard className="px-5 py-4">
      {allowed.length === 0 ? (
        <InlineEmpty message="Nothing allowlisted yet. Projects will use the Workers AI fallback." />
      ) : (
        <div className="grid gap-3">
          {allowed.map((model) => (
            <div key={model.id} className="flex flex-wrap items-center justify-between gap-3">
              <div className="grid min-w-0 gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Text as="span">{model.displayName}</Text>
                  <Badge variant="neutral">{PROVIDER_LABELS[model.provider]}</Badge>
                  {model.modelId === defaultModelId ? (
                    <Badge variant="primary">Instance default</Badge>
                  ) : null}
                </div>
                <span className="truncate font-mono text-xs text-kumo-subtle">{model.modelId}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                aria-label={`Remove ${model.displayName}`}
                loading={remove.isPending && remove.variables === model.modelId}
                onClick={() => remove.mutate(model.modelId)}
              >
                <TrashIcon size={16} />
              </Button>
            </div>
          ))}
        </div>
      )}
    </LayerCard>
  )
}

function ManualEntryCard() {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [provider, setProvider] = useState<Provider>('anthropic')
  const [slug, setSlug] = useState('')
  const [displayName, setDisplayName] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      addAllowedModel({
        data: {
          modelId: formatModelId(provider, slug.trim()),
          displayName: displayName.trim() || slug.trim(),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Added to the allowlist', description: slug.trim() })
      setSlug('')
      setDisplayName('')
    },
  })

  return (
    <LayerCard className="px-5 py-4">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          mutation.mutate()
        }}
      >
        <div className="grid gap-1.5">
          <Text as="h3" bold>
            Add a model by name
          </Text>
          <Text variant="secondary" size="xs">
            For anything the catalog does not list — a preview slug, or a provider whose key lives
            somewhere else.
          </Text>
        </div>

        {mutation.error ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="Could not add the model"
            description={mutation.error.message}
          />
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label="Provider"
            items={PROVIDER_ITEMS}
            value={provider}
            onValueChange={(value: Provider | null) => setProvider(value ?? 'anthropic')}
          />
          <Input
            label="Model slug"
            placeholder="claude-sonnet-4-5"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          />
          <Input
            label="Display name"
            description="Optional."
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>

        <div className="flex justify-end">
          <Button
            type="submit"
            variant="secondary"
            loading={mutation.isPending}
            disabled={!slug.trim()}
          >
            <PlusIcon size={16} />
            Add to allowlist
          </Button>
        </div>
      </form>
    </LayerCard>
  )
}

/** Sentinel for "no explicit default", which is a real choice rather than an empty one. */
const FALLBACK_VALUE = '__fallback'

function DefaultModelRow({
  allowed,
  defaultModelId,
}: {
  allowed: Array<AllowedModel>
  defaultModelId: string | null
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const mutation = useMutation({
    mutationFn: (modelId: string | null) =>
      updateInstanceSettings({ data: { defaultModelId: modelId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Default model updated' })
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not save', description: error.message }),
  })

  const items = useMemo(() => {
    const entries: Record<string, string> = {
      [FALLBACK_VALUE]: `Workers AI fallback (${FALLBACK_SLUG})`,
    }
    for (const model of allowed) {
      entries[model.modelId] = `${model.displayName} · ${PROVIDER_LABELS[model.provider]}`
    }
    return entries
  }, [allowed])

  return (
    <SettingRow
      label="Default model"
      hint="A run uses the project's own model first, then this default, then the Workers AI fallback."
    >
      <Select
        aria-label="Default model"
        className="w-72"
        items={items}
        loading={mutation.isPending}
        value={defaultModelId ?? FALLBACK_VALUE}
        onValueChange={(value: string | null) =>
          mutation.mutate(!value || value === FALLBACK_VALUE ? null : value)
        }
      />
    </SettingRow>
  )
}
