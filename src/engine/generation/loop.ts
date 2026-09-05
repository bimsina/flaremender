import { type ModelMessage, generateText, hasToolCall, jsonSchema, stepCountIs, tool } from 'ai'
import { eq } from 'drizzle-orm'

import { createDb } from '#/db/index.ts'
import { environmentVariable } from '#/db/schema/app.ts'
import { pruneToolResults } from '#/engine/agent-transcript.ts'
import type { ActResponse, PageObservation } from '#/engine/contract.ts'
import { resolveModel } from '#/engine/generation/llm.ts'
import {
  type GenerationContext,
  SYSTEM_PROMPT,
  formatObservation,
} from '#/engine/generation/prompts.ts'
import {
  assembleScript,
  detectNavigationChurn,
  detectReplay,
  hasAssertions,
  rejectFragment,
  rejectUnsafeInteraction,
  statementsOf,
  wrapFragment,
} from '#/engine/generation/script.ts'
import { announceRun } from '#/engine/run-steps.ts'
import {
  actInDynamicWorker,
  observeInDynamicWorker,
  startGenerationSession,
} from '#/engine/runner/loader.ts'
import { decryptSecret } from '#/server/crypto.ts'

const MAX_TOOL_STEPS = 4

export const MAX_FRAGMENT_CHARS = 1200

export const MAX_FRAGMENTS = 40

export const MAX_CONSECUTIVE_FAILURES = 3

export const MAX_TOTAL_FAILURES = 10

export const OBSERVE_AFTER_FAILURES = 2

const OBSERVATIONS_KEPT_IN_FULL = 2

const PRUNED_FIELDS: Record<string, string> = {
  page: '(page tree omitted — observe again if you need it)',
  script: '(listing omitted — the newest one above is current)',
}

export interface TurnFailures {
  total: number
  consecutive: number
}

export interface TurnInput {
  jobId: string
  organizationId: string
  environmentId: string
  projectModelId: string | null
  baseUrl: string
  intentTitle: string
  intentDescription: string
  sessionId: string
  messages: Array<ModelMessage>
  verified: Array<string>
  stepIndexOffset: number
  failures: TurnFailures
  refusedFinish: boolean
  observedSinceFailure: boolean
  /** The repair loop swaps in its own framing; generation uses the default. */
  systemPrompt?: string
}

export interface TurnResult {
  /** Encode the message delta because the Workflow Serializable type cannot represent ModelMessage. */
  messagesJson: string
  fragments: Array<string>
  sessionId: string
  stepIndexOffset: number
  finished: boolean
  notes: string | null
  failures: TurnFailures
  refusedFinish: boolean
  observedSinceFailure: boolean
  modelId: string
  fatal: string | null
  usage: { inputTokens: number; outputTokens: number }
}

export async function loadCredentials(
  env: Cloudflare.Env,
  environmentId: string,
): Promise<Record<string, string>> {
  const db = createDb(env.DB)

  const rows = await db
    .select({ name: environmentVariable.name, encryptedValue: environmentVariable.encryptedValue })
    .from(environmentVariable)
    .where(eq(environmentVariable.environmentId, environmentId))

  const creds: Record<string, string> = {}
  for (const row of rows) {
    try {
      creds[row.name] = await decryptSecret(row.encryptedValue)
    } catch {}
  }

  return creds
}

export async function loadCredentialNames(
  env: Cloudflare.Env,
  environmentId: string,
): Promise<Array<string>> {
  const db = createDb(env.DB)

  const rows = await db
    .select({ name: environmentVariable.name })
    .from(environmentVariable)
    .where(eq(environmentVariable.environmentId, environmentId))

  return rows.map((row) => row.name)
}

function describePage(observation: PageObservation | null): string {
  return observation
    ? formatObservation(observation)
    : 'The page could not be read after that step.'
}

function describeSteps(response: ActResponse): Array<string> {
  return response.steps.map((step) => `${step.ok ? '✓' : '✘'} ${step.label}`)
}

function describeScript(fragments: Array<string>, goal: string): string {
  const statements = fragments.flatMap(statementsOf)

  const listing =
    statements.length === 0
      ? 'The script is still empty.'
      : `The script now contains these statements, in this order, and the browser is in the state they left it in. Do not send any of them again — send only what comes next:\n${statements
          .map((statement, index) => `${index + 1}. ${statement}`)
          .join('\n')}`

  return `${listing}\n\nWhat this script has to prove: ${goal}\n\nAsk yourself what a person carrying that out would do next, and send that one step. When the flow is done, the script must end with assertions that would fail if the behaviour broke — then call finish.`
}

export async function runTurn(env: Cloudflare.Env, input: TurnInput): Promise<TurnResult> {
  const db = createDb(env.DB)
  const creds = await loadCredentials(env, input.environmentId)
  const resolved = await resolveModel(db, input.projectModelId, input.organizationId)

  const state = {
    sessionId: input.sessionId,
    stepIndexOffset: input.stepIndexOffset,
    fragments: [] as Array<string>,
    finished: false,
    notes: null as string | null,
    failures: { ...input.failures },
    refusedFinish: input.refusedFinish,
    observedSinceFailure: input.observedSinceFailure,
    fatal: null as string | null,
  }

  const goal = `${input.intentTitle} — ${input.intentDescription}`

  const narrate = (line: string) =>
    announceRun(env, input.jobId, {
      type: 'log',
      runId: input.jobId,
      line,
      at: Date.now(),
    })

  const browserOptions = {
    loader: env.LOADER,
    browser: env.BROWSER,
    baseUrl: input.baseUrl,
    creds,
  }

  async function execute(code: string): Promise<ActResponse> {
    const response = await actInDynamicWorker({
      ...browserOptions,
      sessionId: state.sessionId,
      code,
      channel: env.RUN_CHANNEL.getByName(input.jobId),
      jobId: input.jobId,
      stepIndexOffset: state.stepIndexOffset,
    })

    state.stepIndexOffset += response.steps.length
    return response
  }

  async function recoverSession(): Promise<boolean> {
    await narrate('The browser session was lost. Starting a new one and replaying the flow…')

    const started = await startGenerationSession(browserOptions)
    if (!started.sessionId) {
      state.fatal = started.errorMessage ?? 'A new browser session could not be started.'
      return false
    }

    state.sessionId = started.sessionId

    const prefix = [...input.verified, ...state.fragments]
    if (prefix.length === 0) return true

    const replay = await execute(assembleScript(prefix))
    if (!replay.ok) {
      state.fatal = `The verified script could not be replayed into a fresh browser session: ${
        replay.errorMessage ?? 'unknown error'
      }`
      return false
    }

    return true
  }

  const observeTool = tool({
    description:
      'Read the page the browser is on right now: its URL, its title and its accessibility tree. Costs nothing but a round trip and changes nothing.',
    inputSchema: jsonSchema<{ narration: string }>({
      type: 'object',
      properties: {
        narration: {
          type: 'string',
          description: 'One short line, in the present tense, saying why you are looking.',
        },
      },
      required: ['narration'],
      additionalProperties: false,
    }),
    async execute({ narration }) {
      await narrate(narration)

      const response = await observeInDynamicWorker({
        ...browserOptions,
        sessionId: state.sessionId,
        channel: env.RUN_CHANNEL.getByName(input.jobId),
        jobId: input.jobId,
      })

      if (response.sessionLost && (await recoverSession())) {
        const retry = await observeInDynamicWorker({
          ...browserOptions,
          sessionId: state.sessionId,
          channel: env.RUN_CHANNEL.getByName(input.jobId),
          jobId: input.jobId,
        })
        state.observedSinceFailure = true
        return { page: describePage(retry.observation) }
      }

      if (!response.observation) {
        return { error: response.errorMessage ?? 'The page could not be read.' }
      }

      state.observedSinceFailure = true
      return { page: formatObservation(response.observation) }
    },
  })

  function mustObserveFirst(): string | null {
    if (state.failures.consecutive < OBSERVE_AFTER_FAILURES) return null
    if (state.observedSinceFailure) return null

    return `Two fragments in a row have failed and the page has not been looked at since. That usually means the flow is not on the page you think it is. Call \`observe\` first, then act on what it actually shows.`
  }

  const actTool = tool({
    description:
      'Execute a small fragment of Playwright statements against the live browser. The fragment continues from wherever the last one left the page — it is never a fresh start. On success it is appended to the script being built and the result shows you everything the script now contains; send only what comes after that. On failure nothing is kept.',
    inputSchema: jsonSchema<{ narration: string; code: string }>({
      type: 'object',
      properties: {
        narration: {
          type: 'string',
          description:
            'One short line, in the present tense, saying what this step does — e.g. "Signing in as the standard user".',
        },
        code: {
          type: 'string',
          description:
            'Playwright statements only, one per line, using page, expect and secret. No imports, no function wrapper, no markdown fences. Never repeat a statement that is already in the script.',
        },
      },
      required: ['narration', 'code'],
      additionalProperties: false,
    }),
    async execute({ narration, code }) {
      await narrate(narration)

      const verifiedSoFar = [...input.verified, ...state.fragments]

      const complaint =
        rejectFragment(code, MAX_FRAGMENT_CHARS) ??
        rejectUnsafeInteraction(code) ??
        detectReplay(code, verifiedSoFar) ??
        detectNavigationChurn(code, verifiedSoFar) ??
        mustObserveFirst()

      if (complaint) {
        state.failures.total += 1
        state.failures.consecutive += 1
        return { ok: false, error: complaint }
      }

      if (verifiedSoFar.length >= MAX_FRAGMENTS) {
        state.finished = true
        state.notes = `The script reached the ${MAX_FRAGMENTS}-step limit before the flow was finished.`
        return { ok: false, error: state.notes }
      }

      let response = await execute(wrapFragment(code))

      if (response.sessionLost) {
        if (!(await recoverSession())) {
          state.finished = true
          return { ok: false, error: state.fatal ?? 'The browser could not be reached.' }
        }
        response = await execute(wrapFragment(code))
      }

      if (!response.ok) {
        state.failures.total += 1
        state.failures.consecutive += 1
        state.observedSinceFailure = false

        const advice =
          state.failures.consecutive >= MAX_CONSECUTIVE_FAILURES
            ? ' You have failed several steps in a row — observe the page and take a different approach, or finish and explain what is blocking you.'
            : ''

        return {
          ok: false,
          error: `${response.errorMessage ?? 'The fragment failed.'}${advice}`,
          steps: describeSteps(response),
          page: describePage(response.observation),
          script: describeScript(verifiedSoFar, goal),
        }
      }

      state.fragments.push(code.trim())
      state.failures.consecutive = 0

      return {
        ok: true,
        steps: describeSteps(response),
        page: describePage(response.observation),
        script: describeScript([...verifiedSoFar, code.trim()], goal),
      }
    },
  })

  const finishTool = tool({
    description:
      'Stop. Call this once the flow described by the intent has been performed and asserted — or when you are certain it cannot be.',
    inputSchema: jsonSchema<{ notes?: string }>({
      type: 'object',
      properties: {
        notes: {
          type: 'string',
          description:
            'What the finished script proves, or — if you could not finish — what blocked you and where.',
        },
      },
      additionalProperties: false,
    }),
    execute({ notes }) {
      if (
        !state.refusedFinish &&
        !hasAssertions([...input.verified, ...state.fragments].join('\n'))
      ) {
        state.refusedFinish = true
        return {
          ok: false,
          error:
            "Nothing has been asserted yet, so this script would pass for ever without checking anything. Add the assertions that would fail if the behaviour in the intent broke — visible text, a URL, an element's contents, a count — and then finish. If the intent genuinely cannot be carried out here, call finish again and say so.",
        }
      }

      state.finished = true
      state.notes = notes ?? null
      return { ok: true }
    },
  })

  const result = await generateText({
    model: resolved.model,
    system: input.systemPrompt ?? SYSTEM_PROMPT,
    messages: pruneToolResults(input.messages, {
      keep: OBSERVATIONS_KEPT_IN_FULL,
      replacements: PRUNED_FIELDS,
    }),
    tools: { observe: observeTool, act: actTool, finish: finishTool },
    stopWhen: [stepCountIs(MAX_TOOL_STEPS), hasToolCall('finish')],
  })

  if (state.failures.total >= MAX_TOTAL_FAILURES && !state.finished) {
    state.finished = true
    state.notes =
      state.notes ??
      `Too many steps failed (${state.failures.total}) — the flow could not be built against this page.`
  }

  return {
    messagesJson: JSON.stringify(result.response.messages),
    fragments: state.fragments,
    sessionId: state.sessionId,
    stepIndexOffset: state.stepIndexOffset,
    finished: state.finished || state.fatal !== null,
    notes: state.notes,
    failures: state.failures,
    refusedFinish: state.refusedFinish,
    observedSinceFailure: state.observedSinceFailure,
    modelId: resolved.modelId,
    fatal: state.fatal,
    usage: {
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    },
  }
}

export type { GenerationContext }
