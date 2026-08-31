import { Banner, Button, InputArea, LayerCard, Loader, Text, cn } from '@cloudflare/kumo'
import {
  ArrowUpIcon,
  ChatCircleDotsIcon,
  CheckIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { ChatCardView } from '#/components/chat-cards.tsx'
import { RelativeTime } from '#/components/relative-time.tsx'
import type { ChatMessageWire, ChatPart } from '#/engine/chat/contract.ts'
import { type LiveToolCall, type PendingMessage, useProjectChat } from '#/lib/use-project-chat.ts'

const SUGGESTIONS = [
  'Explore my app and propose tests.',
  'Describe a flow to test: a visitor signs in and sees their dashboard.',
  'Run all tests',
]

export function ProjectChatTab({ projectId }: { projectId: string }) {
  const chat = useProjectChat(projectId)
  const [draft, setDraft] = useState('')

  const submit = (text: string) => {
    if (chat.busy || text.trim().length === 0) return
    chat.send(text)
    setDraft('')
  }

  const empty = chat.messages.length === 0 && chat.pending === null

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4">
      <Transcript
        messages={chat.messages}
        pending={chat.pending}
        projectId={projectId}
        loading={chat.loading}
        empty={empty}
        onSuggestion={submit}
      />

      <div className="sticky bottom-0 -mb-6 grid gap-2 border-t border-kumo-line bg-kumo-canvas pt-4 pb-6">
        {chat.sendError ? (
          <Banner
            variant="alert"
            icon={<WarningCircleIcon weight="fill" />}
            title="Not sent"
            description={chat.sendError}
          />
        ) : null}

        {chat.error ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="The assistant stopped"
            description={chat.error}
          />
        ) : null}

        <Composer value={draft} onValueChange={setDraft} onSubmit={submit} busy={chat.busy} />

        <Text variant="secondary" size="base">
          Store credentials in Environments. Chat messages are sent to the selected AI provider;
          detected credentials are encrypted and redacted from the saved transcript.
        </Text>
      </div>
    </div>
  )
}

function Transcript({
  messages,
  pending,
  projectId,
  loading,
  empty,
  onSuggestion,
}: {
  messages: Array<ChatMessageWire>
  pending: PendingMessage | null
  projectId: string
  loading: boolean
  empty: boolean
  onSuggestion: (text: string) => void
}) {
  const bottom = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  useEffect(() => {
    const container = bottom.current?.closest('main')
    if (!container) return
    const track = () => {
      following.current =
        container.scrollHeight - container.scrollTop - container.clientHeight < 180
    }
    container.addEventListener('scroll', track, { passive: true })
    return () => container.removeEventListener('scroll', track)
  }, [empty])

  useLayoutEffect(() => {
    if (following.current) bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages, pending])

  if (loading && empty) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2">
        <Loader size="sm" />
        <Text as="span" variant="secondary" size="base">
          Loading the conversation…
        </Text>
      </div>
    )
  }

  if (empty) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
        <div className="grid justify-items-center gap-1.5">
          <span className="flex size-10 items-center justify-center rounded-md bg-kumo-recessed text-kumo-subtle">
            <ChatCircleDotsIcon size={20} />
          </span>
          <Text as="h2" variant="heading">
            Tell me what to test
          </Text>
          <Text variant="secondary">
            I can write tests from a description, generate the scripts against your real site, and
            run them.
          </Text>
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <Button
              key={suggestion}
              variant="secondary"
              size="sm"
              onClick={() => onSuggestion(suggestion)}
            >
              {suggestion}
            </Button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="grid flex-1 content-start gap-5">
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} projectId={projectId} />
      ))}

      {pending ? <PendingRow pending={pending} projectId={projectId} /> : null}

      <div ref={bottom} />
    </div>
  )
}

function MessageRow({ message, projectId }: { message: ChatMessageWire; projectId: string }) {
  if (message.role === 'user') {
    return (
      <div className="grid justify-items-end gap-1">
        <div className="max-w-[85%] rounded-lg bg-kumo-recessed px-3.5 py-2.5">
          {message.parts.map((part, index) => (
            <PartView key={index} part={part} projectId={projectId} />
          ))}
        </div>
        <Text as="span" variant="secondary" size="base">
          {message.createdByName ?? 'You'} · <RelativeTime value={message.createdAt} />
        </Text>
      </div>
    )
  }

  return (
    <div className="grid gap-2.5">
      {message.parts.map((part, index) => (
        <PartView key={index} part={part} projectId={projectId} />
      ))}
      {message.status === 'error' ? (
        <Text as="span" variant="secondary" size="base">
          The assistant did not finish this turn.
        </Text>
      ) : null}
    </div>
  )
}

function PendingRow({ pending, projectId }: { pending: PendingMessage; projectId: string }) {
  const unfinished = pending.tools.filter((call) => call.ok === null)

  return (
    <div className="grid gap-2.5">
      {pending.parts.map((part, index) => (
        <PartView key={index} part={part} projectId={projectId} />
      ))}

      {pending.tools.length > 0 ? (
        <ol className="grid gap-1.5">
          {pending.tools.map((call) => (
            <ToolRow key={call.toolCallId} call={call} />
          ))}
        </ol>
      ) : null}

      {pending.parts.length === 0 && unfinished.length === 0 ? (
        <div className="flex items-center gap-2">
          <Loader size="sm" />
          <Text as="span" variant="secondary" size="base">
            Thinking…
          </Text>
        </div>
      ) : null}
    </div>
  )
}

function ToolRow({ call }: { call: LiveToolCall }) {
  return (
    <li className="flex items-start gap-2">
      <span className="flex h-lh shrink-0 items-center">
        {call.ok === null ? (
          <Loader size={12} />
        ) : call.ok ? (
          <CheckIcon size={12} weight="bold" className="text-kumo-success" />
        ) : (
          <XIcon size={12} weight="bold" className="text-kumo-danger" />
        )}
      </span>
      <Text as="span" variant="secondary" size="base">
        {call.ok === false && call.detail ? `${call.summary} — ${call.detail}` : call.summary}
      </Text>
    </li>
  )
}

function PartView({ part, projectId }: { part: ChatPart; projectId: string }) {
  if (part.type === 'card') {
    return <ChatCardView card={part.card} projectId={projectId} />
  }

  return <MarkdownLite text={part.text} />
}

const INLINE = /(\*\*\*|`[^`]+`|\*\*[^*]+\*\*)/g

function MarkdownLite({ text }: { text: string }) {
  const lines = text.split('\n')

  return (
    <div className="grid gap-1.5">
      {lines.map((line, index) =>
        line.trim().length === 0 ? null : (
          <Text key={index}>
            {/^\s*[-*]\s+/.test(line) ? <span className="mr-1.5 text-kumo-subtle">•</span> : null}
            {line
              .replace(/^\s*[-*]\s+/, '')
              .split(INLINE)
              .map((chunk, position) => {
                if (chunk.startsWith('`') && chunk.endsWith('`') && chunk.length > 2) {
                  return (
                    <span
                      key={position}
                      className="rounded-sm bg-kumo-recessed px-1 font-mono text-[0.9em]"
                    >
                      {chunk.slice(1, -1)}
                    </span>
                  )
                }

                if (chunk.startsWith('**') && chunk.endsWith('**') && chunk.length > 4) {
                  return (
                    <span key={position} className="font-medium">
                      {chunk.slice(2, -2)}
                    </span>
                  )
                }

                return <span key={position}>{chunk}</span>
              })}
          </Text>
        ),
      )}
    </div>
  )
}

function Composer({
  value,
  onValueChange,
  onSubmit,
  busy,
}: {
  value: string
  onValueChange: (value: string) => void
  onSubmit: (value: string) => void
  busy: boolean
}) {
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!busy) field.current?.focus()
  }, [busy])

  return (
    <LayerCard className={cn('px-3 py-2.5', busy && 'opacity-70')}>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit(value)
        }}
      >
        <InputArea
          ref={field}
          className="flex-1"
          aria-label="Message"
          placeholder={
            busy ? 'Working…' : 'Describe a test, paste an app URL, or ask to run the suite'
          }
          autoResize
          minRows={1}
          maxRows={8}
          disabled={busy}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            onSubmit(value)
          }}
        />
        <Button
          type="submit"
          variant="primary"
          shape="square"
          aria-label="Send"
          disabled={busy || value.trim().length === 0}
        >
          <ArrowUpIcon size={16} weight="bold" />
        </Button>
      </form>
    </LayerCard>
  )
}
