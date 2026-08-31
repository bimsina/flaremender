import { Button, Text, cn } from '@cloudflare/kumo'
import { CheckIcon, CopyIcon } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'

import { CodeEditor } from './code-editor.tsx'

/**
 * A labelled block of machine output with a copy button — the shape the
 * Workflows dashboard uses for an instance's input and output payloads.
 *
 * Errors, transcripts and scripts all get copied into issues and searches far
 * more often than they get read in place, so the copy button is part of the
 * panel rather than something to hunt for.
 */
export function MonoPanel({
  label,
  text,
  tone = 'default',
  language,
  className,
}: {
  label: React.ReactNode
  text: string
  tone?: 'default' | 'danger'
  /** `'javascript'` swaps the plain `<pre>` for a read-only, highlighted editor. */
  language?: 'javascript'
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  // Reset by timer rather than on the next click: the confirmation is the only
  // feedback the button gives, and it has to outlive the click that caused it.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // A denied clipboard permission is not worth an error state; the text is
      // right there and selectable.
      setCopied(false)
    }
  }

  return (
    <div
      className={cn('overflow-hidden rounded-md bg-kumo-base ring ring-kumo-hairline', className)}
    >
      <div className="flex items-center justify-between gap-3 border-b border-kumo-hairline px-3 py-1.5">
        <Text as="span" variant="secondary" size="base">
          {label}
        </Text>
        <Button
          variant="ghost"
          size="xs"
          icon={copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {language === 'javascript' ? (
        <CodeEditor
          value={text}
          readOnly
          wrap
          showLineNumbers={false}
          maxHeight="20rem"
          ariaLabel={typeof label === 'string' ? label : undefined}
          className="rounded-none ring-0"
        />
      ) : (
        <pre
          className={cn(
            'max-h-80 overflow-auto px-3 py-2.5 font-mono text-xs whitespace-pre-wrap',
            tone === 'danger' ? 'text-kumo-danger' : 'text-kumo-default',
          )}
        >
          {text}
        </pre>
      )}
    </div>
  )
}
