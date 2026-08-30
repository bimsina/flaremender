import { Badge, Button, Empty, LayerCard, Loader, Table, Text } from '@cloudflare/kumo'
import { BuildingsIcon, CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Fragment, useState } from 'react'

import { PageBody } from '#/components/page.tsx'
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
        <LayerCard className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head className="w-0" />
                  <Table.Head>Name</Table.Head>
                  <Table.Head>Slug</Table.Head>
                  <Table.Head>Members</Table.Head>
                  <Table.Head>Projects</Table.Head>
                  <Table.Head>Created</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {organizations.map((org) => (
                  <Fragment key={org.id}>
                    <Table.Row>
                      <Table.Cell>
                        <Button
                          variant="ghost"
                          shape="square"
                          size="sm"
                          aria-label={expanded === org.id ? 'Collapse members' : 'Expand members'}
                          onClick={() => setExpanded(expanded === org.id ? null : org.id)}
                        >
                          {expanded === org.id ? (
                            <CaretDownIcon size={14} />
                          ) : (
                            <CaretRightIcon size={14} />
                          )}
                        </Button>
                      </Table.Cell>
                      <Table.Cell>{org.name}</Table.Cell>
                      <Table.Cell>
                        <Text as="span" variant="mono-secondary">
                          {org.slug}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>{org.members}</Table.Cell>
                      <Table.Cell>{org.projects}</Table.Cell>
                      <Table.Cell>{formatDate(org.createdAt)}</Table.Cell>
                    </Table.Row>
                    {expanded === org.id ? (
                      <Table.Row>
                        <Table.Cell colSpan={6} className="bg-kumo-tint">
                          <MemberList organizationId={org.id} />
                        </Table.Cell>
                      </Table.Row>
                    ) : null}
                  </Fragment>
                ))}
              </Table.Body>
            </Table>
          </div>
        </LayerCard>
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
          <Badge variant={member.role === 'owner' ? 'primary' : 'neutral'}>{member.role}</Badge>
          {member.banned ? (
            <Badge variant="error" appearance="dot">
              Banned
            </Badge>
          ) : null}
          <Text as="span" variant="secondary" size="xs">
            joined {formatDate(member.createdAt)}
          </Text>
        </li>
      ))}
    </ul>
  )
}
