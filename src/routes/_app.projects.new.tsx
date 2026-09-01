import {
  Banner,
  Breadcrumbs,
  Button,
  Input,
  InputArea,
  LayerCard,
  LinkButton,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { WarningCircleIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, createLink, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { PageBody, PageHeader } from '#/components/page.tsx'
import { Section } from '#/components/list.tsx'
import { createProject } from '#/server/projects.ts'

const RouterLinkButton = createLink(LinkButton)

export const Route = createFileRoute('/_app/projects/new')({
  component: NewProjectPage,
})

function NewProjectPage() {
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
      toast.add({ variant: 'success', title: 'Project created', description: name.trim() })
      await navigate({ to: '/projects/$projectId', params: { projectId: result.id } })
    },
  })

  return (
    <>
      <PageHeader
        title="New project"
        breadcrumbs={
          <Breadcrumbs size="base">
            <Breadcrumbs.Link href="/projects">Projects</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Current>New project</Breadcrumbs.Current>
          </Breadcrumbs>
        }
      />

      <PageBody className="grid gap-6">
        <div className="w-full max-w-3xl">
          <Section
            title="Create project"
            description="The base URL becomes this project's first environment, named Production."
          >
            <LayerCard className="px-5 py-4">
              <form
                className="grid gap-5"
                onSubmit={(event) => {
                  event.preventDefault()
                  mutation.mutate()
                }}
              >
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
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <Input
                    label="Base URL"
                    description="Relative URLs in a script resolve against this."
                    placeholder="https://example.com"
                    type="url"
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

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-4">
                  <Text variant="secondary" size="base">
                    You can add more environments after creating the project.
                  </Text>
                  <div className="ml-auto flex items-center gap-2">
                    <RouterLinkButton to="/projects" variant="secondary">
                      Cancel
                    </RouterLinkButton>
                    <Button
                      type="submit"
                      variant="primary"
                      loading={mutation.isPending}
                      disabled={!name.trim() || !baseUrl.trim()}
                    >
                      Create project
                    </Button>
                  </div>
                </div>
              </form>
            </LayerCard>
          </Section>
        </div>
      </PageBody>
    </>
  )
}
