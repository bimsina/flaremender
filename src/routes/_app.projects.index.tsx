import {
  Badge,
  Banner,
  Button,
  Dialog,
  Empty,
  Input,
  InputArea,
  LayerCard,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { FolderIcon, PlusIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { PageBody, PageHeader } from '#/components/page.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { projectsQuery } from '#/lib/queries.ts'
import { createProject } from '#/server/projects.ts'

export const Route = createFileRoute('/_app/projects/')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({ ...projectsQuery(), revalidateIfStale: true }),
  component: Projects,
})

function Projects() {
  const { data: projects } = useSuspenseQuery(projectsQuery())
  const [creating, setCreating] = useState(false)

  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project points at one base URL and owns its own test cases."
        actions={
          <Button variant="primary" icon={<PlusIcon size={16} />} onClick={() => setCreating(true)}>
            New project
          </Button>
        }
      />

      <PageBody>
        {projects.length === 0 ? (
          <Empty
            icon={<FolderIcon size={48} className="text-kumo-inactive" />}
            title="No projects yet"
            description="A project is a base URL plus the test cases that run against it."
            contents={
              <Button
                variant="primary"
                icon={<PlusIcon size={16} />}
                onClick={() => setCreating(true)}
              >
                Create your first project
              </Button>
            }
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: project.id }}
                  className="block h-full"
                >
                  <LayerCard className="h-full px-5 py-4 hover:bg-kumo-tint">
                    <div className="grid h-full content-start gap-3">
                      <div className="grid gap-1.5">
                        <Text as="h2" variant="heading" truncate>
                          {project.name}
                        </Text>
                        <Text variant="mono-secondary" truncate>
                          {project.baseUrl}
                        </Text>
                      </div>

                      {project.description ? (
                        <Text variant="secondary">{project.description}</Text>
                      ) : null}

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="neutral">
                          {project.testCount} test{project.testCount === 1 ? '' : 's'}
                        </Badge>
                        {project.passingCount > 0 ? (
                          <Badge variant="success" appearance="dot">
                            {project.passingCount} passing
                          </Badge>
                        ) : null}
                        {project.failingCount > 0 ? (
                          <Badge variant="error" appearance="dot">
                            {project.failingCount} failing
                          </Badge>
                        ) : null}
                      </div>

                      <Text variant="secondary" size="xs">
                        Updated <RelativeTime value={project.updatedAt} />
                      </Text>
                    </div>
                  </LayerCard>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageBody>

      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}

function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="px-6 py-5">
        <CreateProjectForm onOpenChange={onOpenChange} />
      </Dialog>
    </Dialog.Root>
  )
}

function CreateProjectForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const toast = useKumoToastManager()

  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [description, setDescription] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      createProject({
        data: { name: name.trim(), baseUrl, description: description.trim() || null },
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries()
      toast.add({ variant: 'success', title: 'Project created', description: name })
      onOpenChange(false)
      await navigate({ to: '/projects/$projectId', params: { projectId: result.id } })
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
              New project
            </Text>
          </Dialog.Title>
          <Dialog.Description>
            <Text as="span" variant="secondary">
              Generated specs navigate relative to the base URL you set here.
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
          title="Could not create project"
          description={mutation.error.message}
        />
      ) : null}

      <div className="grid gap-4">
        <Input
          label="Name"
          placeholder="Marketing site"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          label="Base URL"
          description="Where the generated tests point."
          placeholder="https://example.com"
          required
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <InputArea
          label="Description"
          description="Optional. What this suite covers."
          placeholder="Checkout and signup flows for the storefront."
          autoResize
          minRows={3}
          maxRows={8}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
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
          disabled={!name.trim() || !baseUrl.trim()}
        >
          Create project
        </Button>
      </div>
    </form>
  )
}
