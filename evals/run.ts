/**
 * Generates a fixed set of tests against the example apps and scores the result, so a
 * prompt or model change can be measured instead of eyeballed.
 *
 *   pnpm eval --model anthropic:claude-sonnet-5 --model workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast
 *   pnpm eval --model openai:gpt-5.4-mini --only guestbook --limit 3
 *
 * Needs `pnpm dev` running and a signed-in account (defaults to the demo account from
 * `pnpm demo:seed`). Starts the example apps itself if their ports are free. Every
 * generation drives a real browser and bills real tokens; see docs/evals.md.
 */
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { APPS, type EvalApp, type EvalScenario, SCENARIOS } from './scenarios.ts'

const crypto = webcrypto as unknown as Crypto
const ORIGIN = process.env.FLAREMENDER_URL ?? 'http://localhost:3009'
const EMAIL = process.env.FLAREMENDER_EVAL_EMAIL ?? 'ada@example.com'
const PASSWORD =
  process.env.FLAREMENDER_EVAL_PASSWORD ?? process.env.DEMO_PASSWORD ?? 'demo-password-123'
const DIRECTORY = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'
const POLL_MS = 5000
const JOB_TIMEOUT_MS = 25 * 60_000

interface Options {
  models: Array<string>
  only: Array<string>
  limit: number | null
  concurrency: number
  tag: string | null
  keep: boolean
}

function parseArgs(argv: Array<string>): Options {
  const options: Options = {
    models: [],
    only: [],
    limit: null,
    concurrency: 1,
    tag: null,
    keep: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      i += 1
      return value
    }
    if (arg === '--model') options.models.push(next())
    else if (arg === '--only') options.only.push(next())
    else if (arg === '--limit') options.limit = Number(next())
    else if (arg === '--concurrency') options.concurrency = Math.max(1, Number(next()))
    else if (arg === '--tag') options.tag = next()
    else if (arg === '--keep') options.keep = true
    else throw new Error(`Unknown argument ${arg}`)
  }
  if (options.models.length === 0 && process.env.EVAL_MODELS) {
    options.models = process.env.EVAL_MODELS.split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  }
  if (options.models.length === 0) {
    throw new Error('Pass at least one --model, e.g. --model anthropic:claude-sonnet-5')
  }
  return options
}

function openDatabase(): Database.Database {
  const candidates = readdirSync(DIRECTORY)
    .filter((file) => file.endsWith('.sqlite') && file !== 'metadata.sqlite')
    .map((file) => join(DIRECTORY, file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  for (const path of candidates) {
    const candidate = new Database(path)
    if (candidate.prepare("SELECT name FROM sqlite_master WHERE name = 'intent'").get()) {
      candidate.pragma('foreign_keys = ON')
      return candidate
    }
    candidate.close()
  }
  throw new Error('No migrated local database. Run `pnpm db:migrate` and `pnpm dev` first.')
}

// Mirrors src/server/crypto.ts so seeded variables decrypt in the app.
async function encryptSecret(plaintext: string, secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
  return ['v1', b64(iv), b64(new Uint8Array(ciphertext))].join('.')
}

const jar = new Map<string, string>()
const RATE_LIMIT_RETRIES = 8

/** The API allows ten trigger calls a minute; a run that fans out faster waits its turn. */
async function api(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  let response: Response
  for (let attempt = 0; ; attempt += 1) {
    response = await fetch(`${ORIGIN}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) break
    const retryAfter = Number(response.headers.get('retry-after') ?? '10')
    await new Promise((resolve) =>
      setTimeout(resolve, (Number.isFinite(retryAfter) ? retryAfter : 10) * 1000),
    )
  }
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const index = pair?.indexOf('=') ?? -1
    if (pair && index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1))
  }
  const text = await response.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 300) }
  }
  return { status: response.status, json }
}

async function signIn(): Promise<{ userId: string; organizationId: string }> {
  const login = await api('/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD })
  if (login.status !== 200) {
    throw new Error(
      `Could not sign in as ${EMAIL} at ${ORIGIN} (${login.status}). Is \`pnpm dev\` running? Set FLAREMENDER_EVAL_EMAIL and FLAREMENDER_EVAL_PASSWORD for another account.`,
    )
  }
  const session = await api('/api/auth/get-session')
  const organizationId = session.json?.session?.activeOrganizationId
  if (!organizationId)
    throw new Error(`${EMAIL} has no active organization. Create one in the app first.`)
  return { userId: login.json.user.id, organizationId }
}

async function listening(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

const children: Array<ReturnType<typeof spawn>> = []
async function ensureApp(app: EvalApp): Promise<void> {
  if (await listening(app.port)) return
  console.log(`Starting ${app.name} on http://localhost:${app.port}`)
  const child = spawn(process.execPath, [app.serve, String(app.port)], { stdio: 'ignore' })
  children.push(child)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await listening(app.port)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${app.name} did not come up on port ${app.port}`)
}

function slugOf(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

/** Unique per run, so a project kept with --keep is never overwritten by the next run. */
const RUN_STAMP = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')

async function seedProject(
  db: Database.Database,
  who: { userId: string; organizationId: string },
  model: string,
  app: EvalApp,
  encryptionKey: string,
): Promise<{ projectId: string; environmentId: string }> {
  const slug = `eval-${app.key}-${slugOf(model)}-${RUN_STAMP}`
  const key = `${app.key}_${slugOf(model).replace(/-/g, '_')}_${RUN_STAMP}`
  const projectId = `prj_eval_${key}`
  const environmentId = `env_eval_${key}`
  const now = Date.now()

  const variables: Array<[string, string]> = []
  for (const variable of app.variables) {
    variables.push([variable.name, await encryptSecret(variable.value, encryptionKey)])
  }

  db.transaction(() => {
    db.prepare('DELETE FROM project WHERE id = ?').run(projectId)
    db.prepare(
      `INSERT INTO project (id, organization_id, name, slug, description, context, model_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId,
      who.organizationId,
      `Eval · ${app.name} · ${model} · ${RUN_STAMP}`,
      slug,
      app.description,
      app.context,
      model,
      who.userId,
      now,
      now,
    )
    db.prepare(
      `INSERT INTO environment (id, project_id, name, base_url, is_default, created_by, created_at, updated_at)
       VALUES (?, ?, 'Local', ?, 1, ?, ?, ?)`,
    ).run(environmentId, projectId, `http://localhost:${app.port}`, who.userId, now, now)
    for (const [name, encrypted] of variables) {
      db.prepare(
        `INSERT INTO environment_variable (id, environment_id, name, encrypted_value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(`evar_eval_${key}_${name.toLowerCase()}`, environmentId, name, encrypted, now, now)
    }
  })()

  return { projectId, environmentId }
}

interface ScenarioResult {
  scenarioId: string
  app: string
  title: string
  expect: 'pass' | 'refuse'
  model: string
  testId: string | null
  jobId: string | null
  status: string
  verification: string | null
  hasAssertions: boolean
  readiness: string | null
  turns: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  stuckReason: string | null
  /** Whether the outcome matched what the scenario expected. */
  ok: boolean
  /** A refuse scenario that came back as a verified, ready test: a green test for the wrong thing. */
  inverted: boolean
  dashboardUrl: string | null
}

async function runScenario(
  projectId: string,
  model: string,
  scenario: EvalScenario,
): Promise<ScenarioResult> {
  const startedAt = Date.now()
  const base = {
    scenarioId: scenario.id,
    app: scenario.app,
    title: scenario.title,
    expect: scenario.expect,
    model,
    testId: null as string | null,
    jobId: null as string | null,
    verification: null as string | null,
    hasAssertions: false,
    readiness: null as string | null,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    stuckReason: null as string | null,
    inverted: false,
    dashboardUrl: null as string | null,
  }

  const created = await api(`/api/v1/projects/${projectId}/tests`, {
    title: scenario.title,
    description: scenario.description,
  })
  if (created.status !== 201) {
    return {
      ...base,
      status: `create failed (${created.status})`,
      durationMs: Date.now() - startedAt,
      ok: false,
      stuckReason: JSON.stringify(created.json).slice(0, 300),
    }
  }
  base.testId = created.json.test.id
  base.dashboardUrl = created.json.test.dashboardUrl

  const queued = await api(`/api/v1/projects/${projectId}/tests/${base.testId}/generate`, {})
  if (queued.status !== 202) {
    return {
      ...base,
      status: `generate failed (${queued.status})`,
      durationMs: Date.now() - startedAt,
      ok: false,
      stuckReason: JSON.stringify(queued.json).slice(0, 300),
    }
  }
  base.jobId = queued.json.job.id
  console.log(`  → ${model} · ${scenario.title} · ${base.jobId}`)

  let job: any = null
  while (Date.now() - startedAt < JOB_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    const polled = await api(`/api/v1/jobs/${base.jobId}`)
    if (polled.status !== 200) continue
    job = polled.json.job
    if (job.status !== 'queued' && job.status !== 'running') break
  }

  if (!job || job.status === 'queued' || job.status === 'running') {
    return { ...base, status: 'timeout', durationMs: Date.now() - startedAt, ok: false }
  }

  const verified = job.status === 'succeeded'
  const ready = job.test?.readiness === 'ready'
  const inverted = scenario.expect === 'refuse' && verified && ready
  const ok = scenario.expect === 'pass' ? verified && job.script?.hasAssertions === true : !inverted

  const result: ScenarioResult = {
    ...base,
    status: job.status,
    verification: job.verification?.status ?? null,
    hasAssertions: job.script?.hasAssertions === true,
    readiness: job.test?.readiness ?? null,
    turns: job.turns ?? 0,
    inputTokens: job.inputTokens ?? 0,
    outputTokens: job.outputTokens ?? 0,
    durationMs: Date.now() - startedAt,
    stuckReason: job.stuckReason ?? null,
    ok,
    inverted,
  }
  console.log(
    `  ${ok ? '✓' : '✘'} ${scenario.title} — ${result.status}${result.inverted ? ' (INVERTED)' : ''} · ${result.turns} turns · ${result.inputTokens + result.outputTokens} tokens · ${Math.round(result.durationMs / 1000)}s`,
  )
  return result
}

async function pool<T, R>(
  items: Array<T>,
  size: number,
  work: (item: T) => Promise<R>,
): Promise<Array<R>> {
  const results = Array.from({ length: items.length }) as Array<R>
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next
        next += 1
        results[index] = await work(items[index]!)
      }
    }),
  )
  return results
}

function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? '—' : `${Math.round((numerator / denominator) * 100)}%`
}

function summarise(model: string, rows: Array<ScenarioResult>) {
  const passable = rows.filter((row) => row.expect === 'pass')
  const refusable = rows.filter((row) => row.expect === 'refuse')
  const tokens = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0)
  const seconds = rows.reduce((sum, row) => sum + row.durationMs, 0) / 1000
  return {
    model,
    scenarios: rows.length,
    score: pct(rows.filter((row) => row.ok).length, rows.length),
    generated: pct(
      passable.filter((row) => row.status === 'succeeded' || row.status === 'failed').length,
      passable.length,
    ),
    verified: pct(passable.filter((row) => row.status === 'succeeded').length, passable.length),
    asserted: pct(passable.filter((row) => row.hasAssertions).length, passable.length),
    honest: pct(refusable.filter((row) => !row.inverted).length, refusable.length),
    inverted: rows.filter((row) => row.inverted).length,
    avgTurns:
      rows.length === 0
        ? 0
        : Math.round((rows.reduce((sum, row) => sum + row.turns, 0) / rows.length) * 10) / 10,
    tokens,
    minutes: Math.round(seconds / 6) / 10,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const encryptionKey = process.env.ENCRYPTION_KEY
  if (!encryptionKey)
    throw new Error('ENCRYPTION_KEY is not set. `pnpm eval` reads .env.local; is it filled in?')

  let scenarios = SCENARIOS.filter(
    (scenario) =>
      options.only.length === 0 ||
      options.only.includes(scenario.app) ||
      options.only.includes(scenario.id),
  )
  if (options.limit !== null) scenarios = scenarios.slice(0, options.limit)
  if (scenarios.length === 0) throw new Error('No scenarios match --only.')

  const who = await signIn()
  const db = openDatabase()
  const apps = APPS.filter((app) => scenarios.some((scenario) => scenario.app === app.key))
  for (const app of apps) await ensureApp(app)

  console.log(
    `Running ${scenarios.length} scenario(s) across ${options.models.length} model(s), concurrency ${options.concurrency}`,
  )

  const all: Array<ScenarioResult> = []
  const summaries = []
  for (const model of options.models) {
    console.log(`\n${model}`)
    const projects = new Map<string, string>()
    for (const app of apps) {
      const seeded = await seedProject(db, who, model, app, encryptionKey)
      projects.set(app.key, seeded.projectId)
    }
    const rows = await pool(scenarios, options.concurrency, (scenario) =>
      runScenario(projects.get(scenario.app)!, model, scenario),
    )
    all.push(...rows)
    summaries.push(summarise(model, rows))
    if (!options.keep) {
      for (const projectId of projects.values())
        db.prepare('DELETE FROM project WHERE id = ?').run(projectId)
    }
  }

  console.log('')
  console.table(summaries)

  mkdirSync('evals/results', { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join('evals/results', `${stamp}${options.tag ? `-${options.tag}` : ''}.json`)
  writeFileSync(
    file,
    JSON.stringify({ ranAt: stamp, origin: ORIGIN, options, summaries, results: all }, null, 2),
  )
  console.log(
    `\nWrote ${file}${options.keep ? '' : '. Eval projects were deleted; pass --keep to browse them in the app.'}`,
  )

  for (const child of children) child.kill()
  db.close()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  for (const child of children) child.kill()
  process.exit(1)
})
