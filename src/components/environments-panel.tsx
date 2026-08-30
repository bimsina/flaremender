/**
 * Environments and their credentials.
 *
 * A variable is write-only by design: the server hands back a four-character
 * hint and nothing else, so this panel can say *which* value is stored without
 * ever holding it. Editing one means setting it again, which is why the add row
 * doubles as the replace row.
 */
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Collapsible,
  Dialog,
  DropdownMenu,
  Empty,
  Input,
  SensitiveInput,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import {
  CaretDownIcon,
  DotsThreeIcon,
  KeyIcon,
  PencilSimpleIcon,
  PlusIcon,
  StackIcon,
  StarIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { InlineEmpty, ListRow, Section } from '#/components/list.tsx'
import { environmentsQuery } from '#/lib/queries.ts'
import {
  createEnvironment,
  deleteEnvironment,
  deleteEnvironmentVariable,
  setDefaultEnvironment,
  setEnvironmentVariable,
  updateEnvironment,
} from '#/server/environments.ts'

type EnvironmentRow = {
  id: string
  name: string
  baseUrl: string
  isDefault: boolean
  variables: Array<{ id: string; name: string; hint: string | null }>
}

export function EnvironmentsPanel({ projectId }: { projectId: string }) {
  const { data: environments } = useSuspenseQuery(environmentsQuery(projectId))
  const [creating, setCreating] = useState(false)

  return (
    <>
      <div className="grid gap-6">
        <Section
          title="Environments"
          description="Where a run points, and the credentials it may read."
          actions={
            <Button
              variant="secondary"
              size="sm"
              icon={<PlusIcon size={14} />}
              onClick={() => setCreating(true)}
            >
              Add environment
            </Button>
          }
        >
          {environments.length === 0 ? (
            <Empty
              icon={<StackIcon size={48} className="text-kumo-inactive" />}
              title="No environments found"
              description="An environment is a base URL plus the credentials a script may read. Nothing can run without one."
              contents={
                <Button
                  variant="primary"
                  icon={<PlusIcon size={16} />}
                  onClick={() => setCreating(true)}
                >
                  Add environment
                </Button>
              }
            />
          ) : (
            <ul className="grid gap-3">
              {environments.map((environment) => (
                <li key={environment.id}>
                  <EnvironmentCard environment={environment} onlyOne={environments.length === 1} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Banner
          variant="alert"
          icon={<WarningCircleIcon weight="fill" />}
          title="Variable values are write-only"
          description="Values are stored encrypted and only the last four characters are shown. To change one, set it again."
        />
      </div>

      <EnvironmentDialog
        projectId={projectId}
        environment={null}
        open={creating}
        onOpenChange={setCreating}
      />
    </>
  )
}

function EnvironmentCard({
  environment,
  onlyOne,
}: {
  environment: EnvironmentRow
  onlyOne: boolean
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)

  const promote = useMutation({
    mutationFn: () => setDefaultEnvironment({ data: { environmentId: environment.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: `${environment.name} is now the default` })
    },
  })

  const remove = useMutation({
    mutationFn: () => deleteEnvironment({ data: { environmentId: environment.id } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: 'success',
        title: 'Environment deleted',
        // A project always has a default, so deleting the current one promotes
        // the oldest survivor — say so rather than let it happen silently.
        description: result.promoted ? 'Another environment became the default.' : environment.name,
      })
    },
    onError: (error: Error) => {
      toast.add({ variant: 'error', title: 'Could not delete', description: error.message })
    },
  })

  const count = environment.variables.length

  return (
    <>
      <ListRow
        icon={<StackIcon size={18} />}
        title={
          <div className="flex flex-wrap items-center gap-2">
            <Text as="span" bold truncate>
              {environment.name}
            </Text>
            {environment.isDefault ? <Badge variant="primary">Default</Badge> : null}
          </div>
        }
        subtitle={
          <Text variant="mono-secondary" truncate>
            {environment.baseUrl}
          </Text>
        }
        meta={
          <Text as="span" variant="secondary" size="xs">
            {count} variable{count === 1 ? '' : 's'}
          </Text>
        }
        actions={
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  aria-label={`Actions for ${environment.name}`}
                >
                  <DotsThreeIcon size={16} weight="bold" />
                </Button>
              }
            />
            <DropdownMenu.Content>
              <DropdownMenu.Item icon={PencilSimpleIcon} onClick={() => setEditing(true)}>
                Edit
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={StarIcon}
                disabled={environment.isDefault || promote.isPending}
                onClick={() => promote.mutate()}
              >
                Make default
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                icon={TrashIcon}
                variant="danger"
                // The server refuses this too; disabling it here just explains why.
                disabled={onlyOne || remove.isPending}
                onClick={() => remove.mutate()}
              >
                {onlyOne ? 'Cannot delete the only one' : 'Delete'}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        }
        footer={
          <Collapsible.Root open={open} onOpenChange={setOpen}>
            <Collapsible.Trigger
              render={
                <Button variant="ghost" size="sm" className="-ml-2" icon={<KeyIcon size={14} />}>
                  <span className="flex items-center gap-1.5">
                    {open ? 'Hide variables' : `Variables (${count})`}
                    <CaretDownIcon size={12} className={open ? 'rotate-180' : undefined} />
                  </span>
                </Button>
              }
            />
            <Collapsible.Panel>
              <div className="pt-3">
                <VariablesEditor environment={environment} />
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        }
      />

      <EnvironmentDialog
        projectId={null}
        environment={environment}
        open={editing}
        onOpenChange={setEditing}
      />
    </>
  )
}

function VariablesEditor({ environment }: { environment: EnvironmentRow }) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [name, setName] = useState('')
  const [value, setValue] = useState('')

  const save = useMutation({
    mutationFn: () =>
      setEnvironmentVariable({
        data: { environmentId: environment.id, name: name.trim(), value },
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      setName('')
      setValue('')
      toast.add({ variant: 'success', title: `${result.name} saved` })
    },
  })

  const existing = environment.variables.some((row) => row.name === name.trim())

  return (
    <div className="grid gap-3">
      {environment.variables.length === 0 ? (
        <InlineEmpty message="No variables. A script reads these with secret('NAME')." />
      ) : (
        <ul className="grid gap-1.5">
          {environment.variables.map((variable) => (
            <li key={variable.id}>
              <VariableRow variable={variable} />
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <Input
          size="sm"
          className="font-mono"
          aria-label="Variable name"
          placeholder="PASSWORD"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <SensitiveInput
          size="sm"
          aria-label="Variable value"
          placeholder="Value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          loading={save.isPending}
          disabled={!name.trim() || value.length === 0}
        >
          {existing ? 'Replace' : 'Add'}
        </Button>
      </form>

      {save.error ? (
        <Text variant="error" size="xs">
          {save.error.message}
        </Text>
      ) : null}
    </div>
  )
}

function VariableRow({
  variable,
}: {
  variable: { id: string; name: string; hint: string | null }
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const remove = useMutation({
    mutationFn: () => deleteEnvironmentVariable({ data: { variableId: variable.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: `${variable.name} removed` })
    },
  })

  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-kumo-recessed px-3 py-2">
      <Text as="span" variant="mono" truncate>
        {variable.name}
      </Text>
      <div className="flex shrink-0 items-center gap-2">
        <Text as="span" variant="mono-secondary">
          {/* Null means the stored envelope no longer decrypts — a rotated key. */}
          {variable.hint ?? 'unreadable'}
        </Text>
        <Button
          variant="ghost"
          shape="square"
          size="xs"
          aria-label={`Delete ${variable.name}`}
          loading={remove.isPending}
          onClick={() => remove.mutate()}
        >
          <TrashIcon size={14} />
        </Button>
      </div>
    </div>
  )
}

function EnvironmentDialog({
  projectId,
  environment,
  open,
  onOpenChange,
}: {
  /** Set when creating; null when editing an existing environment. */
  projectId: string | null
  environment: EnvironmentRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="px-6 py-5">
        <EnvironmentForm
          key={open ? 'open' : 'closed'}
          projectId={projectId}
          environment={environment}
          onOpenChange={onOpenChange}
        />
      </Dialog>
    </Dialog.Root>
  )
}

function EnvironmentForm({
  projectId,
  environment,
  onOpenChange,
}: {
  projectId: string | null
  environment: EnvironmentRow | null
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [name, setName] = useState(environment?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(environment?.baseUrl ?? '')
  const [isDefault, setIsDefault] = useState(false)

  const mutation = useMutation({
    mutationFn: async () => {
      if (environment) {
        await updateEnvironment({
          data: { environmentId: environment.id, name: name.trim(), baseUrl: baseUrl.trim() },
        })
        return
      }
      await createEnvironment({
        data: { projectId: projectId!, name: name.trim(), baseUrl: baseUrl.trim(), isDefault },
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: 'success',
        title: environment ? 'Environment updated' : 'Environment added',
      })
      onOpenChange(false)
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
        <Dialog.Title>
          <Text as="span" variant="heading">
            {environment ? 'Edit environment' : 'Add environment'}
          </Text>
        </Dialog.Title>
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
          title="Could not save"
          description={mutation.error.message}
        />
      ) : null}

      <div className="grid gap-4">
        <Input
          label="Name"
          placeholder="Staging"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          label="Base URL"
          description="Relative URLs in a script resolve against this."
          placeholder="https://staging.example.com"
          required
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        {environment ? null : (
          <Checkbox
            label="Make this the default environment"
            checked={isDefault}
            onCheckedChange={(checked) => setIsDefault(checked === true)}
          />
        )}
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
          disabled={!name.trim() || !baseUrl.trim()}
        >
          {environment ? 'Save changes' : 'Add environment'}
        </Button>
      </div>
    </form>
  )
}
