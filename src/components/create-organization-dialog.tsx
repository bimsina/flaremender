import { Banner, Button, Dialog, Input, Text, useKumoToastManager } from '@cloudflare/kumo'
import { WarningCircleIcon, XIcon } from '@phosphor-icons/react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'

import { authClient } from '#/lib/auth-client.ts'
import { slugify } from '#/lib/ids.ts'
import { useRefreshSession } from '#/lib/use-refresh-session.ts'

export function CreateOrganizationDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (organizationId: string) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="px-6 py-5">
        <CreateOrganizationForm onOpenChange={onOpenChange} onCreated={onCreated} />
      </Dialog>
    </Dialog.Root>
  )
}

function CreateOrganizationForm({
  onOpenChange,
  onCreated,
}: {
  onOpenChange: (open: boolean) => void
  onCreated?: (organizationId: string) => void
}) {
  const refreshSession = useRefreshSession()
  const toast = useKumoToastManager()

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)

  const effectiveSlug = slugTouched ? slug : slugify(name)

  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await authClient.organization.create({
        name: name.trim(),
        slug: effectiveSlug,
      })
      if (error || !data) throw new Error(error?.message ?? 'Could not create the organization.')
      await authClient.organization.setActive({ organizationId: data.id })
      return data
    },
    onSuccess: async (organization) => {
      await refreshSession()
      toast.add({
        variant: 'success',
        title: 'Organization created',
        description: organization.name,
      })
      onOpenChange(false)
      onCreated?.(organization.id)
    },
  })

  return (
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
              New organization
            </Text>
          </Dialog.Title>
          <Dialog.Description>
            <Text as="span" variant="secondary">
              Projects, intents and runs all live inside an organization.
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
          title="Could not create organization"
          description={mutation.error.message}
        />
      ) : null}

      <div className="grid gap-4">
        <Input
          label="Name"
          placeholder="Acme Inc."
          required
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
          disabled={!name.trim()}
        >
          Create organization
        </Button>
      </div>
    </form>
  )
}
