/**
 * The generate → run → repair engine, behind a deliberate seam.
 *
 * Both halves are stubs today: `generateSpec` derives Playwright code from the
 * plain-English prompt with pattern matching instead of a model, and
 * `executeSpec` simulates a browser run instead of driving one. Swap
 * `generateSpec` for a Workers AI call and `executeSpec` for a Browser
 * Rendering session and nothing above this file has to change.
 */
import type { RunStatus } from '#/db/schema/app.ts'

export interface GenerationRequest {
  projectName: string
  baseUrl: string
  title: string
  prompt: string
  /** Present when repairing: the spec that just failed and why. */
  previousCode?: string | null
  previousError?: string | null
  attempt: number
}

export interface ExecutionRequest {
  code: string
  baseUrl: string
  title: string
  /** Stable per test case, so a given attempt always replays identically. */
  seed: string
  attempt: number
}

export interface ExecutionResult {
  status: Extract<RunStatus, 'passed' | 'failed' | 'error'>
  logs: string
  errorMessage: string | null
  durationMs: number
}

interface Step {
  source: string
  code: Array<string>
  label: string
}

function toInstructions(prompt: string): Array<string> {
  return prompt
    .split(/\r?\n|(?<=[.;])\s+/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
    .filter((line) => line.length > 0)
}

function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

/** Pulls the first quoted phrase, else the words after the verb. */
function target(instruction: string, verb: RegExp): string {
  const quoted = instruction.match(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/)
  if (quoted?.[1]) return quoted[1].trim()

  const rest = instruction.replace(verb, '').trim()
  return rest
    .replace(/^(?:on|the|a|an)\s+/i, '')
    .replace(/\s+(?:button|link|field|input|box)\b.*$/i, '')
    .replace(/[.,;]+$/, '')
    .trim()
}

function toStep(instruction: string): Step {
  const lower = instruction.toLowerCase()

  if (/^(?:go to|visit|open|navigate to|browse to)\b/.test(lower)) {
    const path = target(instruction, /^(?:go to|visit|open|navigate to|browse to)\s*/i)
    const url = /^https?:\/\//i.test(path) ? path : path.startsWith('/') ? path : `/${path}`
    return {
      source: instruction,
      label: `navigate to ${url}`,
      code: [`await page.goto(${quote(url)})`],
    }
  }

  if (/^(?:click|press|tap|select)\b/.test(lower)) {
    const name = target(instruction, /^(?:click|press|tap|select)\s*(?:on\s+)?/i)
    return {
      source: instruction,
      label: `click "${name}"`,
      code: [`await page.getByRole('button', { name: ${quote(name)} }).click()`],
    }
  }

  if (/^(?:type|enter|fill|input)\b/.test(lower)) {
    const match = instruction.match(
      /^(?:type|enter|fill|input)\s+(?:in\s+)?["'“”]?(.+?)["'“”]?\s+(?:in|into|as)\s+(?:the\s+)?(.+?)(?:\s+(?:field|input|box))?[.]?$/i,
    )
    const value = match?.[1]?.trim() ?? target(instruction, /^(?:type|enter|fill|input)\s*/i)
    const field = match?.[2]?.trim() ?? 'input'
    return {
      source: instruction,
      label: `fill "${field}"`,
      code: [`await page.getByLabel(${quote(field)}).fill(${quote(value)})`],
    }
  }

  if (/^(?:should see|see|expect|verify|check|assert|confirm)\b/.test(lower)) {
    const text = target(
      instruction,
      /^(?:should see|see|expect|verify|check|assert|confirm)\s*(?:that\s+)?(?:the\s+)?/i,
    )
    return {
      source: instruction,
      label: `expect "${text}" to be visible`,
      code: [`await expect(page.getByText(${quote(text)})).toBeVisible()`],
    }
  }

  if (/^(?:wait|pause)\b/.test(lower)) {
    return {
      source: instruction,
      label: 'wait for network idle',
      code: [`await page.waitForLoadState('networkidle')`],
    }
  }

  // Unrecognised phrasing: keep it visible in the spec rather than dropping it.
  return {
    source: instruction,
    label: instruction,
    code: [
      `// TODO: ${instruction}`,
      `await expect(page.getByText(${quote(instruction.slice(0, 60))})).toBeVisible()`,
    ],
  }
}

function repairPreamble(previousError: string): Array<string> {
  const hints: Array<string> = []
  if (/timeout|timed out|not visible|hidden/i.test(previousError)) {
    hints.push(`  // Retry hardening: the previous attempt timed out waiting for the page.`)
    hints.push(`  await page.waitForLoadState('domcontentloaded')`)
  }
  if (/strict mode|resolved to \d+ elements|multiple/i.test(previousError)) {
    hints.push(`  // Retry hardening: the previous locator matched more than one node.`)
  }
  if (hints.length === 0) {
    hints.push(`  // Retry hardening: re-generated after "${previousError.slice(0, 80)}".`)
  }
  return hints
}

export function generateSpec(request: GenerationRequest): { code: string; summary: string } {
  const instructions = toInstructions(request.prompt)
  const steps = instructions.map(toStep)

  const body = steps.flatMap((step) => [
    `  // ${step.source}`,
    ...step.code.map((c) => `  ${c}`),
    '',
  ])

  const lines = [
    `import { expect, test } from '@playwright/test'`,
    ``,
    `// Generated for ${request.projectName} — attempt ${request.attempt}.`,
    `test.use({ baseURL: ${quote(request.baseUrl)} })`,
    ``,
    `test(${quote(request.title)}, async ({ page }) => {`,
    ...(request.previousError ? [...repairPreamble(request.previousError), ``] : []),
    ...body,
    `})`,
    ``,
  ]

  const summary =
    steps.length === 0
      ? 'No instructions found in the description.'
      : `${steps.length} step${steps.length === 1 ? '' : 's'}: ${steps.map((s) => s.label).join(', ')}`

  return { code: lines.join('\n'), summary }
}

/** Deterministic 0–1 value, so the same seed always replays the same run. */
function hash01(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}

const FAILURES = [
  {
    message: (locator: string) =>
      `TimeoutError: locator.click: Timeout 30000ms exceeded.\nWaiting for ${locator}`,
    hint: 'Element never became visible within the timeout.',
  },
  {
    message: (locator: string) =>
      `Error: strict mode violation: ${locator} resolved to 3 elements.`,
    hint: 'Locator was ambiguous and matched multiple nodes.',
  },
  {
    message: (locator: string) =>
      `Error: expect(received).toBeVisible()\n\nLocator: ${locator}\nExpected: visible\nReceived: hidden`,
    hint: 'Assertion failed — the expected content was not on the page.',
  },
]

function firstLocator(code: string): string {
  const match = code.match(/page\.(getBy\w+\([^)]*\))/)
  return match ? `page.${match[1]}` : 'page.locator(…)'
}

export function executeSpec(request: ExecutionRequest): ExecutionResult {
  const steps = request.code.split('\n').filter((line) => line.trim().startsWith('await ')).length
  const roll = hash01(`${request.seed}:${request.attempt}`)
  // Each repair attempt is meant to get closer, so passing gets likelier.
  const passProbability = Math.min(0.9, 0.35 + 0.25 * (request.attempt - 1))
  const passed = roll < passProbability
  const durationMs = 800 + Math.round(hash01(`${request.seed}:d${request.attempt}`) * 5200)

  const header = [
    `Running 1 test using 1 worker (Cloudflare Browser Rendering — simulated)`,
    ``,
    `  ▸ ${request.title}`,
    `    base URL: ${request.baseUrl}`,
    `    steps:    ${steps}`,
    `    attempt:  ${request.attempt}`,
    ``,
  ]

  if (passed) {
    return {
      status: 'passed',
      logs: [
        ...header,
        `  ✓  ${request.title} (${durationMs}ms)`,
        ``,
        `  1 passed (${durationMs}ms)`,
      ].join('\n'),
      errorMessage: null,
      durationMs,
    }
  }

  const failure =
    FAILURES[Math.floor(hash01(`${request.seed}:f${request.attempt}`) * FAILURES.length)]!
  const errorMessage = failure.message(firstLocator(request.code))

  return {
    status: 'failed',
    logs: [
      ...header,
      `  ✘  ${request.title} (${durationMs}ms)`,
      ``,
      errorMessage,
      ``,
      `  ${failure.hint}`,
      ``,
      `  1 failed (${durationMs}ms)`,
    ].join('\n'),
    errorMessage,
    durationMs,
  }
}
