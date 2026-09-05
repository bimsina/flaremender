import { Button, InputArea, Text, useKumoToastManager } from '@cloudflare/kumo'
import { SparkleIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { createIntent, generateIntentScript } from '#/server/intents.ts'

const EXAMPLES = [
  'A visitor can sign in and lands on the dashboard',
  'Adding an item updates the cart badge to 1',
  'Submitting the form with an empty email shows a validation error',
]

/**
 * One box: say what the app should be able to do, and the agent starts writing the
 * test in a real browser. The sentence becomes the title, so keep it short; the
 * expected result is what makes it a test rather than a walk-through.
 */
export function QuickTestBox({
  projectId,
  autoFocus,
  compact,
}: {
  projectId: string
  autoFocus?: boolean
  compact?: boolean
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const [text, setText] = useState('')

  const start = useMutation({
    mutationFn: async () => {
      const description = text.trim()
      const title = description.split(/[.\n]/)[0]!.trim().slice(0, 120) || description.slice(0, 120)
      const created = await createIntent({ data: { projectId, title, description } })
      const queued = await generateIntentScript({ data: { intentId: created.id } })
      return { intentId: created.id, jobId: queued.jobId }
    },
    onSuccess: async (result) => {
      setText('')
      await queryClient.invalidateQueries()
      toast.add({
        variant: 'info',
        title: 'Writing the test',
        description: 'Watch the browser on the test page.',
      })
      await navigate({
        to: '/projects/$projectId/intents/$intentId',
        params: { projectId, intentId: result.intentId },
        search: { tab: 'script' },
      })
    },
    onError: (error: Error) =>
      toast.add({ variant: 'error', title: 'Could not start', description: error.message }),
  })

  const ready = text.trim().length >= 10

  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) start.mutate()
      }}
    >
      <InputArea
        aria-label="What should this app be able to do?"
        placeholder="What should this app be able to do? Say what happens and what must be true at the end."
        autoResize
        autoFocus={autoFocus}
        minRows={compact ? 1 : 2}
        maxRows={6}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && ready) {
            event.preventDefault()
            start.mutate()
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {compact ? (
          <span />
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((example) => (
              <Button
                key={example}
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setText(`${example}.`)}
              >
                {example}
              </Button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Text as="span" variant="secondary" size="base">
            ⌘↵
          </Text>
          <Button
            type="submit"
            variant="primary"
            size={compact ? 'sm' : 'base'}
            icon={<SparkleIcon size={16} />}
            loading={start.isPending}
            disabled={!ready}
          >
            Write this test
          </Button>
        </div>
      </div>
    </form>
  )
}
