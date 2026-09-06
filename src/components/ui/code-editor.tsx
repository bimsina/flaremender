import { cn } from '@cloudflare/kumo'
import { useEffect, useRef, useSyncExternalStore } from 'react'

import type { EditorHandle } from '#/components/ui/code-editor-view.ts'
import { useTheme } from '#/lib/theme.tsx'

const neverChanges = () => () => {}
const onClient = () => true
const onServer = () => false

/** The SSR ternary keeps CodeMirror out of the Worker bundle. */
const loadEditor = import.meta.env.SSR
  ? () => Promise.resolve(null)
  : () => import('#/components/ui/code-editor-view.ts')

export interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  showLineNumbers?: boolean
  wrap?: boolean
  minHeight?: string
  maxHeight?: string
  ariaLabel?: string
  className?: string
}

export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  showLineNumbers = true,
  wrap = false,
  minHeight,
  maxHeight,
  ariaLabel,
  className,
}: CodeEditorProps) {
  const { resolved } = useTheme()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<EditorHandle | null>(null)
  const hydrated = useSyncExternalStore(neverChanges, onClient, onServer)

  // Refs update the editor without rebuilding it and losing selection or undo history.
  const latest = useRef({ value, onChange, resolved, minHeight, maxHeight })
  useEffect(() => {
    latest.current = { value, onChange, resolved, minHeight, maxHeight }
  })

  useEffect(() => {
    const parent = hostRef.current
    if (!parent) return

    let cancelled = false
    const seed = latest.current

    void loadEditor().then((module) => {
      if (cancelled || !module) return
      editorRef.current = module.createEditor({
        parent,
        doc: seed.value,
        look: { theme: seed.resolved, minHeight: seed.minHeight, maxHeight: seed.maxHeight },
        readOnly,
        showLineNumbers,
        wrap,
        ariaLabel,
        onChange: (next) => latest.current.onChange?.(next),
      })
    })

    return () => {
      cancelled = true
      editorRef.current?.destroy()
      editorRef.current = null
    }
  }, [hydrated, readOnly, showLineNumbers, wrap, ariaLabel])

  useEffect(() => {
    editorRef.current?.setLook({ theme: resolved, minHeight, maxHeight })
  }, [resolved, minHeight, maxHeight])

  useEffect(() => {
    editorRef.current?.setDoc(value)
  }, [value])

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md bg-kumo-base ring ring-kumo-hairline',
        'focus-within:ring-kumo-brand',
        className,
      )}
    >
      {hydrated ? (
        <div ref={hostRef} />
      ) : (
        <pre
          aria-label={ariaLabel}
          style={{ minHeight, maxHeight }}
          className="overflow-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed text-kumo-default"
        >
          {value}
        </pre>
      )}
    </div>
  )
}
