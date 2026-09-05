import { Badge, Button, LayerCard, Text, useKumoToastManager } from '@cloudflare/kumo'
import { FileIcon, ImageIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useRef } from 'react'

import { InlineEmpty } from '#/components/list.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import { projectFilesQuery } from '#/lib/queries.ts'
import { deleteProjectFile } from '#/server/files.ts'

const KIND_LABEL = { text: 'Text', pdf: 'PDF', image: 'Image', other: 'File' } as const

/** The documents and pictures the agents read before they touch the app. */
export function ProjectFilesCard({ projectId }: { projectId: string }) {
  const { data: files } = useSuspenseQuery(projectFilesQuery(projectId))
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const input = useRef<HTMLInputElement>(null)

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: projectFilesQuery(projectId).queryKey })

  const upload = useMutation({
    mutationFn: async (picked: Array<File>) => {
      const form = new FormData()
      for (const file of picked) form.append('file', file)
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
        method: 'POST',
        body: form,
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string }
        } | null
        throw new Error(body?.error?.message ?? `Upload failed (${response.status}).`)
      }
      return (await response.json()) as { files: Array<{ name: string; extractedChars: number }> }
    },
    onSuccess: async (result) => {
      await invalidate()
      const unread = result.files.filter((file) => file.extractedChars === 0).length
      toast.add({
        variant: 'success',
        title: `Added ${result.files.length} file${result.files.length === 1 ? '' : 's'}`,
        description:
          unread > 0
            ? `${unread} could not be read as text and will only be shown to models that can see pictures.`
            : undefined,
      })
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not upload', description: error.message }),
  })

  const remove = useMutation({
    mutationFn: (fileId: string) => deleteProjectFile({ data: { projectId, fileId } }),
    onSuccess: invalidate,
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not remove', description: error.message }),
  })

  return (
    <LayerCard className="px-5 py-4">
      <div className="grid gap-3">
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".md,.markdown,.txt,.json,.yaml,.yml,.csv,.xml,.html,.pdf,image/png,image/jpeg,image/webp,image/gif,text/*"
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? [])
            if (picked.length > 0) upload.mutate(picked)
            event.target.value = ''
          }}
        />

        {files.length === 0 ? (
          <InlineEmpty message="No files yet. A README, an API spec, a PDF manual or screenshots of the flows all help the agent." />
        ) : (
          <ul className="grid gap-2">
            {files.map((file) => (
              <li key={file.id} className="flex flex-wrap items-center gap-2">
                {file.kind === 'image' ? (
                  <ImageIcon size={16} className="shrink-0 text-kumo-subtle" />
                ) : (
                  <FileIcon size={16} className="shrink-0 text-kumo-subtle" />
                )}
                <a
                  href={`/api/files/${encodeURIComponent(file.id)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate font-medium text-kumo-link"
                >
                  {file.name}
                </a>
                <Badge variant="secondary" className="rounded-md text-base">
                  {KIND_LABEL[file.kind]}
                </Badge>
                <Text as="span" variant="secondary" size="base">
                  {Math.max(1, Math.round(file.size / 1024))} KB
                  {file.extractedChars > 0
                    ? ` · ${Math.round(file.extractedChars / 1000)}k characters read`
                    : file.kind === 'image'
                      ? ' · shown to models that can see'
                      : ' · not readable as text'}
                  {' · '}
                  <RelativeTime value={file.createdAt} />
                </Text>
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  aria-label={`Remove ${file.name}`}
                  loading={remove.isPending && remove.variables === file.id}
                  onClick={() => remove.mutate(file.id)}
                >
                  <TrashIcon size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div>
          <Button
            variant="secondary"
            size="sm"
            icon={<PlusIcon size={14} />}
            loading={upload.isPending}
            onClick={() => input.current?.click()}
          >
            Add files
          </Button>
        </div>
      </div>
    </LayerCard>
  )
}
