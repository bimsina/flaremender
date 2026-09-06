import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

import type { ResolvedTheme } from '#/lib/theme.tsx'

const LIGHT_HIGHLIGHT = HighlightStyle.define(
  [
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#6a737d' },
    {
      tag: [
        t.keyword,
        t.controlKeyword,
        t.moduleKeyword,
        t.operatorKeyword,
        t.definitionKeyword,
        t.modifier,
        t.self,
        t.null,
      ],
      color: '#d73a49',
    },
    { tag: [t.string, t.special(t.string), t.regexp], color: '#032f62' },
    {
      tag: [t.number, t.bool, t.atom, t.literal, t.constant(t.name), t.standard(t.name)],
      color: '#005cc5',
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.className, t.typeName],
      color: '#6f42c1',
    },
    { tag: [t.propertyName, t.attributeName], color: '#005cc5' },
    { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: '#e36209' },
    { tag: [t.variableName, t.name, t.labelName], color: '#24292e' },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator], color: '#24292e' },
    { tag: t.tagName, color: '#22863a' },
    { tag: t.escape, color: '#22863a' },
    { tag: t.invalid, color: '#b31d28' },
  ],
  { themeType: 'light' },
)

const DARK_HIGHLIGHT = HighlightStyle.define(
  [
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#8b8b8b' },
    {
      tag: [
        t.keyword,
        t.controlKeyword,
        t.moduleKeyword,
        t.operatorKeyword,
        t.definitionKeyword,
        t.modifier,
        t.self,
        t.null,
        t.operator,
        t.punctuation,
        t.separator,
        t.bracket,
        t.derefOperator,
      ],
      color: '#a0a0a0',
    },
    { tag: [t.string, t.special(t.string), t.regexp], color: '#99ffe4' },
    {
      tag: [
        t.number,
        t.bool,
        t.atom,
        t.literal,
        t.constant(t.name),
        t.standard(t.name),
        t.escape,
        t.function(t.variableName),
        t.function(t.propertyName),
        t.className,
        t.typeName,
        t.tagName,
        t.propertyName,
        t.attributeName,
      ],
      color: '#ffc799',
    },
    { tag: [t.variableName, t.name, t.labelName, t.definition(t.variableName)], color: '#ffffff' },
    { tag: t.invalid, color: '#ff8080' },
  ],
  { themeType: 'dark' },
)

export interface EditorLook {
  theme: ResolvedTheme
  minHeight?: string
  maxHeight?: string
}

function chromeTheme({ theme, minHeight, maxHeight }: EditorLook): Extension {
  const dark = theme === 'dark'
  return EditorView.theme(
    {
      '&': {
        backgroundColor: 'var(--color-kumo-base)',
        color: 'var(--text-color-kumo-default)',
        fontSize: '13px',
        ...(minHeight ? { minHeight } : {}),
        ...(maxHeight ? { maxHeight } : {}),
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
      '.cm-content': { padding: '10px 0', caretColor: 'var(--text-color-kumo-default)' },
      '.cm-line': { padding: '0 12px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text-color-kumo-default)' },
      '.cm-gutters': {
        backgroundColor: 'var(--color-kumo-base)',
        color: 'var(--text-color-kumo-placeholder)',
        border: 'none',
        paddingRight: '4px',
      },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 12px' },
      '.cm-activeLine': { backgroundColor: 'var(--color-kumo-tint)' },
      '.cm-activeLineGutter': {
        backgroundColor: 'var(--color-kumo-tint)',
        color: 'var(--text-color-kumo-subtle)',
      },
      '.cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--color-kumo-fill)',
      },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--color-kumo-fill)' },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: 'var(--color-kumo-fill)',
        outline: 'none',
      },
    },
    { dark },
  )
}

export function buildLook(look: EditorLook): Extension {
  return [
    chromeTheme(look),
    syntaxHighlighting(look.theme === 'dark' ? DARK_HIGHLIGHT : LIGHT_HIGHLIGHT),
  ]
}

export interface CreateEditorOptions {
  parent: HTMLElement
  doc: string
  look: EditorLook
  readOnly: boolean
  showLineNumbers: boolean
  wrap: boolean
  ariaLabel?: string
  onChange: (value: string) => void
}

export interface EditorHandle {
  view: EditorView
  setLook: (look: EditorLook) => void
  setDoc: (value: string) => void
  destroy: () => void
}

export function createEditor({
  parent,
  doc,
  look,
  readOnly,
  showLineNumbers,
  wrap,
  ariaLabel,
  onChange,
}: CreateEditorOptions): EditorHandle {
  const lookCompartment = new Compartment()

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        showLineNumbers ? lineNumbers() : [],
        wrap ? EditorView.lineWrapping : [],
        history(),
        indentOnInput(),
        bracketMatching(),
        indentUnit.of('  '),
        javascript({ typescript: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        readOnly
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : [highlightActiveLine(), highlightActiveLineGutter()],
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString())
        }),
        EditorView.contentAttributes.of(ariaLabel ? { 'aria-label': ariaLabel } : {}),
        lookCompartment.of(buildLook(look)),
      ],
    }),
  })

  return {
    view,
    setLook: (next) => view.dispatch({ effects: lookCompartment.reconfigure(buildLook(next)) }),
    setDoc: (value) => {
      if (view.state.doc.toString() === value) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    },
    destroy: () => view.destroy(),
  }
}
