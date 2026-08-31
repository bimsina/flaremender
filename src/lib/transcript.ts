import type { RunResult } from '#/engine/contract.ts'

/**
 * Reading an attempt's transcript back.
 *
 * The Workflow flattens a run's steps and logs into one text column so an
 * attempt is legible without joining anything or fetching an artifact. That
 * makes the column the only record the UI can reach, so this parses it back
 * into the same shape the live panel renders — one screen, one presentation,
 * whether the run is happening now or happened last week.
 *
 * The format is written by `RunWorkflow.persist`:
 *
 *     ✓ page.goto('/') (412ms)
 *     ✘ expect(locator).toBeVisible() (5001ms)
 *         Timed out 5000ms waiting for …
 *     <blank line>
 *     [log] whatever the script printed
 *
 * Anything that does not match is kept verbatim as a log line rather than
 * dropped: a transcript is evidence, and silently losing part of it would be
 * worse than showing a line the parser did not understand.
 */

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
/** Continuation of the step above it — the Workflow indents errors by four. */
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
    // Indented lines belong to the step they follow, but only while the log
    // section has not started — after the first log line every step is closed.
    if (continuation && last && logs.length === 0) {
      last.error = last.error === null ? continuation[1]! : `${last.error}\n${continuation[1]}`
      continue
    }

    if (line.trim().length > 0) logs.push(line)
  }

  return { steps, logs }
}

/** Prefer structured evidence; retain the reader for historical text-only attempts. */
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
