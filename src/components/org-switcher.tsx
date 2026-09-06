import { Button, Combobox, Text } from '@cloudflare/kumo'
import { CaretUpDownIcon, PlusIcon } from '@phosphor-icons/react'
import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { authClient } from '#/lib/auth-client.ts'
import { useRefreshSession } from '#/lib/use-refresh-session.ts'
import type { AppSession } from '#/server/session.ts'
import { CreateOrganizationDialog } from './create-organization-dialog.tsx'
import { Logo } from './logo.tsx'

export function OrgSwitcher({ session }: { session: AppSession }) {
  const router = useRouter()
  const refreshSession = useRefreshSession()
  const [creating, setCreating] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = session.organizations.find((org) => org.id === session.activeOrganizationId)

  async function switchTo(organizationId: string) {
    if (organizationId === session.activeOrganizationId || switching) return
    setSwitching(true)
    setError(null)
    try {
      const result = await authClient.organization.setActive({ organizationId })
      if (result.error) throw new Error(result.error.message ?? 'Could not switch organization.')
      await refreshSession()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not switch organization. Try again.')
      setOpen(true)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <>
      <Combobox
        items={session.organizations}
        value={active ?? null}
        itemToStringLabel={(org) => org.name}
        itemToStringValue={(org) => org.id}
        isItemEqualToValue={(a, b) => a.id === b.id}
        onValueChange={(org) => {
          if (org) void switchTo(org.id)
        }}
        open={open}
        onOpenChange={setOpen}
      >
        <Combobox.Trigger
          render={
            <Button
              variant="ghost"
              loading={switching}
              disabled={switching}
              aria-label="Switch organization"
              className="h-8.5 min-w-0 flex-1 justify-between px-2 font-normal group-data-[state=collapsed]/sidebar:w-8.5 group-data-[state=collapsed]/sidebar:flex-none group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0"
            >
              <Logo size={24} className="hidden group-data-[state=collapsed]/sidebar:block" />
              <span className="truncate group-data-[state=collapsed]/sidebar:hidden">
                {active?.name ?? 'No organization'}
              </span>
              <CaretUpDownIcon
                size={14}
                className="shrink-0 text-kumo-subtle group-data-[state=collapsed]/sidebar:hidden"
              />
            </Button>
          }
        />
        <Combobox.Content align="start" className="w-80 max-w-[calc(100vw-32px)]">
          <div className="p-2">
            <Combobox.Input
              aria-label="Search organizations"
              placeholder="Search for an organization..."
            />
          </div>
          {error ? (
            <p role="alert" className="px-3 py-2 text-base text-kumo-danger">
              {error}
            </p>
          ) : null}
          <Combobox.List aria-label="Organizations">
            {(org: AppSession['organizations'][number]) => (
              <Combobox.Item key={org.id} value={org} disabled={switching}>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="truncate">{org.name}</span>
                  <Text as="span" variant="secondary" size="base">
                    {org.role}
                  </Text>
                </span>
              </Combobox.Item>
            )}
          </Combobox.List>
          <Combobox.Empty>No organizations found.</Combobox.Empty>
          <div className="border-t border-kumo-line p-2">
            <Button
              variant="ghost"
              icon={PlusIcon}
              className="w-full justify-start font-normal"
              onClick={() => {
                setOpen(false)
                setCreating(true)
              }}
            >
              New organization
            </Button>
          </div>
          <div className="border-t border-kumo-line px-3 py-2 text-base text-kumo-subtle">
            {session.organizations.length}{' '}
            {session.organizations.length === 1 ? 'organization' : 'organizations'}
          </div>
        </Combobox.Content>
      </Combobox>
      <CreateOrganizationDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => void router.invalidate()}
      />
    </>
  )
}
