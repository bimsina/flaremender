import type { RunResult } from '#/engine/contract.ts'

export interface TranscriptStep {
  index: number
  label: string
  ok: boolean
  durationMs: number | null
  error: string | null
}

export interface Transcript {
  steps: Array<TranscriptStep>
  logs: Array<string>
}

const STEP = /^([✓✘])\s(.*?)(?:\s\((\d+)ms\))?$/u
const CONTINUATION = /^ {4}(.*)$/u

export function parseTranscript(text: string | null | undefined): Transcript {
  const steps: Array<TranscriptStep> = []
  const logs: Array<string> = []

  if (!text) return { steps, logs }

  for (const line of text.split('\n')) {
    const step = STEP.exec(line)
    if (step) {
      steps.push({
        index: steps.length,
        label: step[2] ?? '',
        ok: step[1] === '✓',
        durationMs: step[3] === undefined ? null : Number(step[3]),
        error: null,
      })
      continue
    }

    const continuation = CONTINUATION.exec(line)
    const last = steps.at(-1)
    if (continuation && last && logs.length === 0) {
      last.error = last.error === null ? continuation[1]! : `${last.error}\n${continuation[1]}`
      continue
    }

    if (line.trim().length > 0) logs.push(line)
  }

  return { steps, logs }
}

export function readTranscript(
  attempt: { result?: RunResult | null; logs?: string | null } | null | undefined,
): Transcript {
  if (!attempt?.result) return parseTranscript(attempt?.logs)
  return {
    steps: attempt.result.steps.map((step, index) => ({
      ...step,
      index,
      error: step.error ?? null,
    })),
    logs: attempt.result.logs,
  }
}
