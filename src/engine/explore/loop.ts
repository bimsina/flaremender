/**
 * One turn of the exploration loop.
 *
 * Structurally a twin of `generation/loop.ts` — one `generateText` call, a live
 * browser behind some of the tools, one Workflow step per turn so the least
 * reliable thing in the engine is checkpointed the moment it returns — and the
 * same three rules hold: nothing live is returned, only the delta is returned,
 * and nothing secret is returned either.
 *
 * What differs is the *permission*. The generator is building a file, so every
 * successful fragment is permanently a line somebody will read and wandering is
 * a defect. The explorer is building an opinion, so nothing it does is kept and
 * wandering is the job. Concretely:
 *
 * - it may `navigate` anywhere on the site, as often as it likes;
 * - its `interact` fragments are executed and thrown away — there is no script
 *   being assembled, so `detectReplay` and `detectNavigationChurn` have nothing
 *   to protect and are not applied;
 * - `rejectUnsafeInteraction` *is* applied, for a reason that outlives the
 *   script: `evaluate` and `force: true` are how an agent breaks somebody's real
 *   app by reaching past the checks that would have stopped it.
 *
 * The one output that matters is `propose`, and it is deliberately the only
 * thing here that validates hard: everything else can be retried, but a bad
 * proposal becomes a row in the user's project.
 */
import { type ModelMessage, generateText, hasToolCall, jsonSchema, stepCountIs, tool } from 'ai'

import { createDb } from '#/db/index.ts'
import { pruneToolResults } from '#/engine/agent-transcript.ts'
import type { ActResponse } from '#/engine/contract.ts'
import { fetchDocs } from '#/engine/explore/docs.ts'
import { EXPLORE_SYSTEM_PROMPT } from '#/engine/explore/prompts.ts'
import { resolveModel } from '#/engine/generation/llm.ts'
import { loadCredentials } from '#/engine/generation/loop.ts'
import { formatObservation } from '#/engine/generation/prompts.ts'
import {
  rejectFragment,
  rejectUnsafeInteraction,
  wrapFragment,
} from '#/engine/generation/script.ts'
import { announceRun } from '#/engine/run-steps.ts'
import {
  actInDynamicWorker,
  observeInDynamicWorker,
  startGenerationSession,
} from '#/engine/runner/loader.ts'

/** How many tool calls the model may make inside one turn. */
const MAX_TOOL_STEPS = 5

/** An exploration step is a click, not a flow. */
const MAX_FRAGMENT_CHARS = 800

/** How many documentation pages one exploration may read. */
export const MAX_DOCS_READS = 4

/** How many proposals a plan may contain, and the floor below which it is thin. */
export const MIN_PROPOSALS = 3
export const MAX_PROPOSALS = 15

/** How many tool results keep their page tree and document text in full. */
const RESULTS_KEPT_IN_FULL = 2

const PRUNED_FIELDS: Record<string, string> = {
  page: '(page tree omitted — observe again if you need it)',
  text: '(document text omitted — you have already read it)',
}

/** One proposed test, exactly as it will become an intent row. */
export interface Proposal {
  title: string
  description: string
}

export interface ExploreTurnInput {
  jobId: string
  environmentId: string
  /** The project's model choice, or null to fall through the resolution chain. */
  projectModelId: string | null
  baseUrl: string
  sessionId: string
  /** The whole transcript so far. Accumulated by the workflow, not stored here. */
  messages: Array<ModelMessage>
  /** Titles that already exist, plus anything proposed in an earlier turn. */
  knownTitles: Array<string>
  stepIndexOffset: number
  docsRead: number
  /**
   * Whether the model has already been sent back once for proposing a thin
   * plan. Carried across turns so the push-back happens exactly once per job —
   * an app that genuinely only warrants two tests has to be able to say so.
   */
  refusedThinPlan: boolean
}

export interface ExploreTurnResult {
  /** Only what this turn added, as JSON — see the note in `generation/loop.ts`. */
  messagesJson: string
  /** Proposals accepted this turn. Empty until the model calls `propose`. */
  proposals: Array<Proposal>
  /** The session the next turn should join — not always the one it was given. */
  sessionId: string
  stepIndexOffset: number
  docsRead: number
  finished: boolean
  /** What the model said the app is, when it stopped on purpose. */
  summary: string | null
  refusedThinPlan: boolean
  modelId: string
  /** Set when the loop cannot continue at all — a browser that will not come back. */
  fatal: string | null
}

/** Titles compare on their words, so "User can sign in" ≈ "user can sign-in." */
function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export async function runExploreTurn(
  env: Cloudflare.Env,
  input: ExploreTurnInput,
): Promise<ExploreTurnResult> {
  const db = createDb(env.DB)
  const creds = await loadCredentials(env, input.environmentId)
  const resolved = await resolveModel(db, input.projectModelId)

  const state = {
    sessionId: input.sessionId,
    stepIndexOffset: input.stepIndexOffset,
    docsRead: input.docsRead,
    proposals: [] as Array<Proposal>,
    finished: false,
    summary: null as string | null,
    refusedThinPlan: input.refusedThinPlan,
    fatal: null as string | null,
  }

  /** Everything already spoken for, so a proposal cannot restate one. */
  const known = new Set(input.knownTitles.map(normaliseTitle))

  const narrate = (line: string) =>
    announceRun(env, input.jobId, { type: 'log', runId: input.jobId, line, at: Date.now() })

  const browserOptions = {
    loader: env.LOADER,
    browser: env.BROWSER,
    baseUrl: input.baseUrl,
    // Every isolate gets these, the read-only ones included: the scrubber is
    // built from the values, so an isolate without them cannot redact the page
    // it reads. See the note in `runner/loader.ts`.
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

  /**
   * Takes a new session where the old one was.
   *
   * Simpler than the generator's recovery, and for a good reason: there is no
   * verified prefix to replay. The explorer has no script and nothing it did is
   * kept, so a fresh browser on the base URL is a completely valid place to
   * carry on from — it has merely lost its position, which `observe` restores.
   */
  async function recoverSession(): Promise<boolean> {
    await narrate('The browser session was lost. Starting a new one…')

    const started = await startGenerationSession(browserOptions)
    if (!started.sessionId) {
      state.fatal = started.errorMessage ?? 'A new browser session could not be started.'
      return false
    }

    state.sessionId = started.sessionId
    return true
  }

  async function look(): Promise<{ page: string } | { error: string }> {
    const response = await observeInDynamicWorker({
      ...browserOptions,
      sessionId: state.sessionId,
    })

    if (response.sessionLost) {
      if (!(await recoverSession())) return { error: state.fatal! }

      const retry = await observeInDynamicWorker({
        ...browserOptions,
        sessionId: state.sessionId,
      })

      return retry.observation
        ? {
            page: `${formatObservation(retry.observation)}\n\n(The browser session had to be restarted, so you are back on the base URL.)`,
          }
        : { error: retry.errorMessage ?? 'The page could not be read.' }
    }

    return response.observation
      ? { page: formatObservation(response.observation) }
      : { error: response.errorMessage ?? 'The page could not be read.' }
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
      return look()
    },
  })

  const navigateTool = tool({
    description:
      'Go to a path on this site — "/", "/pricing", "/settings/billing". Relative to the environment\'s base URL. Nothing you do here is saved, so navigate as freely as you need to.',
    inputSchema: jsonSchema<{ narration: string; path: string }>({
      type: 'object',
      properties: {
        narration: {
          type: 'string',
          description: 'One short line, in the present tense — e.g. "Looking at the pricing page".',
        },
        path: {
          type: 'string',
          description: 'A path beginning with "/", or a full URL on this same site.',
        },
      },
      required: ['narration', 'path'],
      additionalProperties: false,
    }),
    async execute({ narration, path }) {
      await narrate(narration)

      const target = path.trim()
      if (target.length === 0) return { error: 'No path given.' }
      if (/['"`\\\n]/.test(target)) {
        return { error: 'That is not a plain path. Give a path like "/settings" or a full URL.' }
      }

      let response = await execute(wrapFragment(`await page.goto('${target}')`))

      if (response.sessionLost) {
        if (!(await recoverSession())) return { error: state.fatal! }
        response = await execute(wrapFragment(`await page.goto('${target}')`))
      }

      if (!response.ok) {
        return {
          error: response.errorMessage ?? `Could not open ${target}.`,
          page: response.observation ? formatObservation(response.observation) : undefined,
        }
      }

      return {
        ok: true,
        page: response.observation
          ? formatObservation(response.observation)
          : 'The page could not be read after navigating.',
      }
    },
  })

  const interactTool = tool({
    description:
      'Perform one small step against the live browser — sign in, fill a field, click a button. It runs immediately and is then thrown away: you are exploring, not writing a script, so nothing you send here is kept. Use it to get behind the sign-in form and into the parts of the app that matter.',
    inputSchema: jsonSchema<{ narration: string; code: string }>({
      type: 'object',
      properties: {
        narration: {
          type: 'string',
          description:
            'One short line, in the present tense, saying what this does — e.g. "Signing in as the demo user".',
        },
        code: {
          type: 'string',
          description:
            'Playwright statements only, one per line, using page, expect and secret. No imports, no function wrapper, no markdown fences.',
        },
      },
      required: ['narration', 'code'],
      additionalProperties: false,
    }),
    async execute({ narration, code }) {
      await narrate(narration)

      // Only the two refusals that still mean something without a script: a
      // fragment that cannot run at all, and one that reaches past the checks
      // protecting somebody's real app.
      const complaint = rejectFragment(code, MAX_FRAGMENT_CHARS) ?? rejectUnsafeInteraction(code)
      if (complaint) return { ok: false, error: complaint }

      let response = await execute(wrapFragment(code))

      if (response.sessionLost) {
        if (!(await recoverSession())) return { ok: false, error: state.fatal! }
        response = await execute(wrapFragment(code))
      }

      const page = response.observation
        ? formatObservation(response.observation)
        : 'The page could not be read after that step.'

      if (!response.ok) {
        return {
          ok: false,
          error: `${response.errorMessage ?? 'That step failed.'} Nothing is lost — observe and try something else.`,
          page,
        }
      }

      return { ok: true, steps: response.steps.map((step) => step.label), page }
    },
  })

  const readDocsTool = tool({
    description:
      'Fetch a documentation, help or marketing page by URL and read its text. Use it when you have been given a docs URL, or when the app links to one — what an app claims to do is where its most valuable tests are. If the page comes back nearly empty it renders with JavaScript, and you should navigate to it instead.',
    inputSchema: jsonSchema<{ narration: string; url: string }>({
      type: 'object',
      properties: {
        narration: {
          type: 'string',
          description: 'One short line, in the present tense — e.g. "Reading the docs".',
        },
        url: { type: 'string', description: 'A full http or https URL.' },
      },
      required: ['narration', 'url'],
      additionalProperties: false,
    }),
    async execute({ narration, url }) {
      await narrate(narration)

      if (state.docsRead >= MAX_DOCS_READS) {
        return {
          error: `You have already read ${MAX_DOCS_READS} pages. Use the browser and what you have to finish the plan.`,
        }
      }

      state.docsRead += 1
      const result = await fetchDocs(url)

      if (result.errorMessage) return { error: result.errorMessage }

      return {
        url: result.url,
        title: result.title,
        text: result.text,
        truncated: result.truncated,
      }
    },
  })

  const proposeTool = tool({
    description:
      'Hand over the test plan. Call this once, when you have seen enough of the app to have an opinion — then call finish.',
    inputSchema: jsonSchema<{ tests: Array<Proposal> }>({
      type: 'object',
      properties: {
        tests: {
          type: 'array',
          minItems: MIN_PROPOSALS,
          maxItems: MAX_PROPOSALS,
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'A short capability, e.g. "Visitor can sign in".',
              },
              description: {
                type: 'string',
                description:
                  'What a person does and what must be true at the end. Quote the exact visible labels you read off the page. Refer to credentials by variable name; never write a value.',
              },
            },
            required: ['title', 'description'],
            additionalProperties: false,
          },
        },
      },
      required: ['tests'],
      additionalProperties: false,
    }),
    execute({ tests }) {
      if (state.proposals.length > 0) {
        return {
          ok: false,
          error: 'You have already proposed a plan. Call finish with your summary.',
        }
      }

      const raw = Array.isArray(tests) ? tests : []
      if (raw.length === 0) return { ok: false, error: 'No tests were given.' }

      const accepted: Array<Proposal> = []
      const rejected: Array<string> = []
      const seen = new Set(known)

      for (const test of raw) {
        const title = String(test?.title ?? '').trim()
        const description = String(test?.description ?? '').trim()

        if (title.length === 0 || title.length > 120) {
          rejected.push(`"${title.slice(0, 40)}" — a title must be 1 to 120 characters.`)
          continue
        }
        if (description.length < 20) {
          rejected.push(
            `"${title}" — the description must say what happens and what must be true afterwards.`,
          )
          continue
        }

        const key = normaliseTitle(title)
        if (seen.has(key)) {
          rejected.push(`"${title}" — this project already has that test.`)
          continue
        }

        seen.add(key)
        accepted.push({ title, description: description.slice(0, 4000) })

        if (accepted.length >= MAX_PROPOSALS) break
      }

      if (accepted.length === 0) {
        return {
          ok: false,
          error: `None of those could be accepted:\n${rejected.map((line) => `- ${line}`).join('\n')}\n\nPropose tests this project does not already have.`,
        }
      }

      // The one push-back worth making. A model that has explored an app and
      // offers two tests has usually stopped at the front door — but an app
      // that genuinely only warrants two has to be able to say so, so this
      // happens exactly once.
      if (accepted.length < MIN_PROPOSALS && !state.refusedThinPlan) {
        state.refusedThinPlan = true
        return {
          ok: false,
          error: `Only ${accepted.length} of those are new. Go and look at more of the app — the parts behind the sign-in form especially — and propose at least ${MIN_PROPOSALS}. If this app genuinely has nothing else worth testing, propose the same list again and it will be accepted.`,
        }
      }

      state.proposals = accepted

      return {
        ok: true,
        accepted: accepted.map((proposal) => proposal.title),
        skipped: rejected,
        note: 'Recorded. Call finish with a short summary of what this app is and how one signs in.',
      }
    },
  })

  const finishTool = tool({
    description:
      'Stop. Call this after propose, with two or three sentences saying what this app is, how one gets into it, and anything a test author would need to know.',
    inputSchema: jsonSchema<{ summary?: string }>({
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'What the app is, how one signs in, and what you could not reach. No credential values.',
        },
      },
      additionalProperties: false,
    }),
    execute({ summary }) {
      state.finished = true
      state.summary = summary?.trim() || null
      return { ok: true }
    },
  })

  const result = await generateText({
    model: resolved.model,
    system: EXPLORE_SYSTEM_PROMPT,
    messages: pruneToolResults(input.messages, {
      keep: RESULTS_KEPT_IN_FULL,
      replacements: PRUNED_FIELDS,
    }),
    tools: {
      observe: observeTool,
      navigate: navigateTool,
      interact: interactTool,
      read_docs: readDocsTool,
      propose: proposeTool,
      finish: finishTool,
    },
    stopWhen: [stepCountIs(MAX_TOOL_STEPS), hasToolCall('finish')],
  })

  return {
    messagesJson: JSON.stringify(result.response.messages),
    proposals: state.proposals,
    sessionId: state.sessionId,
    stepIndexOffset: state.stepIndexOffset,
    docsRead: state.docsRead,
    finished: state.finished || state.fatal !== null,
    summary: state.summary,
    refusedThinPlan: state.refusedThinPlan,
    modelId: resolved.modelId,
    fatal: state.fatal,
  }
}
