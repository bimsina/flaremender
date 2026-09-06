import {
  Banner,
  Breadcrumbs,
  Button,
  Input,
  InputArea,
  LayerCard,
  LinkButton,
  Radio,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import {
  BinocularsIcon,
  FileIcon,
  FolderIcon,
  KeyIcon,
  PencilSimpleIcon,
  PlusIcon,
  SparkleIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, createLink, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'

import { PageBody, PageHeader } from '#/components/layout/page.tsx'
import { setEnvironmentVariable } from '#/server/projects/environments.ts'
import { exploreProject } from '#/server/projects/explore.ts'
import { setProjectContext } from '#/server/projects/explore.ts'
import { createProject } from '#/server/projects/projects.ts'

const RouterLinkButton = createLink(LinkButton)

export const Route = createFileRoute('/_app/projects/new')({
  component: NewProjectPage,
})

interface Credential {
  name: string
  value: string
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function nameFromUrl(value: string): string {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '')
    const label = host.split('.')[0] ?? host
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : ''
  } catch {
    return ''
  }
}

function suggestVariableName(index: number, existing: Array<Credential>): string {
  const names = new Set(existing.map((row) => row.name))
  for (const candidate of ['EMAIL', 'PASSWORD', 'USERNAME', 'API_TOKEN']) {
    if (!names.has(candidate)) return candidate
  }
  return `SECRET_${index + 1}`
}

function NewProjectPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const toast = useKumoToastManager()

  const [baseUrl, setBaseUrl] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [about, setAbout] = useState('')
  const [docs, setDocs] = useState('')
  const [credentials, setCredentials] = useState<Array<Credential>>([])
  const [files, setFiles] = useState<Array<File>>([])
  const [start, setStart] = useState<'explore' | 'manual'>('explore')
  const [progress, setProgress] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const effectiveName = nameTouched ? name : nameFromUrl(baseUrl)

  const create = useMutation({
    mutationFn: async () => {
      setProgress('Creating the project')
      const project = await createProject({
        data: { name: effectiveName.trim(), baseUrl, description: null },
      })

      const environmentId = project.environmentId

      const stored = credentials.filter((row) => row.name.trim() && row.value.trim())
      for (const [index, credential] of stored.entries()) {
        setProgress(`Storing credential ${index + 1} of ${stored.length}`)
        await setEnvironmentVariable({
          data: { environmentId, name: credential.name.trim(), value: credential.value },
        })
      }

      const docLinks = docs
        .split(/[\n,\s]+/)
        .map((item) => item.trim())
        .filter((item) => /^https?:\/\//i.test(item))
      const contextParts = [about.trim()]
      if (stored.length > 0) {
        contextParts.push(
          `Credentials are stored as environment variables: ${stored
            .map((row) => row.name.trim())
            .join(', ')}.`,
        )
      }
      if (docLinks.length > 0) {
        contextParts.push(`Documentation:\n${docLinks.map((link) => `- ${link}`).join('\n')}`)
      }
      const context = contextParts.filter(Boolean).join('\n\n')
      if (context) {
        setProgress('Saving what you told us about the app')
        await setProjectContext({ data: { projectId: project.id, context } })
      }

      if (files.length > 0) {
        setProgress(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}`)
        const form = new FormData()
        for (const file of files) form.append('file', file)
        const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/files`, {
          method: 'POST',
          body: form,
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string }
          } | null
          throw new Error(body?.error?.message ?? `Upload failed (${response.status}).`)
        }
      }

      if (start === 'explore') {
        setProgress('Sending the agent to look round')
        await exploreProject({ data: { projectId: project.id, autoGenerate: true } })
      }

      return project
    },
    onSuccess: async (project) => {
      await queryClient.invalidateQueries()
      toast.add({
        variant: 'success',
        title: start === 'explore' ? 'The agent is exploring your app' : 'Project created',
        description: effectiveName.trim(),
      })
      await navigate({
        to: '/projects/$projectId',
        params: { projectId: project.id },
        search: start === 'explore' ? { tab: 'chat' } : { tab: 'intents' },
      })
    },
    onError: () => setProgress(null),
  })

  const validCredentials = credentials.every(
    (row) => (!row.name.trim() && !row.value.trim()) || VARIABLE_NAME.test(row.name.trim()),
  )
  const canSubmit = effectiveName.trim().length > 0 && baseUrl.trim().length > 0 && validCredentials

  return (
    <>
      <PageHeader
        compact
        heading="section"
        title="New project"
        description="Give the agent a URL and whatever you know about the app. It will look round, propose the tests worth having and write them."
        breadcrumbs={
          <Breadcrumbs size="base">
            <Breadcrumbs.Link href="/projects">
              <span className="inline-flex items-center gap-1.5">
                <FolderIcon size={16} className="text-kumo-subtle" />
                Projects
              </span>
            </Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Current>New project</Breadcrumbs.Current>
          </Breadcrumbs>
        }
      />

      <PageBody className="grid gap-6">
        <form
          className="grid w-full max-w-3xl gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          {create.error ? (
            <Banner
              variant="error"
              icon={<WarningCircleIcon weight="fill" />}
              title="Could not create the project"
              description={create.error.message}
            />
          ) : null}

          <LayerCard className="px-5 py-4">
            <div className="grid gap-4">
              <Input
                label="Where is the app?"
                description="The URL a tester would open first. This becomes the Production environment."
                placeholder="https://app.example.com"
                type="url"
                required
                autoFocus
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              <Input
                label="Project name"
                placeholder={nameFromUrl(baseUrl) || 'Storefront'}
                required
                value={effectiveName}
                onChange={(event) => {
                  setNameTouched(true)
                  setName(event.target.value)
                }}
              />
              <InputArea
                label="What is it, and how does one get in?"
                description="A few sentences a new tester would need. Where the sign-in is, what the main thing to do is, anything unusual. Never paste a password here; use the credentials below."
                placeholder="A task tracker. Sign in at /login with the credentials below. After signing in you land on the task list; tasks are added at the top and ticked off in the list."
                autoResize
                minRows={3}
                maxRows={10}
                value={about}
                onChange={(event) => setAbout(event.target.value)}
              />
            </div>
          </LayerCard>

          <LayerCard className="px-5 py-4">
            <div className="grid gap-3">
              <div className="grid gap-0.5">
                <Text as="h2" bold>
                  Credentials
                </Text>
                <Text variant="secondary" size="base">
                  Stored encrypted as environment variables. Scripts read them with{' '}
                  <span className="font-mono text-[0.9em]">secret('NAME')</span>, and the agent only
                  ever sees the names.
                </Text>
              </div>

              {credentials.map((credential, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2">
                  <Input
                    aria-label="Variable name"
                    className="w-44 font-mono"
                    placeholder="EMAIL"
                    spellCheck={false}
                    value={credential.name}
                    onChange={(event) =>
                      setCredentials((rows) =>
                        rows.map((row, at) =>
                          at === index ? { ...row, name: event.target.value.toUpperCase() } : row,
                        ),
                      )
                    }
                  />
                  <Input
                    aria-label="Value"
                    className="min-w-0 flex-1"
                    type="password"
                    autoComplete="off"
                    placeholder="Value"
                    value={credential.value}
                    onChange={(event) =>
                      setCredentials((rows) =>
                        rows.map((row, at) =>
                          at === index ? { ...row, value: event.target.value } : row,
                        ),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    shape="square"
                    aria-label="Remove credential"
                    onClick={() =>
                      setCredentials((rows) => rows.filter((_row, at) => at !== index))
                    }
                  >
                    <XIcon size={16} />
                  </Button>
                </div>
              ))}

              {!validCredentials ? (
                <Text variant="secondary" size="base">
                  Variable names use letters, numbers and underscores, like EMAIL or ADMIN_PASSWORD.
                </Text>
              ) : null}

              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<KeyIcon size={14} />}
                  onClick={() =>
                    setCredentials((rows) => [
                      ...rows,
                      { name: suggestVariableName(rows.length, rows), value: '' },
                    ])
                  }
                >
                  Add credential
                </Button>
              </div>
            </div>
          </LayerCard>

          <LayerCard className="px-5 py-4">
            <div className="grid gap-4">
              <div className="grid gap-0.5">
                <Text as="h2" bold>
                  Docs and files
                </Text>
                <Text variant="secondary" size="base">
                  Optional. Anything that explains the app: a README, an API spec, the manual as a
                  PDF, screenshots of the flows. The agent reads the text and looks at the pictures.
                </Text>
              </div>

              <InputArea
                label="Documentation links"
                description="One URL per line. The agent reads these pages while exploring."
                placeholder={
                  'https://docs.example.com/getting-started\nhttps://example.com/pricing'
                }
                autoResize
                minRows={2}
                maxRows={6}
                spellCheck={false}
                value={docs}
                onChange={(event) => setDocs(event.target.value)}
              />

              <div className="grid gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  accept=".md,.markdown,.txt,.json,.yaml,.yml,.csv,.xml,.html,.pdf,image/png,image/jpeg,image/webp,image/gif,text/*"
                  onChange={(event) => {
                    const picked = Array.from(event.target.files ?? [])
                    setFiles((current) => [...current, ...picked].slice(0, 20))
                    event.target.value = ''
                  }}
                />
                {files.length > 0 ? (
                  <ul className="grid gap-1.5">
                    {files.map((file, index) => (
                      <li key={`${file.name}-${index}`} className="flex items-center gap-2">
                        <FileIcon size={16} className="shrink-0 text-kumo-subtle" />
                        <Text as="span" size="base" truncate>
                          {file.name}
                        </Text>
                        <Text as="span" variant="secondary" size="base">
                          {Math.max(1, Math.round(file.size / 1024))} KB
                        </Text>
                        <Button
                          variant="ghost"
                          shape="square"
                          size="sm"
                          aria-label={`Remove ${file.name}`}
                          onClick={() =>
                            setFiles((current) => current.filter((_f, at) => at !== index))
                          }
                        >
                          <TrashIcon size={14} />
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<PlusIcon size={14} />}
                    onClick={() => fileInput.current?.click()}
                  >
                    Add files
                  </Button>
                </div>
              </div>
            </div>
          </LayerCard>

          <LayerCard className="px-5 py-4">
            <div className="grid gap-3">
              <Text as="h2" bold>
                How do you want to start?
              </Text>
              <Radio.Group
                appearance="card"
                value={start}
                onValueChange={(value: string | null) => {
                  if (value === 'explore' || value === 'manual') setStart(value)
                }}
              >
                <Radio.Legend className="sr-only">How to start</Radio.Legend>
                <Radio.Item
                  value="explore"
                  label={
                    <span className="flex items-center gap-2">
                      <BinocularsIcon size={16} />
                      Let the agent explore and write the first tests
                    </span>
                  }
                  description="It opens the app in a real browser, signs in with the credentials above, proposes the tests worth having and writes them. You watch it work and review the results. A few minutes and a few hundred thousand tokens."
                />
                <Radio.Item
                  value="manual"
                  label={
                    <span className="flex items-center gap-2">
                      <PencilSimpleIcon size={16} />
                      I will describe the tests myself
                    </span>
                  }
                  description="Start with an empty project. Type what a test should prove and the agent writes it, or write Playwright by hand."
                />
              </Radio.Group>
            </div>
          </LayerCard>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Text variant="secondary" size="base">
              {progress ?? 'You can add environments, credentials and files later, too.'}
            </Text>
            <div className="ml-auto flex items-center gap-2">
              <RouterLinkButton to="/projects" variant="secondary">
                Cancel
              </RouterLinkButton>
              <Button
                type="submit"
                variant="primary"
                icon={start === 'explore' ? <SparkleIcon size={16} /> : undefined}
                loading={create.isPending}
                disabled={!canSubmit}
              >
                {start === 'explore' ? 'Create and explore' : 'Create project'}
              </Button>
            </div>
          </div>
        </form>
      </PageBody>
    </>
  )
}
