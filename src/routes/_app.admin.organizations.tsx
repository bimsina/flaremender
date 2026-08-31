import { Table, TablePagination, useTablePagination } from '#/components/table.tsx'
import { Badge, Button, Empty, Loader, Text } from '@cloudflare/kumo'
import { BuildingsIcon, CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Fragment, useState } from 'react'

import { PageBody } from '#/components/page.tsx'
import { ListToolbar } from '#/components/list.tsx'
import { formatDate } from '#/lib/format.ts'
import { adminMembershipsQuery, adminOrganizationsQuery } from '#/lib/queries.ts'

export const Route = createFileRoute('/_app/admin/organizations')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({
      ...adminOrganizationsQuery(),
      revalidateIfStale: true,
    }),
  component: AdminOrganizations,
})

function AdminOrganizations() {
  const { data: organizations } = useSuspenseQuery(adminOrganizationsQuery())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [ascending, setAscending] = useState(true)
  const visible = organizations
    .filter((org) => `${org.name} ${org.slug}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => (ascending ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)))
  const pagination = useTablePagination(visible, `${search}:${ascending}`)

  return (
    <PageBody className="grid gap-3">
      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Organizations
        </Text>
        <Text variant="secondary">
          Every tenant on this instance. Expand one to see its members.
        </Text>
      </div>

      {organizations.length === 0 ? (
        <Empty
          icon={<BuildingsIcon size={48} className="text-kumo-inactive" />}
          title="No organizations yet"
          description="They appear here as soon as someone signs up and creates one."
        />
      ) : (
        <Table
          label="Organizations"
          footer={<TablePagination {...pagination} />}
          toolbar={
            <ListToolbar
              value={search}
              onValueChange={setSearch}
              placeholder="Search organizations"
            />
          }
        >
          <Table.Header>
            <Table.Row>
              <Table.Head className="w-0">
                <span className="sr-only">Expand members</span>
              </Table.Head>
              <Table.SortHead
                direction={ascending ? 'asc' : 'desc'}
                onSort={() => setAscending(!ascending)}
              >
                Name
              </Table.SortHead>
              <Table.Head>Slug</Table.Head>
              <Table.Head className="text-right">Members</Table.Head>
              <Table.Head className="text-right">Projects</Table.Head>
              <Table.Head>Created</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {pagination.items.map((org) => (
              <Fragment key={org.id}>
                <Table.Row data-expanded={expanded === org.id}>
                  <Table.Cell>
                    <Button
                      variant="ghost"
                      shape="square"
                      size="sm"
                      aria-label={expanded === org.id ? 'Collapse members' : 'Expand members'}
                      aria-expanded={expanded === org.id}
                      aria-controls={`organization-members-${org.id}`}
                      onClick={() => setExpanded(expanded === org.id ? null : org.id)}
                    >
                      {expanded === org.id ? (
                        <CaretDownIcon size={14} />
                      ) : (
                        <CaretRightIcon size={14} />
                      )}
                    </Button>
                  </Table.Cell>
                  <Table.Cell className="font-medium whitespace-nowrap">{org.name}</Table.Cell>
                  <Table.Cell>
                    <Text as="span" variant="mono-secondary">
                      {org.slug}
                    </Text>
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{org.members}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{org.projects}</Table.Cell>
                  <Table.Cell className="whitespace-nowrap text-kumo-subtle">
                    {formatDate(org.createdAt)}
                  </Table.Cell>
                </Table.Row>
                {expanded === org.id ? (
                  <Table.Row>
                    <Table.Cell
                      id={`organization-members-${org.id}`}
                      colSpan={6}
                      className="bg-kumo-recessed"
                    >
                      <MemberList organizationId={org.id} />
                    </Table.Cell>
                  </Table.Row>
                ) : null}
              </Fragment>
            ))}
            {pagination.items.length === 0 ? (
              <Table.Empty
                columns={6}
                message="No organizations match your search"
                onClear={() => setSearch('')}
              />
            ) : null}
          </Table.Body>
        </Table>
      )}
    </PageBody>
  )
}

function MemberList({ organizationId }: { organizationId: string }) {
  const { data, isPending } = useQuery(adminMembershipsQuery(organizationId))

  if (isPending) {
    return (
      <div className="flex justify-center py-4">
        <Loader size={16} />
      </div>
    )
  }

  if (!data || data.length === 0) {
    return (
      <div className="py-2">
        <Text variant="secondary">No members.</Text>
      </div>
    )
  }

  return (
    <ul className="grid gap-2 py-2">
      {data.map((member) => (
        <li key={member.id} className="flex flex-wrap items-center gap-3">
          <Text as="span">{member.name}</Text>
          <Text as="span" variant="secondary">
            {member.email}
          </Text>
          <Badge variant="secondary" className="rounded-md text-base">
            {member.role}
          </Badge>
          {member.banned ? (
            <Badge variant="error" className="rounded-md text-base">
              Banned
            </Badge>
          ) : null}
          <Text as="span" variant="secondary" size="base">
            joined {formatDate(member.createdAt)}
          </Text>
        </li>
      ))}
    </ul>
  )
}
