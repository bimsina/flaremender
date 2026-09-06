import { Table, TablePagination, useTablePagination } from '#/components/ui/table.tsx'
import {
  Badge,
  Banner,
  Button,
  Dialog,
  DropdownMenu,
  Input,
  Select,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import {
  DotsThreeIcon,
  ProhibitIcon,
  TrashIcon,
  UserCircleIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { ListToolbar } from '#/components/ui/list.tsx'

import { MenuRadioItem } from '#/components/layout/menu-radio-item.tsx'
import { PageBody, StatTile } from '#/components/layout/page.tsx'
import { authClient } from '#/lib/auth/auth-client.ts'
import { formatDate } from '#/lib/format.ts'
import { adminStatsQuery } from '#/lib/queries.ts'

export const Route = createFileRoute('/_app/admin/')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({ ...adminStatsQuery(), revalidateIfStale: true }),
  component: AdminUsers,
})

interface AdminUser {
  id: string
  name: string
  email: string
  role?: string | null
  banned?: boolean | null
  banReason?: string | null
  createdAt: Date | string
}

function AdminUsers() {
  const { session } = Route.useRouteContext()
  const { data: stats } = useSuspenseQuery(adminStatsQuery())
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)

  const users = useQuery({
    queryKey: ['admin', 'users', search] as const,
    queryFn: async () => {
      const { data, error } = await authClient.admin.listUsers({
        query: {
          limit: 100,
          sortBy: 'createdAt',
          sortDirection: 'desc',
          ...(search
            ? {
                searchField: 'email' as const,
                searchOperator: 'contains' as const,
                searchValue: search,
              }
            : {}),
        },
      })
      if (error) throw new Error(error.message ?? 'Could not load users.')
      return (data?.users ?? []) as Array<AdminUser>
    },
  })

  const pagination = useTablePagination(users.data ?? [], search)

  return (
    <PageBody className="grid gap-8">
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Users" value={stats.users} hint={`${stats.admins} admin`} />
        <StatTile label="Organizations" value={stats.organizations} />
        <StatTile label="Projects" value={stats.projects} hint={`${stats.intents} tests`} />
        <StatTile label="Runs" value={stats.runs} hint={`${stats.banned} banned users`} />
      </section>

      <section className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-1.5">
            <Text as="h2" variant="heading">
              Users
            </Text>
            <Text variant="secondary">Promote, ban or remove accounts across the instance.</Text>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => setCreating(true)}>
              New user
            </Button>
          </div>
        </div>

        {users.error ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="Could not load users"
            description={users.error.message}
          />
        ) : null}

        <Table
          label="Users"
          footer={<TablePagination {...pagination} />}
          toolbar={
            <ListToolbar
              value={search}
              onValueChange={setSearch}
              placeholder="Search by email"
              onRefresh={() => void users.refetch()}
              refreshing={users.isFetching}
            />
          }
        >
          <Table.Header>
            <Table.Row>
              <Table.Head>Name</Table.Head>
              <Table.Head>Email</Table.Head>
              <Table.Head>Role</Table.Head>
              <Table.Head>Status</Table.Head>
              <Table.Head>Joined</Table.Head>
              <Table.Head className="w-0">
                <span className="sr-only">Actions</span>
              </Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {pagination.items.map((user) => (
              <Table.Row key={user.id}>
                <Table.Cell>
                  <span className="flex items-center gap-2 font-medium whitespace-nowrap">
                    <UserCircleIcon size={16} className="text-kumo-subtle" />
                    {user.name}
                    {user.id === session.user.id ? (
                      <Badge variant="secondary" className="rounded-md text-base">
                        You
                      </Badge>
                    ) : null}
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <Text as="span" variant="secondary">
                    {user.email}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  <Badge variant="secondary" className="rounded-md text-base">
                    {user.role ?? 'user'}
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  {user.banned ? (
                    <Badge variant="error" className="rounded-md text-base">
                      Banned
                    </Badge>
                  ) : (
                    <Badge variant="success" className="rounded-md text-base">
                      Active
                    </Badge>
                  )}
                </Table.Cell>
                <Table.Cell className="whitespace-nowrap text-kumo-subtle">
                  {formatDate(user.createdAt)}
                </Table.Cell>
                <Table.Cell>
                  <UserActions user={user} isSelf={user.id === session.user.id} />
                </Table.Cell>
              </Table.Row>
            ))}
            {pagination.items.length === 0 ? (
              <Table.Empty
                columns={6}
                message={users.isPending ? 'Loading users…' : 'No users found'}
                onClear={search && !users.isPending ? () => setSearch('') : undefined}
              />
            ) : null}
          </Table.Body>
        </Table>
      </section>

      <CreateUserDialog open={creating} onOpenChange={setCreating} />
    </PageBody>
  )
}

function UserActions({ user, isSelf }: { user: AdminUser; isSelf: boolean }) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const [removing, setRemoving] = useState(false)

  function report(title: string) {
    return {
      onSuccess: async () => {
        await queryClient.invalidateQueries()
        toast.add({ variant: 'success' as const, title, description: user.email })
      },
      onError: (error: Error) =>
        toast.add({
          variant: 'error' as const,
          title: 'Action failed',
          description: error.message,
        }),
    }
  }

  const setRole = useMutation({
    mutationFn: async (role: string) => {
      const { error } = await authClient.admin.setRole({
        userId: user.id,
        role: role as 'admin' | 'user',
      })
      if (error) throw new Error(error.message ?? 'Could not change the role.')
    },
    ...report('Role updated'),
  })

  const ban = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.admin.banUser({
        userId: user.id,
        banReason: 'Banned by an administrator',
      })
      if (error) throw new Error(error.message ?? 'Could not ban the user.')
    },
    ...report('User banned'),
  })

  const unban = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.admin.unbanUser({ userId: user.id })
      if (error) throw new Error(error.message ?? 'Could not unban the user.')
    },
    ...report('User unbanned'),
  })

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.admin.removeUser({ userId: user.id })
      if (error) throw new Error(error.message ?? 'Could not remove the user.')
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'User removed', description: user.email })
      setRemoving(false)
    },
  })

  const busy = setRole.isPending || ban.isPending || unban.isPending

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              loading={busy}
              aria-label={`Actions for ${user.email}`}
            >
              <DotsThreeIcon size={16} weight="bold" />
            </Button>
          }
        />
        <DropdownMenu.Content>
          <DropdownMenu.RadioGroup
            value={user.role ?? 'user'}
            onValueChange={(role) => setRole.mutate(role)}
          >
            <DropdownMenu.Label>Role</DropdownMenu.Label>
            <MenuRadioItem value="user">User</MenuRadioItem>
            <MenuRadioItem value="admin">Admin</MenuRadioItem>
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator />
          {user.banned ? (
            <DropdownMenu.Item icon={ProhibitIcon} onClick={() => unban.mutate()}>
              Unban user
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.Item
              icon={ProhibitIcon}
              variant="danger"
              disabled={isSelf}
              onClick={() => ban.mutate()}
            >
              Ban user
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            icon={TrashIcon}
            variant="danger"
            disabled={isSelf}
            onClick={() => setRemoving(true)}
          >
            Delete user
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>

      <Dialog.Root open={removing} onOpenChange={setRemoving}>
        <Dialog className="px-6 py-5">
          <div className="grid gap-5">
            <div className="grid gap-1.5">
              <Dialog.Title>
                <Text as="span" variant="heading">
                  Delete {user.email}?
                </Text>
              </Dialog.Title>
              <Dialog.Description>
                <Text as="span" variant="secondary">
                  Their sessions, memberships and anything they created will be removed. This cannot
                  be undone.
                </Text>
              </Dialog.Description>
            </div>

            {remove.error ? (
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" />}
                title="Could not delete"
                description={remove.error.message}
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
                loading={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Delete user
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  )
}

function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('user')

  const mutation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.admin.createUser({
        name: name.trim(),
        email: email.trim(),
        password,
        role: role as 'admin' | 'user',
      })
      if (error) throw new Error(error.message ?? 'Could not create the user.')
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'User created', description: email })
      onOpenChange(false)
      setName('')
      setEmail('')
      setPassword('')
      setRole('user')
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
            <Dialog.Title>
              <Text as="span" variant="heading">
                Create a user
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
              title="Could not create user"
              description={mutation.error.message}
            />
          ) : null}

          <div className="grid gap-4">
            <Input
              label="Name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Input
              label="Email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Input
              label="Password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Select
              label="Role"
              value={role}
              onValueChange={(value) => setRole(value ?? 'user')}
              items={{ user: 'User', admin: 'Admin' }}
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
            <Button type="submit" variant="primary" loading={mutation.isPending}>
              Create user
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
