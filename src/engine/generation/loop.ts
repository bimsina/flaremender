/**
 * One turn of the generation loop.
 *
 * A turn is a single `generateText` call with three tools and a live browser
 * behind two of them. It is deliberately the unit a Workflow step wraps: an LLM
 * call is the least reliable thing in the engine and the most expensive to
 * repeat, so each one is checkpointed the moment it returns.
 *
 * That step boundary shapes everything here:
 *
 * - **Nothing live is returned.** A turn hands back plain messages, plain
 *   strings and a session id. The browser stub, the model object and the
 *   decrypted credentials are all created inside the turn and die with it.
 * - **Only the delta is returned.** The transcript grows every turn; returning
 *   the whole of it each time would store it once per turn. The workflow
 *   accumulates.
 * - **Nothing secret is returned either.** Credentials are decrypted here to be
 *   handed to the harness, and every string that comes back out — step labels,
 *   errors, logs, the page snapshot — has been through the scrubber inside the
 *   isolate that held the plaintext. The transcript that reaches durable
 *   storage carries `secret('NAME')` references and never a value.
 *
 * The loop's contract with the model is narrow on purpose: it may look, it may
 * try one small piece of code, and it may stop. Code that works is kept; code
 * that does not is thrown away and explained. Nothing the model says is trusted
 * about the page — only what the browser did.
 */
import { type ModelMessage, generateText, hasToolCall, jsonSchema, stepCountIs, tool } from 'ai'
import { eq } from 'drizzle-orm'

import { createDb } from '#/db/index.ts'
import { environmentVariable } from '#/db/schema/app.ts'
import type { ActResponse, PageObservation } from '#/engine/contract.ts'
import { resolveModel } from '#/engine/generation/llm.ts'
import {
  type GenerationContext,
  SYSTEM_PROMPT,
  formatObservation,
} from '#/engine/generation/prompts.ts'
import {
  assembleScript,
  detectReplay,
  hasAssertions,
  rejectFragment,
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

/** How many tool calls the model may make inside one turn. */
const MAX_TOOL_STEPS = 4

/** A fragment past this length is a flow, not a step. */
export const MAX_FRAGMENT_CHARS = 1200

/** Nothing worth building needs more than this many verified fragments. */
export const MAX_FRAGMENTS = 40

/**
 * How many fragments may fail back to back before the model is told so.
 *
 * Three is the point at which a model has stopped debugging and started
 * guessing: it has seen the page, seen two errors, and is still wrong. It is a
 * nudge rather than a stop — a model that is told it is going in circles very
 * often gets out of them — and `MAX_TOTAL_FAILURES` is the actual ceiling.
 */
export const MAX_CONSECUTIVE_FAILURES = 3

/** And a ceiling across the whole job, for a model that keeps recovering badly. */
export const MAX_TOTAL_FAILURES = 10

/** How many tool results keep their page tree and script listing in full. */
const OBSERVATIONS_KEPT_IN_FULL = 2

/** Anything shorter than this is too small to be worth pruning. */
const PRUNE_THRESHOLD = 400

/** Tool-result fields that restate the present and go stale immediately. */
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
  environmentId: string
  /** The project's model choice, or null to fall through the resolution chain. */
  projectModelId: string | null
  baseUrl: string
  sessionId: string
  /** The whole transcript so far. Accumulated by the workflow, not stored here. */
  messages: Array<ModelMessage>
  /**
   * Every fragment verified so far, in order. Read only to replay the flow into
   * a fresh session when the old one goes away mid-turn.
   */
  verified: Array<string>
  stepIndexOffset: number
  failures: TurnFailures
  /**
   * Whether the model has already been sent back once for trying to finish
   * without asserting anything. Carried across turns so the push-back happens
   * exactly once per job: a model that is genuinely blocked has to be able to
   * stop, and refusing every time would spend the whole turn budget arguing.
   */
  refusedFinish: boolean
}

export interface TurnResult {
  /**
   * Only what this turn added, as JSON.
   *
   * A string rather than the messages themselves because this crosses a
   * Workflow step boundary, and `ModelMessage` is a union deep enough that the
   * platform's `Serializable<T>` cannot see through it. Encoding it here is
   * honest about what actually happens to it — the workflow stores it, reads it
   * back and parses it — and keeps the type of the step's result trivial.
   */
  messagesJson: string
  /** Fragments this turn verified, in order, ready to append to the script. */
  fragments: Array<string>
  /** The session the next turn should join — not always the one it was given. */
  sessionId: string
  stepIndexOffset: number
  finished: boolean
  /** What the model said when it stopped, if it stopped on purpose. */
  notes: string | null
  failures: TurnFailures
  refusedFinish: boolean
  modelId: string
  /**
   * Set when the loop cannot continue at all — a browser that will not come
   * back, or a verified prefix that no longer replays. Distinct from a model
   * that is merely stuck, which is `finished` with unhappy notes.
   */
  fatal: string | null
  usage: { inputTokens: number; outputTokens: number }
}

/** The decrypted variables for one environment, keyed by name. */
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
    } catch {
      // A variable that will not decrypt reads as missing, and `secret()` says
      // so by name when the model reaches for it.
    }
  }

  return creds
}

/** The names the prompt is allowed to mention. */
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

/**
 * Keeps the transcript from becoming mostly old page trees.
 *
 * Every tool result carries ten kilobytes of page tree and a listing of the
 * script so far. Both were decisive when they arrived and are noise two turns
 * later, because both describe a present that has moved on — the model needs
 * the page as it is now and the script as it stands now, and the newest copy of
 * each is always the one immediately above it. Older ones are replaced in the
 * *in-memory* copy only: what the workflow stored is untouched, so a replayed
 * instance rebuilds exactly this.
 */
function pruneObservations(messages: Array<ModelMessage>): Array<ModelMessage> {
  let remaining = OBSERVATIONS_KEPT_IN_FULL

  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(prune)
    if (typeof value !== 'object' || value === null) return value

    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const replacement = PRUNED_FIELDS[key]
      if (replacement && typeof item === 'string' && item.length > PRUNE_THRESHOLD) {
        return [key, replacement] as const
      }
      return [key, prune(item)] as const
    })

    return Object.fromEntries(entries)
  }

  // Newest first, so the two most recent observations are the ones kept.
  const reversed = [...messages].reverse().map((message) => {
    if (message.role !== 'tool') return message
    if (remaining > 0) {
      remaining -= 1
      return message
    }
    return { ...message, content: prune(message.content) } as ModelMessage
  })

  return reversed.reverse()
}

/** What a tool hands back to the model about the page it is now looking at. */
function describePage(observation: PageObservation | null): string {
  return observation
    ? formatObservation(observation)
    : 'The page could not be read after that step.'
}

/** A one-line summary of each executed call, for the model's own bookkeeping. */
function describeSteps(response: ActResponse): Array<string> {
  return response.steps.map((step) => `${step.ok ? '✓' : '✘'} ${step.label}`)
}

/**
 * The file as it now stands, handed back after every accepted fragment.
 *
 * The model is writing a script it cannot see. Told only "that worked", it has
 * to remember across a dozen turns what is already in there — and the way a
 * model hedges against that is to resend everything, which is exactly the
 * failure `detectReplay` exists to catch. Showing it the accumulated statements
 * removes the reason to hedge, so the guard rarely has to fire.
 */
function describeScript(fragments: Array<string>): string {
  const statements = fragments.flatMap(statementsOf)

  if (statements.length === 0) return 'The script is still empty.'

  return `The script now contains these statements, in this order, and the browser is in the state they left it in. Do not send any of them again — send only what comes next:\n${statements
    .map((statement, index) => `${index + 1}. ${statement}`)
    .join('\n')}`
}

export async function runTurn(env: Cloudflare.Env, input: TurnInput): Promise<TurnResult> {
  const db = createDb(env.DB)
  const creds = await loadCredentials(env, input.environmentId)
  const resolved = await resolveModel(db, input.projectModelId)

  // Mutable across the tool calls of this one turn, and returned at the end of
  // it. Nothing here survives the step boundary except by being returned.
  const state = {
    sessionId: input.sessionId,
    stepIndexOffset: input.stepIndexOffset,
    fragments: [] as Array<string>,
    finished: false,
    notes: null as string | null,
    failures: { ...input.failures },
    refusedFinish: input.refusedFinish,
    fatal: null as string | null,
  }

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
    // Every generation-mode isolate gets these, `observe` included: the
    // scrubber is built from the values, so an isolate without them cannot
    // redact the page it reads. See the note in `runner/loader.ts`.
    creds,
  }

  /** Runs one module against the live session and moves the step counter on. */
  async function execute(code: string): Promise<ActResponse> {
    const response = await actInDynamicWorker({
      ...browserOptions,
      sessionId: state.sessionId,
      code,
      // Resolved per call rather than carried in: a Durable Object stub does
      // not survive a step boundary, and this is the step that uses it.
      channel: env.RUN_CHANNEL.getByName(input.jobId),
      jobId: input.jobId,
      stepIndexOffset: state.stepIndexOffset,
    })

    // Failed steps were streamed too, so the counter moves either way.
    state.stepIndexOffset += response.steps.length
    return response
  }

  /**
   * Takes a new session and puts it back where the old one was.
   *
   * The replay *is* the recovery: everything verified so far is, by
   * construction, code that works, so running it into a fresh browser
   * reproduces the exact page the next fragment expects. If the replay itself
   * fails the flow is no longer reproducible and the loop has nothing left to
   * build on, so it stops rather than carrying on against a page it cannot
   * account for.
   */
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
      })

      if (response.sessionLost && (await recoverSession())) {
        const retry = await observeInDynamicWorker({
          ...browserOptions,
          sessionId: state.sessionId,
        })
        return { page: describePage(retry.observation) }
      }

      if (!response.observation) {
        return { error: response.errorMessage ?? 'The page could not be read.' }
      }

      return { page: formatObservation(response.observation) }
    },
  })

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

      // Both are refusals rather than failures of the page, so neither costs a
      // browser round trip and both come back with enough for the model to fix
      // itself on the next call.
      const complaint =
        rejectFragment(code, MAX_FRAGMENT_CHARS) ?? detectReplay(code, verifiedSoFar)

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

        const advice =
          state.failures.consecutive >= MAX_CONSECUTIVE_FAILURES
            ? ' You have failed several steps in a row — observe the page and take a different approach, or finish and explain what is blocking you.'
            : ''

        return {
          ok: false,
          error: `${response.errorMessage ?? 'The fragment failed.'}${advice}`,
          steps: describeSteps(response),
          page: describePage(response.observation),
          script: describeScript(verifiedSoFar),
        }
      }

      state.fragments.push(code.trim())
      state.failures.consecutive = 0

      return {
        ok: true,
        steps: describeSteps(response),
        page: describePage(response.observation),
        script: describeScript([...verifiedSoFar, code.trim()]),
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
      // The one thing worth arguing about. A script with no assertions passes
      // its verification run, passes every run after it, and reports a healthy
      // intent for a flow nobody is checking — the single worst thing this
      // engine can produce, because every signal around it says green. So the
      // first attempt to stop without one is sent back; a model that really is
      // blocked simply says so again and is let through.
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
    system: SYSTEM_PROMPT,
    messages: pruneObservations(input.messages),
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
    modelId: resolved.modelId,
    fatal: state.fatal,
    usage: {
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    },
  }
}

/** Re-exported so the workflow can build the opening message without a cycle. */
export type { GenerationContext }
