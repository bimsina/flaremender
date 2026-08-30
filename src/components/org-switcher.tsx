import { Button, DropdownMenu, Text, cn } from '@cloudflare/kumo'
import { BuildingsIcon, CaretUpDownIcon, CheckIcon, PlusIcon } from '@phosphor-icons/react'
import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { authClient } from '#/lib/auth-client.ts'
import { useRefreshSession } from '#/lib/use-refresh-session.ts'
import type { AppSession } from '#/server/session.ts'
import { CreateOrganizationDialog } from './create-organization-dialog.tsx'

export function OrgSwitcher({ session }: { session: AppSession }) {
  const router = useRouter()
  const refreshSession = useRefreshSession()
  const [creating, setCreating] = useState(false)
  const [switching, setSwitching] = useState(false)

  const active = session.organizations.find((org) => org.id === session.activeOrganizationId)

  async function switchTo(organizationId: string) {
    if (organizationId === session.activeOrganizationId) return
    setSwitching(true)
    await authClient.organization.setActive({ organizationId })
    await refreshSession()
    setSwitching(false)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button
              variant="secondary"
              loading={switching}
              className="w-full justify-between"
              aria-label="Switch organization"
            >
              <span className="flex min-w-0 items-center gap-2">
                <BuildingsIcon size={16} className="shrink-0" />
                <span className="truncate">{active?.name ?? 'No organization'}</span>
              </span>
              <CaretUpDownIcon size={14} className="shrink-0 text-kumo-subtle" />
            </Button>
          }
        />
        <DropdownMenu.Content className="min-w-56">
          <DropdownMenu.Group>
            <DropdownMenu.Label>Organizations</DropdownMenu.Label>
            {session.organizations.map((org) => (
              <DropdownMenu.Item
                key={org.id}
                onClick={() => void switchTo(org.id)}
                icon={
                  <CheckIcon
                    size={16}
                    className={cn(org.id === session.activeOrganizationId ? '' : 'opacity-0')}
                  />
                }
              >
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="truncate">{org.name}</span>
                  <Text as="span" variant="secondary" size="xs">
                    {org.role}
                  </Text>
                </span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Group>
          <DropdownMenu.Separator />
          <DropdownMenu.Item icon={PlusIcon} onClick={() => setCreating(true)}>
            New organization
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>

      <CreateOrganizationDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => void router.invalidate()}
      />
    </>
  )
}
