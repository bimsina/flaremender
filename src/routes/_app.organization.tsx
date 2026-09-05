import { Table, TablePagination, useTablePagination } from '#/components/table.tsx'
import {
  Badge,
  Banner,
  Button,
  ClipboardText,
  Dialog,
  DropdownMenu,
  Empty,
  Input,
  LayerCard,
  Loader,
  Select,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import {
  CopyIcon,
  DotsThreeIcon,
  EnvelopeSimpleIcon,
  InfoIcon,
  SignOutIcon,
  TrashIcon,
  UserPlusIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { MenuRadioItem } from '#/components/menu-radio-item.tsx'
import { ListToolbar } from '#/components/list.tsx'
import { OrganizationProviderKeys } from '#/components/org-provider-keys.tsx'
import { HealPolicySelect, describeHealPolicy } from '#/components/heal-policy-select.tsx'
import { SettingRow } from '#/components/list.tsx'
import { instanceSettingsQuery, organizationSettingsQuery } from '#/lib/queries.ts'
import { setOrganizationAiGateway, setOrganizationHealPolicy } from '#/server/repairs.ts'
import { AiGatewayRow } from '#/components/ai-gateway-row.tsx'
import { PageBody, PageHeader } from '#/components/page.tsx'
import { authClient } from '#/lib/auth-client.ts'
import { formatDate } from '#/lib/format.ts'
import { RelativeTime } from '#/components/relative-time.tsx'

export const Route = createFileRoute('/_app/organization')({ component: OrganizationPage })

const ROLES = { member: 'Member', admin: 'Admin', owner: 'Owner' }

function useFullOrganization(organizationId: string | null) {
  return useQuery({
    queryKey: ['full-organization', organizationId] as const,
    enabled: organizationId !== null,
    queryFn: async () => {
      const { data, error } = await authClient.organization.getFullOrganization()
      if (error) throw new Error(error.message ?? 'Could not load the organization.')
      return data
    },
  })
}

function OrganizationPage() {
  const { session } = Route.useRouteContext()
  const activeOrgId = session.activeOrganizationId
  const { data: org, isPending, error } = useFullOrganization(activeOrgId)

  const myRole = session.organizations.find((o) => o.id === activeOrgId)?.role ?? 'member'
  const canManage = myRole === 'owner' || myRole === 'admin'

  const [inviting, setInviting] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')

  const members = org?.members ?? []
  const invitations = (org?.invitations ?? []).filter((i) => i.status === 'pending')
  const visibleMembers = members.filter(
    (member) =>
      (roleFilter === 'all' || member.role === roleFilter) &&
      `${member.user.name} ${member.user.email}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  )
  const memberPagination = useTablePagination(
    visibleMembers,
    `${activeOrgId}:${search}:${roleFilter}`,
  )
  const invitationPagination = useTablePagination(invitations, activeOrgId ?? '')

  return (
    <>
      <PageHeader
        title="Members"
        description={
          org
            ? `${org.name} · ${members.length} member${members.length === 1 ? '' : 's'}`
            : 'Manage access to this organization.'
        }
        actions={
          <>
            {canManage ? (
              <Button
                variant="primary"
                icon={<UserPlusIcon size={16} />}
                onClick={() => setInviting(true)}
              >
                Invite member
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <Button variant="secondary" shape="square" aria-label="Organization actions">
                    <DotsThreeIcon size={16} weight="bold" />
                  </Button>
                }
              />
              <DropdownMenu.Content>
                <DropdownMenu.Item disabled={!canManage} onClick={() => setRenaming(true)}>
                  Rename organization
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  icon={SignOutIcon}
                  variant="danger"
                  disabled={myRole === 'owner'}
                  onClick={() => setLeaving(true)}
                >
                  Leave organization
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          </>
        }
      />

      <PageBody className="grid gap-8">
        {error ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="Could not load organization"
            description={error.message}
          />
        ) : null}

        {isPending ? (
          <LayerCard className="flex items-center justify-center px-5 py-10">
            <Loader size={20} />
          </LayerCard>
        ) : (
          <Table
            label="Members"
            footer={<TablePagination {...memberPagination} />}
            toolbar={
              <ListToolbar value={search} onValueChange={setSearch} placeholder="Search members">
                <Select
                  aria-label="Filter members by role"
                  className="w-40"
                  items={{ all: 'All roles', ...ROLES }}
                  value={roleFilter}
                  onValueChange={(value: string | null) => setRoleFilter(value ?? 'all')}
                />
              </ListToolbar>
            }
          >
            <Table.Header>
              <Table.Row>
                <Table.Head>Name</Table.Head>
                <Table.Head>Email</Table.Head>
                <Table.Head>Role</Table.Head>
                <Table.Head>Joined</Table.Head>
                <Table.Head className="w-0">
                  <span className="sr-only">Actions</span>
                </Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {memberPagination.items.map((member) => (
                <Table.Row key={member.id}>
                  <Table.Cell>
                    <span className="flex items-center gap-2 font-medium whitespace-nowrap">
                      {member.user.name}
                      {member.userId === session.user.id ? (
                        <Badge variant="secondary" className="rounded-md text-base">
                          You
                        </Badge>
                      ) : null}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    <Text as="span" variant="secondary">
                      {member.user.email}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge variant="secondary" className="rounded-md text-base">
                      {ROLES[member.role as keyof typeof ROLES] ?? member.role}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap text-kumo-subtle">
                    {formatDate(member.createdAt)}
                  </Table.Cell>
                  <Table.Cell>
                    <MemberActions
                      memberId={member.id}
                      memberName={member.user.name}
                      memberEmail={member.user.email}
                      role={member.role}
                      disabled={
                        !canManage || member.role === 'owner' || member.userId === session.user.id
                      }
                    />
                  </Table.Cell>
                </Table.Row>
              ))}
              {memberPagination.items.length === 0 ? (
                <Table.Empty
                  columns={5}
                  message="No members match your filters"
                  onClear={() => {
                    setSearch('')
                    setRoleFilter('all')
                  }}
                />
              ) : null}
            </Table.Body>
          </Table>
        )}

        <section className="grid gap-3">
          <div className="grid gap-1.5">
            <Text as="h2" variant="heading">
              Pending invitations
            </Text>
            <Text variant="secondary">
              No email provider is wired up yet, so share the invite link yourself.
            </Text>
          </div>

          {invitations.length === 0 ? (
            <Empty
              size="sm"
              icon={<EnvelopeSimpleIcon size={32} className="text-kumo-inactive" />}
              title="No pending invitations"
              description={
                canManage
                  ? 'Invite someone and their link will appear here.'
                  : 'Only owners and admins can invite people.'
              }
            />
          ) : (
            <Table
              label="Pending invitations"
              footer={<TablePagination {...invitationPagination} />}
            >
              <Table.Header>
                <Table.Row>
                  <Table.Head>Email</Table.Head>
                  <Table.Head>Role</Table.Head>
                  <Table.Head>Expires</Table.Head>
                  <Table.Head className="w-0">
                    <span className="sr-only">Actions</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {invitationPagination.items.map((invitation) => (
                  <Table.Row key={invitation.id}>
                    <Table.Cell>{invitation.email}</Table.Cell>
                    <Table.Cell>
                      <Badge variant="secondary" className="rounded-md text-base">
                        {ROLES[invitation.role as keyof typeof ROLES] ?? invitation.role}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <RelativeTime value={invitation.expiresAt} />
                    </Table.Cell>
                    <Table.Cell>
                      <InvitationActions invitationId={invitation.id} disabled={!canManage} />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
        </section>

        <section className="grid gap-3">
          <div className="grid gap-1.5">
            <Text as="h2" variant="heading">
              Model providers
            </Text>
            <Text variant="secondary">
              Keys saved here are used for every generation, exploration and chat turn in this
              organization, ahead of anything the instance provides.
              {canManage ? '' : ' Only owners and admins can change them.'}
            </Text>
          </div>
          <OrganizationProviderKeys />
        </section>

        <section className="grid gap-3">
          <div className="grid gap-1.5">
            <Text as="h2" variant="heading">
              Repairs
            </Text>
            <Text variant="secondary">
              What the agent may do when a ready test fails. Projects and tests can override this.
              {canManage ? '' : ' Only owners and admins can change it.'}
            </Text>
          </div>
          <OrganizationRepairPolicy canManage={canManage} />
        </section>

        <section className="grid gap-3">
          <div className="grid gap-1.5">
            <Text as="h2" variant="heading">
              AI Gateway
            </Text>
            <Text variant="secondary">
              Route this organization's model calls through a gateway of its own to see its usage
              and spend separately in the Cloudflare dashboard.
              {canManage ? '' : ' Only owners and admins can change it.'}
            </Text>
          </div>
          <OrganizationAiGateway canManage={canManage} isAdmin={session.user.role === 'admin'} />
        </section>
      </PageBody>

      <InviteMemberDialog open={inviting} onOpenChange={setInviting} />
      <RenameOrganizationDialog
        open={renaming}
        onOpenChange={setRenaming}
        organizationId={activeOrgId}
        currentName={org?.name ?? ''}
      />
      <LeaveOrganizationDialog
        open={leaving}
        onOpenChange={setLeaving}
        organizationId={activeOrgId}
      />
    </>
  )
}

function OrganizationAiGateway({ canManage, isAdmin }: { canManage: boolean; isAdmin: boolean }) {
  const settings = useQuery(organizationSettingsQuery())
  const instance = useQuery({ ...instanceSettingsQuery(), enabled: isAdmin })

  return (
    <AiGatewayRow
      scope="organization"
      value={settings.data?.aiGatewayId ?? null}
      inherited={instance.data?.aiGatewayId ?? null}
      canManage={canManage}
      save={(aiGatewayId) => setOrganizationAiGateway({ data: { aiGatewayId } })}
    />
  )
}

function OrganizationRepairPolicy({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const settings = useQuery(organizationSettingsQuery())

  const save = useMutation({
    mutationFn: (healPolicy: 'off' | 'draft' | 'auto') =>
      setOrganizationHealPolicy({ data: { healPolicy } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: organizationSettingsQuery().queryKey })
      toast.add({ variant: 'success', title: 'Repair policy saved' })
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not save', description: error.message }),
  })

  const policy = settings.data?.healPolicy ?? 'off'

  return (
    <SettingRow label="When a ready test fails" hint={describeHealPolicy(policy)}>
      <HealPolicySelect
        aria-label="Repair policy"
        value={policy}
        loading={settings.isPending || save.isPending}
        disabled={!canManage}
        onChange={(next) => {
          if (next !== 'inherit') save.mutate(next)
        }}
      />
    </SettingRow>
  )
}

function MemberActions({
  memberId,
  memberName,
  memberEmail,
  role,
  disabled,
}: {
  memberId: string
  memberName: string
  memberEmail: string
  role: string
  disabled: boolean
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const changeRole = useMutation({
    mutationFn: async (nextRole: string) => {
      const { error } = await authClient.organization.updateMemberRole({
        memberId,
        role: nextRole as 'member' | 'admin' | 'owner',
      })
      if (error) throw new Error(error.message ?? 'Could not change the role.')
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Role updated', description: memberName })
    },
    onError: (mutationError) =>
      toast.add({
        variant: 'error',
        title: 'Could not update role',
        description: mutationError.message,
      }),
  })

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.removeMember({ memberIdOrEmail: memberEmail })
      if (error) throw new Error(error.message ?? 'Could not remove the member.')
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Member removed', description: memberName })
    },
    onError: (mutationError) =>
      toast.add({
        variant: 'error',
        title: 'Could not remove member',
        description: mutationError.message,
      }),
  })

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              disabled={disabled}
              loading={changeRole.isPending || remove.isPending}
              aria-label={`Actions for ${memberName}`}
            >
              <DotsThreeIcon size={16} weight="bold" />
            </Button>
          }
        />
        <DropdownMenu.Content>
          <DropdownMenu.RadioGroup value={role} onValueChange={(next) => changeRole.mutate(next)}>
            <DropdownMenu.Label>Role</DropdownMenu.Label>
            <MenuRadioItem value="member">Member</MenuRadioItem>
            <MenuRadioItem value="admin">Admin</MenuRadioItem>
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator />
          <DropdownMenu.Item icon={TrashIcon} variant="danger" onClick={() => remove.mutate()}>
            Remove from organization
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  )
}

function InvitationActions({
  invitationId,
  disabled,
}: {
  invitationId: string
  disabled: boolean
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const cancel = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.cancelInvitation({ invitationId })
      if (error) throw new Error(error.message ?? 'Could not cancel the invitation.')
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Invitation cancelled' })
    },
  })

  async function copyLink() {
    const link = `${window.location.origin}/accept-invitation/${invitationId}`
    await navigator.clipboard.writeText(link)
    toast.add({ variant: 'success', title: 'Invite link copied', description: link })
  }

  return (
    <div className="flex justify-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        icon={<CopyIcon size={14} />}
        onClick={() => void copyLink()}
      >
        Copy link
      </Button>
      <Button
        variant="ghost"
        shape="square"
        size="sm"
        disabled={disabled}
        loading={cancel.isPending}
        aria-label="Cancel invitation"
        onClick={() => cancel.mutate()}
      >
        <XIcon size={14} />
      </Button>
    </div>
  )
}

function InviteMemberDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="px-6 py-5">
        <InviteMemberForm />
      </Dialog>
    </Dialog.Root>
  )
}

function InviteMemberForm() {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('member')
  const [link, setLink] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await authClient.organization.inviteMember({
        email: email.trim(),
        role: role as 'member' | 'admin' | 'owner',
      })
      if (error || !data) throw new Error(error?.message ?? 'Could not send the invitation.')
      return data
    },
    onSuccess: async (invitation) => {
      await queryClient.invalidateQueries()
      setLink(`${window.location.origin}/accept-invitation/${invitation.id}`)
      setEmail('')
      toast.add({ variant: 'success', title: 'Invitation created' })
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
              Invite a member
            </Text>
          </Dialog.Title>
          <Dialog.Description>
            <Text as="span" variant="secondary">
              They will join this organization and see all of its projects.
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
          title="Could not invite"
          description={mutation.error.message}
        />
      ) : null}

      {link ? (
        <div className="grid gap-2 rounded-lg bg-kumo-recessed px-4 py-3">
          <div className="flex items-start gap-2">
            <span className="h-lh flex items-center">
              <InfoIcon size={16} weight="fill" className="text-kumo-info" />
            </span>
            <Text variant="secondary">No email was sent. Share this link with them directly.</Text>
          </div>
          <ClipboardText text={link} size="sm" className="min-w-0" />
        </div>
      ) : null}

      <div className="grid gap-4">
        <Input
          label="Email"
          type="email"
          placeholder="teammate@example.com"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Select
          label="Role"
          value={role}
          onValueChange={(value) => setRole(value ?? 'member')}
          items={{ member: 'Member', admin: 'Admin' }}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Dialog.Close
          render={(props) => (
            <Button {...props} variant="secondary">
              {link ? 'Done' : 'Cancel'}
            </Button>
          )}
        />
        <Button
          type="submit"
          variant="primary"
          loading={mutation.isPending}
          disabled={!email.trim()}
        >
          Create invitation
        </Button>
      </div>
    </form>
  )
}

function RenameOrganizationDialog({
  open,
  onOpenChange,
  organizationId,
  currentName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationId: string | null
  currentName: string
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="px-6 py-5">
        <RenameOrganizationForm
          organizationId={organizationId}
          currentName={currentName}
          onOpenChange={onOpenChange}
        />
      </Dialog>
    </Dialog.Root>
  )
}

function RenameOrganizationForm({
  organizationId,
  currentName,
  onOpenChange,
}: {
  organizationId: string | null
  currentName: string
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const toast = useKumoToastManager()
  const [name, setName] = useState(currentName)

  const mutation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.update({
        data: { name: name.trim() },
        organizationId: organizationId ?? undefined,
      })
      if (error) throw new Error(error.message ?? 'Could not rename the organization.')
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      await router.invalidate()
      toast.add({ variant: 'success', title: 'Organization renamed' })
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
      <Dialog.Title>
        <Text as="span" variant="heading">
          Rename organization
        </Text>
      </Dialog.Title>

      {mutation.error ? (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="Could not rename"
          description={mutation.error.message}
        />
      ) : null}

      <Input label="Name" required value={name} onChange={(event) => setName(event.target.value)} />

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
          Save
        </Button>
      </div>
    </form>
  )
}

function LeaveOrganizationDialog({
  open,
  onOpenChange,
  organizationId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationId: string | null
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const toast = useKumoToastManager()

  const mutation = useMutation({
    mutationFn: async () => {
      if (!organizationId) throw new Error('No active organization.')
      const { error } = await authClient.organization.leave({ organizationId })
      if (error) throw new Error(error.message ?? 'Could not leave the organization.')
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'You left the organization' })
      onOpenChange(false)
      await navigate({ to: '/dashboard' })
    },
  })

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="px-6 py-5">
        <div className="grid gap-5">
          <div className="grid gap-1.5">
            <Dialog.Title>
              <Text as="span" variant="heading">
                Leave this organization?
              </Text>
            </Dialog.Title>
            <Dialog.Description>
              <Text as="span" variant="secondary">
                You will lose access to its projects until someone invites you back.
              </Text>
            </Dialog.Description>
          </div>

          {mutation.error ? (
            <Banner
              variant="error"
              icon={<WarningCircleIcon weight="fill" />}
              title="Could not leave"
              description={mutation.error.message}
            />
          ) : null}

          <div className="flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button {...props} variant="secondary">
                  Cancel
                </Button>
              )}
            />
            <Button
              variant="destructive"
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              Leave organization
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
