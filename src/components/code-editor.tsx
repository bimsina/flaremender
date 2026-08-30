import { cn } from '@cloudflare/kumo'
import { useEffect, useRef, useSyncExternalStore } from 'react'

import type { EditorHandle } from '#/components/code-editor-view.ts'
import { useTheme } from '#/lib/theme.tsx'

/*
 * "Have we hydrated yet?" as a store rather than an effect: the server and the
 * hydrating client both read `false`, so the first two renders agree, and React
 * re-renders with `true` once hydration is done.
 */
const neverChanges = () => () => {}
const onClient = () => true
const onServer = () => false

/*
 * Written as a folded ternary rather than an `if` inside the effect so that the
 * SSR build — where Vite substitutes `true` for `import.meta.env.SSR` — drops
 * the `import()` during tree-shaking. Without that the 400 kB CodeMirror chunk
 * is emitted into the Worker bundle even though the server never loads it.
 */
const loadEditor = import.meta.env.SSR
  ? () => Promise.resolve(null)
  : () => import('#/components/code-editor-view.ts')

export interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  /** The line-number gutter. Worth turning off for the compact read-only views. */
  showLineNumbers?: boolean
  /**
   * Soft-wrap long lines instead of scrolling sideways. On for reading a script
   * in a narrow panel; off while editing, where an editor's own scrolling is
   * what people expect.
   */
  wrap?: boolean
  /** Any CSS length, e.g. `'26rem'`. */
  minHeight?: string
  maxHeight?: string
  ariaLabel?: string
  className?: string
}

/**
 * A real code editor for Playwright scripts: JavaScript highlighting, line
 * numbers, undo, and a Tab that indents.
 *
 * CodeMirror is browser-only and heavy, so it is imported from an effect rather
 * than at the top of the module — that keeps it out of the Worker bundle
 * entirely. Until it lands, and on the server, this renders the same text as a
 * plain `<pre>`, which is also what hydration matches against.
 */
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

  // The editor is built once and then driven by dispatches, so anything that
  // would otherwise force a rebuild — the handler, the document, the theme —
  // reaches it through this ref instead of through the dependency array.
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
      // The import is a round trip; the panel holding it can close first.
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

  // Controlled-ish: an outside change to `value` is written into the document,
  // but ordinary typing never round-trips through React.
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
