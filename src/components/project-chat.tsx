/**
 * The project's console.
 *
 * A transcript and a box to type in, and the whole design decision is what a
 * message *is*: short text with cards under it. The assistant is not describing
 * what it would do, it is doing it and showing you the row — so this component
 * gives text as little room as it can get away with and gives cards the width of
 * the column.
 *
 * Layout: the transcript scrolls, the composer is pinned to the bottom of the
 * tab and is separated from the scrolling content by a border, as any sticky
 * element must be. The column is capped at reading width and centred, because a
 * conversation stretched across a wide monitor is unreadable and a card three
 * screens wide is not more informative than one.
 */
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

/**
 * What an empty chat suggests. Deliberately three different *kinds* of thing —
 * let it find the tests, describe one yourself, use what is already there —
 * because the point of the empty state is to say what this surface is for.
 *
 * Exploring leads, because it is the answer to the question an empty project
 * actually poses: not "how do I write a test" but "what should I even test?"
 */
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

      {/* The scroll container is `main`, so the composer sticks to the viewport.
          The negative margin lets it cover the page's own bottom padding rather
          than floating above a strip of scrolling transcript. */}
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

  // Layout effect rather than effect: scrolling after paint shows one frame of
  // the previous position, which reads as a jump on every token.
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

/**
 * One tool call while it is happening.
 *
 * The summary is written by the tool belt rather than derived from the model's
 * arguments — which is not a cosmetic choice: one of those arguments can be a
 * password, and the line that says what is happening must not be built from it.
 */
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

/**
 * Just enough markdown.
 *
 * The assistant is told to keep its text to a sentence or two, so a full parser
 * would be a dependency in service of formatting that should not be there. Three
 * things do reliably show up and all three matter more than they look:
 *
 * - **newlines**, which a `<p>` would collapse;
 * - `` `identifiers` ``, because a variable name that is not visibly code reads
 *   as prose and gets retyped wrong;
 * - `**emphasis**`, because a model will produce it whatever the prompt says,
 *   and unrendered asterisks are worse than the emphasis they were meant to be.
 *
 * Everything else — headings, tables, links — is deliberately left as written.
 * The chat is not where long-form output belongs; that is what cards are for.
 */
/**
 * `\*\*\*` comes first and is load-bearing.
 *
 * It is the redaction marker, and without its own alternative the emphasis rule
 * claims it: `Login is *** password ***` contains `** password **`, so the two
 * markers lose an asterisk each and the sentence renders as "Login is * password
 * *" with the middle in bold. That is the one string in this component that has
 * to be unambiguous — a reader looking at a message a credential was lifted out
 * of needs to see that it was redacted, not a stray asterisk.
 */
const INLINE = /(\*\*\*|`[^`]+`|\*\*[^*]+\*\*)/g

function MarkdownLite({ text }: { text: string }) {
  const lines = text.split('\n')

  return (
    <div className="grid gap-1.5">
      {lines.map((line, index) =>
        line.trim().length === 0 ? null : (
          <Text key={index}>
            {/* A leading "- " is a list of one line as far as this is
                concerned: the bullet is what carries the meaning. */}
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

  // Focus returns to the composer the moment a turn ends, so a conversation is
  // a conversation rather than a form you keep clicking back into.
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
            // Enter sends, Shift+Enter is a newline. IME composition must not
            // be interrupted by either.
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
