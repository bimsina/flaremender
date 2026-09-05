import { Badge, Banner, Button, Dialog, Input, Text, useKumoToastManager } from '@cloudflare/kumo'
import { WarningCircleIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { SettingRow } from '#/components/list.tsx'
import { PROVIDER_LABELS, type Provider } from '#/lib/models.ts'
import { organizationProviderKeysQuery } from '#/lib/queries.ts'
import {
  type OrganizationProviderStatus,
  deleteOrganizationProviderKey,
  setOrganizationProviderKey,
} from '#/server/org-providers.ts'

/**
 * An organization's own model provider keys. They take precedence over the instance's
 * keys, which is how a team brings its own billing.
 */
export function OrganizationProviderKeys() {
  const { data, error, isPending } = useQuery(organizationProviderKeysQuery())

  if (error) {
    return (
      <Banner
        variant="error"
        icon={<WarningCircleIcon weight="fill" />}
        title="Could not load provider keys"
        description={error.message}
      />
    )
  }

  if (isPending || !data) return null

  return (
    <div className="grid gap-3">
      {data.providers.map((status) => (
        <ProviderRow key={status.provider} status={status} canManage={data.canManage} />
      ))}
    </div>
  )
}

function ProviderRow({
  status,
  canManage,
}: {
  status: OrganizationProviderStatus
  canManage: boolean
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const [editing, setEditing] = useState(false)

  const label = PROVIDER_LABELS[status.provider]
  const own = status.ownKeyHint !== null

  const remove = useMutation({
    mutationFn: () => deleteOrganizationProviderKey({ data: { provider: status.provider } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: organizationProviderKeysQuery().queryKey })
      toast.add({ variant: 'success', title: 'Key removed', description: label })
    },
    onError: (error: Error) =>
      toast.add({
        variant: 'error',
        title: 'Could not remove the key',
        description: error.message,
      }),
  })

  const hint = own
    ? `This organization's own key — ${status.ownKeyHint}. Billed to you, not to the instance.`
    : status.instanceCovers
      ? 'No key of your own. Model calls use the key the instance provides.'
      : 'No key anywhere, so models from this provider cannot run for this organization.'

  return (
    <>
      <SettingRow label={label} hint={hint}>
        {own ? (
          <>
            {canManage ? (
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                Replace
              </Button>
            ) : null}
            {canManage ? (
              <Button
                variant="ghost"
                size="sm"
                loading={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Remove
              </Button>
            ) : (
              <Badge variant="neutral">Own key</Badge>
            )}
          </>
        ) : canManage ? (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Add key
          </Button>
        ) : (
          <Badge variant="neutral" appearance="dot">
            {status.instanceCovers ? 'Instance key' : 'No key'}
          </Badge>
        )}
      </SettingRow>

      <ProviderKeyDialog
        provider={status.provider}
        replacing={own}
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
    mutationFn: () => setOrganizationProviderKey({ data: { provider, key: key.trim() } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: organizationProviderKeysQuery().queryKey })
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
                  Stored encrypted and used for every model call this organization makes. Only the
                  last four characters are ever shown again.
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
