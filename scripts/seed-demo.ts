/**
 * Fills a local instance with a plausible amount of history: three projects, their
 * environments and tests, fourteen days of regression runs, suite runs, the
 * generation jobs that wrote the scripts (with their token counts), one repair
 * waiting for review, one that was adopted automatically, and a chat transcript.
 * Nothing here talks to a model or a browser, so it costs nothing and is repeatable.
 *
 *   pnpm demo:seed [email]
 *
 * Re-running wipes the demo projects and rebuilds them, so the charts always cover
 * the fourteen days ending today.
 */
import Database from 'better-sqlite3'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'

const crypto = webcrypto as unknown as Crypto
const DIRECTORY = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'
const DAY = 86_400_000
const TREND_DAYS = 14

/** Newest first, so a database left over from an earlier `database_id` is not picked. */
function openDatabase(): Database.Database {
  const candidates = readdirSync(DIRECTORY)
    .filter((file) => file.endsWith('.sqlite') && file !== 'metadata.sqlite')
    .map((file) => join(DIRECTORY, file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

  for (const path of candidates) {
    const candidate = new Database(path)
    const hasSchema = candidate
      .prepare("SELECT name FROM sqlite_master WHERE name = 'intent'")
      .get()
    if (hasSchema) return candidate
    candidate.close()
  }
  throw new Error('No migrated local database. Run `pnpm db:migrate` first.')
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

/** Deterministic, so re-seeding produces the same shape of history. */
let seed = 20260904
function random(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
function between(low: number, high: number): number {
  return Math.floor(low + random() * (high - low))
}

interface TestSpec {
  title: string
  description: string
  steps: Array<string>
  schedule?: string
  /** Roughly how often this test fails, 0 to 1. */
  flakiness?: number
  status?: 'passing' | 'failing' | 'draft' | 'proposed'
}

interface ProjectSpec {
  id: string
  name: string
  slug: string
  description: string
  context: string
  environments: Array<{ name: string; baseUrl: string; isDefault: boolean }>
  variables: Array<{ name: string; value: string }>
  tests: Array<TestSpec>
}

const PROJECTS: Array<ProjectSpec> = [
  {
    id: 'prj_demo_storefront',
    name: 'Storefront',
    slug: 'storefront',
    description: 'The public shop: browsing, cart and checkout.',
    context:
      'A small e-commerce storefront. Sign in at /login with SHOP_EMAIL and SHOP_PASSWORD (***). The cart badge in the header shows the item count. Checkout is a three-step form: address, delivery, payment. Test card 4242 4242 4242 4242 always succeeds.',
    environments: [
      { name: 'Production', baseUrl: 'https://shop.example.com', isDefault: true },
      { name: 'Staging', baseUrl: 'https://staging.shop.example.com', isDefault: false },
    ],
    variables: [
      { name: 'SHOP_EMAIL', value: 'ada@example.com' },
      { name: 'SHOP_PASSWORD', value: 'correct-horse-battery-staple' },
    ],
    tests: [
      {
        title: 'A shopper can sign in',
        description: 'Sign in with a valid account and land on the account page.',
        steps: ['page.goto', 'getByLabel', 'getByLabel', 'getByRole', 'expect'],
        schedule: '0 */4 * * *',
      },
      {
        title: 'Adding an item updates the cart badge',
        description: 'Add a product to the cart and check the header badge shows 1.',
        steps: ['page.goto', 'getByRole', 'getByTestId', 'expect'],
        schedule: '0 */4 * * *',
      },
      {
        title: 'Checkout completes with a test card',
        description: 'Take a full cart through address, delivery and payment.',
        steps: ['page.goto', 'getByRole', 'getByLabel', 'getByLabel', 'getByRole', 'expect'],
        schedule: '0 6 * * *',
        flakiness: 0.12,
      },
      {
        title: 'Search returns matching products',
        description: 'Search for a known product and check it appears in the results.',
        steps: ['page.goto', 'getByPlaceholder', 'keyboard.press', 'expect'],
      },
      {
        title: 'An out-of-stock item cannot be added',
        description: 'The add button is disabled and explains why.',
        steps: ['page.goto', 'getByRole', 'expect', 'expect'],
      },
      {
        title: 'A discount code reduces the total',
        description: 'Apply WELCOME10 and check the total drops by ten percent.',
        steps: ['page.goto', 'getByLabel', 'getByRole', 'expect'],
        status: 'failing',
        flakiness: 0.85,
      },
      {
        title: 'Removing the last item empties the cart',
        description: 'Remove the only item and check the empty-cart message.',
        steps: ['page.goto', 'getByRole', 'expect'],
      },
      {
        title: 'Order history lists a completed order',
        description: 'After checkout, the order shows up under the account.',
        steps: ['page.goto', 'getByRole', 'expect', 'expect'],
      },
      {
        title: 'Sign out returns to the home page',
        description: 'Sign out from the account menu.',
        steps: ['page.goto', 'getByRole', 'getByRole', 'expect'],
      },
      {
        title: 'A wrong password is rejected',
        description: 'Sign in with a bad password and check the error message.',
        steps: ['page.goto', 'getByLabel', 'getByLabel', 'getByRole', 'expect'],
      },
      {
        title: 'The cart survives a page reload',
        description: 'Add an item, reload, and check the badge still shows 1.',
        steps: ['page.goto', 'getByRole', 'page.reload', 'expect'],
        status: 'draft',
      },
      {
        title: 'Gift wrapping adds a line to the order summary',
        description: 'Tick gift wrapping at checkout and check the summary.',
        steps: ['page.goto', 'getByLabel', 'expect'],
        status: 'proposed',
      },
    ],
  },
  {
    id: 'prj_demo_taskbox',
    name: 'Taskbox',
    slug: 'taskbox',
    description: 'The internal task tracker.',
    context:
      'A single-page task tracker. No sign-in. Tasks are added with the input at the top and completed by ticking the checkbox beside them. The counter under the list reads "N left".',
    environments: [
      { name: 'Local', baseUrl: 'http://localhost:4173', isDefault: true },
      { name: 'Preview', baseUrl: 'https://taskbox-preview.example.com', isDefault: false },
    ],
    variables: [],
    tests: [
      {
        title: 'A new task appears in the list',
        description: 'Type a task, press Enter, and check it is listed.',
        steps: ['page.goto', 'getByPlaceholder', 'keyboard.press', 'expect'],
        schedule: '*/30 * * * *',
      },
      {
        title: 'Completing a task decrements the counter',
        description: 'Tick a task and check the remaining count drops by one.',
        steps: ['page.goto', 'getByRole', 'expect'],
        schedule: '*/30 * * * *',
      },
      {
        title: 'An empty task is refused',
        description: 'Press Enter with an empty input and check nothing is added.',
        steps: ['page.goto', 'keyboard.press', 'expect'],
      },
      {
        title: 'Tasks survive a reload',
        description: 'Add two tasks, reload, and check both are still there.',
        steps: ['page.goto', 'getByPlaceholder', 'page.reload', 'expect'],
      },
      {
        title: 'Deleting a task removes it',
        description: 'Delete a task and check it is gone from the list.',
        steps: ['page.goto', 'getByRole', 'expect'],
      },
      {
        title: 'The filter shows only active tasks',
        description: 'Complete one task, filter to Active, and check it is hidden.',
        steps: ['page.goto', 'getByRole', 'getByRole', 'expect'],
        flakiness: 0.08,
      },
      {
        title: 'Clearing completed empties the done list',
        description: 'Press Clear completed and check only active tasks remain.',
        steps: ['page.goto', 'getByRole', 'expect'],
      },
    ],
  },
  {
    id: 'prj_demo_guestbook',
    name: 'Guestbook',
    slug: 'guestbook',
    description: 'A tiny public guestbook, used to check the explore flow.',
    context:
      'A one-page guestbook. Anyone can leave a name and a message. Entries appear newest first. There is no authentication.',
    environments: [{ name: 'Local', baseUrl: 'http://localhost:4174', isDefault: true }],
    variables: [],
    tests: [
      {
        title: 'A signed entry appears at the top',
        description: 'Leave a message and check it is the first entry.',
        steps: ['page.goto', 'getByLabel', 'getByLabel', 'getByRole', 'expect'],
      },
      {
        title: 'An empty message is refused',
        description: 'Submit without a message and check the validation error.',
        steps: ['page.goto', 'getByRole', 'expect'],
      },
      {
        title: 'A long message is truncated in the list',
        description: 'Leave a very long message and check the list shows a preview.',
        steps: ['page.goto', 'getByLabel', 'getByRole', 'expect'],
      },
      {
        title: 'Entries survive a reload',
        description: 'Leave a message, reload, and check it is still listed.',
        steps: ['page.goto', 'getByLabel', 'page.reload', 'expect'],
      },
      {
        title: 'HTML in a message is escaped',
        description: 'Leave a message containing a script tag and check it renders as text.',
        steps: ['page.goto', 'getByLabel', 'getByRole', 'expect'],
        status: 'proposed',
      },
      {
        title: 'The entry count matches the list length',
        description: 'Check the header count agrees with the number of entries.',
        steps: ['page.goto', 'expect'],
        status: 'proposed',
      },
    ],
  },
]

function scriptFor(spec: TestSpec, baseUrlHint: string): string {
  const body = spec.steps
    .map((step) => {
      switch (step) {
        case 'page.goto':
          return `  await page.goto('/')`
        case 'getByLabel':
          return `  await page.getByLabel('Email').fill(secret('SHOP_EMAIL'))`
        case 'getByPlaceholder':
          return `  await page.getByPlaceholder('What needs doing?').fill('Write the release notes')`
        case 'getByTestId':
          return `  await expect(page.getByTestId('cart-count')).toHaveText('1')`
        case 'keyboard.press':
          return `  await page.keyboard.press('Enter')`
        case 'page.reload':
          return `  await page.reload()`
        case 'getByRole':
          return `  await page.getByRole('button', { name: 'Continue' }).click()`
        default:
          return `  await expect(page.getByRole('heading', { name: '${spec.title}' })).toBeVisible()`
      }
    })
    .join('\n')

  return `// ${spec.description}\n// Base URL comes from the environment (${baseUrlHint}).\nexport default async function ({ page, expect, secret }) {\n${body}\n}\n`
}

function stepRecords(spec: TestSpec, failAt: number | null): Array<Record<string, unknown>> {
  const labels: Record<string, string> = {
    'page.goto': "page.goto('/')",
    getByLabel: "page.getByLabel('Email').fill('***')",
    getByPlaceholder: "page.getByPlaceholder('What needs doing?').fill('Write the release notes')",
    getByTestId: "expect(page.getByTestId('cart-count')).toHaveText('1')",
    'keyboard.press': "page.keyboard.press('Enter')",
    'page.reload': 'page.reload()',
    getByRole: "page.getByRole('button', { name: 'Continue' }).click()",
    expect: `expect(page.getByRole('heading', { name: '${spec.title}' })).toBeVisible()`,
  }

  return spec.steps.map((step, index) => {
    const failed = failAt !== null && index === failAt
    return {
      label: labels[step] ?? step,
      ok: failAt === null || index < failAt,
      durationMs: between(40, 1400),
      ...(failed
        ? {
            error: `Timed out 30000ms waiting for expect(locator).toBeVisible()\n\nLocator: getByRole('heading', { name: '${spec.title}' })\nExpected: visible\nReceived: <element not found>`,
          }
        : {}),
    }
  })
}

const DEMO_MODEL = 'anthropic:claude-sonnet-5'

interface RepairStory {
  projectId: string
  /** Index of the test in the project's list. */
  testIndex: number
  /** The run the agent set out to fix: this many days ago, suite 0. */
  daysAgo: number
  failingStatement: string
  replacement: string
  error: string
  /** `draft` leaves the repair pending for review; `auto` adopts it and heals the run. */
  outcome: 'draft' | 'auto'
}

const REPAIRS: Array<RepairStory> = [
  {
    projectId: 'prj_demo_storefront',
    testIndex: 2,
    daysAgo: 1,
    failingStatement: "await page.getByRole('button', { name: 'Continue' }).click()",
    replacement: "await page.getByRole('button', { name: 'Continue to delivery' }).click()",
    error:
      "locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Continue' })",
    outcome: 'draft',
  },
  {
    projectId: 'prj_demo_taskbox',
    testIndex: 5,
    daysAgo: 3,
    failingStatement: "await page.getByRole('button', { name: 'Continue' }).click()",
    replacement: "await page.getByRole('button', { name: 'Active' }).click()",
    error:
      "locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Continue' })",
    outcome: 'auto',
  },
]

/**
 * Rewrites one seeded run as a failure the agent repaired: a second script version,
 * a verification run that passed, the repair job with its token count, and either a
 * pending repair on the test or an adopted version with the run marked healed.
 */
function seedRepair(
  db: Database.Database,
  story: RepairStory,
  scope: {
    projectId: string
    slug: string
    organizationId: string
    userId: string
    environmentId: string
    environmentName: string
    baseUrl: string
    now: number
  },
): void {
  const intentId = `int_${scope.slug}_${story.testIndex}`
  const sourceVersionId = `sv_${scope.slug}_${story.testIndex}`
  const sourceRunId = `run_${scope.slug}_${story.daysAgo}_0_${story.testIndex}`
  const source = db.prepare('SELECT started_at FROM run WHERE id = ?').get(sourceRunId) as
    | { started_at: number }
    | undefined
  if (!source) return

  const versionId = `sv_${scope.slug}_${story.testIndex}_repair`
  const verificationRunId = `run_${scope.slug}_${story.testIndex}_repair`
  const jobId = `rep_${scope.slug}_${story.testIndex}`
  const original = db
    .prepare('SELECT code FROM script_version WHERE id = ?')
    .get(sourceVersionId) as {
    code: string
  }
  const repairedCode = original.code.includes(story.failingStatement)
    ? original.code.replace(story.failingStatement, story.replacement)
    : original.code.replace('\n}\n', `\n  ${story.replacement}\n}\n`)
  const firstLine = story.error.split('\n')[0]!
  const whatFailed = `${story.failingStatement} — ${firstLine}`
  const failedAt = source.started_at
  const repairedAt = failedAt + between(90_000, 240_000)
  const adopted = story.outcome === 'auto'

  // The source run failed on the statement the repair replaces.
  const failedSteps = [
    { label: "page.goto('/')", ok: true, durationMs: between(300, 900) },
    {
      label: story.failingStatement.replace(/^await\s+/, ''),
      ok: false,
      durationMs: 30_000,
      error: story.error,
    },
  ]
  db.prepare(
    'UPDATE run SET status = ?, error_message = ?, script_version_id = ? WHERE id = ?',
  ).run(adopted ? 'healed' : 'failed', story.error, sourceVersionId, sourceRunId)
  db.prepare(
    'UPDATE attempt SET outcome = ?, error_message = ?, result = ?, heal_applied = ? WHERE run_id = ?',
  ).run(
    'failed',
    story.error,
    JSON.stringify({
      outcome: 'failed',
      steps: failedSteps,
      errorMessage: story.error,
      logs: [],
      durationMs: 30_600,
    }),
    JSON.stringify({ jobId, versionId, version: 2, whatFailed, adopted, policy: story.outcome }),
    sourceRunId,
  )

  db.prepare(
    `INSERT INTO script_version (id, intent_id, version, code, author, created_by, note, created_at)
     VALUES (?, ?, 2, ?, 'agent', ?, ?, ?)`,
  ).run(
    versionId,
    intentId,
    repairedCode,
    scope.userId,
    `Repaired from v1: ${whatFailed}`,
    repairedAt,
  )

  const verifySteps = [
    { label: "page.goto('/')", ok: true, durationMs: between(300, 900) },
    {
      label: story.replacement.replace(/^await\s+/, ''),
      ok: true,
      durationMs: between(200, 1_200),
    },
    { label: 'expect(locator).toBeVisible()', ok: true, durationMs: between(80, 400) },
  ]
  const verifyDuration = verifySteps.reduce((sum, step) => sum + step.durationMs, 0)
  db.prepare(
    `INSERT INTO run (id, intent_id, environment_id, project_id, script_version_id, status, trigger, purpose,
                      environment_name, base_url, model_id, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, 'passed', 'repair', 'repair-verification', ?, ?, ?, ?, ?)`,
  ).run(
    verificationRunId,
    intentId,
    scope.environmentId,
    scope.projectId,
    versionId,
    scope.environmentName,
    scope.baseUrl,
    DEMO_MODEL,
    repairedAt,
    repairedAt + verifyDuration,
  )
  db.prepare(
    `INSERT INTO attempt (id, run_id, attempt_number, outcome, script_version_id, script_used, artifact_keys, logs,
                          error_message, duration_ms, created_at, result)
     VALUES (?, ?, 1, 'passed', ?, ?, '{}', ?, NULL, ?, ?, ?)`,
  ).run(
    `att_${verificationRunId}`,
    verificationRunId,
    versionId,
    repairedCode,
    JSON.stringify(['Verifying the repaired script in a fresh browser session']),
    verifyDuration,
    repairedAt + verifyDuration,
    JSON.stringify({
      outcome: 'passed',
      steps: verifySteps,
      errorMessage: null,
      logs: [],
      durationMs: verifyDuration,
    }),
  )

  db.prepare(
    `INSERT INTO generation_job (id, kind, intent_id, project_id, environment_id, organization_id, status, model_id,
                                 script_version_id, run_id, source_run_id, turns, input_tokens, output_tokens,
                                 created_by, started_at, finished_at)
     VALUES (?, 'repair', ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    intentId,
    scope.projectId,
    scope.environmentId,
    scope.organizationId,
    DEMO_MODEL,
    versionId,
    verificationRunId,
    sourceRunId,
    between(1, 3),
    between(16_000, 38_000),
    between(300, 900),
    scope.userId,
    failedAt + 20_000,
    repairedAt + verifyDuration,
  )

  if (adopted) {
    // Everything that ran after the repair ran the repaired version.
    db.prepare(
      'UPDATE intent SET current_version_id = ?, pending_repair_version_id = NULL WHERE id = ?',
    ).run(versionId, intentId)
    db.prepare(
      "UPDATE run SET script_version_id = ? WHERE intent_id = ? AND started_at > ? AND purpose = 'regression'",
    ).run(versionId, intentId, repairedAt)
    db.prepare(
      `UPDATE attempt SET script_version_id = ?, script_used = ?
       WHERE run_id IN (SELECT id FROM run WHERE intent_id = ? AND started_at > ? AND purpose = 'regression')`,
    ).run(versionId, repairedCode, intentId, repairedAt)
  } else {
    db.prepare(
      "UPDATE intent SET pending_repair_version_id = ?, last_run_id = ?, status = 'failing' WHERE id = ?",
    ).run(versionId, sourceRunId, intentId)
  }
}

const ORIGIN = process.env.FLAREMENDER_URL ?? 'http://localhost:3009'
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123'
const ORG_NAME = process.env.DEMO_ORG ?? 'Acme Inc.'

interface Author {
  id: string
  organizationId: string
}

function findAuthor(db: Database.Database, email: string): Author | undefined {
  return db
    .prepare(
      `SELECT u.id AS id, m.organization_id AS organizationId
       FROM user u JOIN member m ON m.user_id = u.id
       WHERE u.email = ? LIMIT 1`,
    )
    .get(email) as Author | undefined
}

/** Collects Set-Cookie across the sign-up and organization calls. */
function mergeCookies(jar: Map<string, string>, response: Response): void {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const index = pair?.indexOf('=') ?? -1
    if (pair && index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1))
  }
}

/**
 * Creates the demo account and its organization through the running app, so the
 * password is hashed the way Better Auth expects rather than forged in SQL.
 */
async function bootstrapAccount(db: Database.Database, email: string): Promise<void> {
  const jar = new Map<string, string>()
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')

  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Better Auth rejects requests with no Origin as a CSRF precaution.
        origin: ORIGIN,
        ...(jar.size > 0 ? { cookie: cookieHeader() } : {}),
      },
      body: JSON.stringify(body),
    })
    mergeCookies(jar, response)
    return response
  }

  console.log(`Creating ${email} through ${ORIGIN}`)
  const signUp = await post('/api/auth/sign-up/email', {
    name: 'Ada Lovelace',
    email,
    password: PASSWORD,
  })

  if (!signUp.ok) {
    // The account may already exist from an interrupted run; a session is all we need.
    const signIn = await post('/api/auth/sign-in/email', { email, password: PASSWORD })
    if (!signIn.ok) {
      const detail = await signUp.text()
      throw new Error(
        `Could not sign up or sign in as ${email}. Is \`pnpm dev\` running, and is DISABLE_SIGNUP off?\n${detail.slice(0, 300)}`,
      )
    }
  }

  const slug = ORG_NAME.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  const org = await post('/api/auth/organization/create', { name: ORG_NAME, slug })

  if (!org.ok) {
    const detail = await org.text()
    // An organization left behind by a previous run is fine; join it instead.
    const existing = db.prepare('SELECT id FROM organization WHERE slug = ? LIMIT 1').get(slug) as
      | { id: string }
      | undefined
    const user = db.prepare('SELECT id FROM user WHERE email = ? LIMIT 1').get(email) as
      | { id: string }
      | undefined

    if (!existing || !user) {
      throw new Error(`Creating the organization failed (${org.status}).\n${detail.slice(0, 300)}`)
    }

    db.prepare(
      `INSERT OR IGNORE INTO member (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    ).run(`mem_demo_${user.id.slice(0, 12)}`, existing.id, user.id, Date.now())
    console.log(`Created ${email} and joined the existing "${ORG_NAME}" organization`)
    return
  }

  console.log(`Created ${email} and the "${ORG_NAME}" organization`)
}

async function main() {
  const email = process.argv[2] ?? 'ada@example.com'
  const encryptionKey = process.env.ENCRYPTION_KEY
  if (!encryptionKey) throw new Error('Set ENCRYPTION_KEY (it is in your .env.local).')

  const db = openDatabase()
  db.pragma('foreign_keys = ON')

  let author = findAuthor(db, email)
  if (!author) {
    // Nothing to seed against yet, so make the account the same way a person would.
    await bootstrapAccount(db, email)
    author = findAuthor(db, email)
  }

  if (!author) {
    throw new Error(
      `Still no organization for ${email} after bootstrapping. Check that \`pnpm dev\` is running.`,
    )
  }

  const now = Date.now()
  const startOfToday = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`)

  const encrypted = new Map<string, string>()
  for (const project of PROJECTS) {
    for (const variable of project.variables) {
      encrypted.set(
        `${project.id}:${variable.name}`,
        await encryptSecret(variable.value, encryptionKey),
      )
    }
  }

  const insert = db.transaction(() => {
    for (const project of PROJECTS) {
      db.prepare('DELETE FROM project WHERE id = ?').run(project.id)
      db.prepare(
        `INSERT INTO project (id, organization_id, name, slug, description, context, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        project.id,
        author.organizationId,
        project.name,
        project.slug,
        project.description,
        project.context,
        author.id,
        now - 40 * DAY,
        now,
      )

      const environmentIds: Array<string> = []
      project.environments.forEach((environment, index) => {
        const id = `env_${project.slug}_${index}`
        environmentIds.push(id)
        db.prepare(
          `INSERT INTO environment (id, project_id, name, base_url, is_default, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          project.id,
          environment.name,
          environment.baseUrl,
          environment.isDefault ? 1 : 0,
          author.id,
          now - 40 * DAY,
          now,
        )

        if (environment.isDefault) {
          for (const variable of project.variables) {
            db.prepare(
              `INSERT INTO environment_variable (id, environment_id, name, encrypted_value, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            ).run(
              `evar_${project.slug}_${variable.name.toLowerCase()}`,
              id,
              variable.name,
              encrypted.get(`${project.id}:${variable.name}`)!,
              now - 40 * DAY,
              now,
            )
          }
        }
      })

      const defaultEnvironment = environmentIds[0]!
      const defaultEnvironmentName = project.environments[0]!.name
      const defaultBaseUrl = project.environments[0]!.baseUrl

      const runnable: Array<{ intentId: string; versionId: string; spec: TestSpec }> = []

      project.tests.forEach((spec, index) => {
        const intentId = `int_${project.slug}_${index}`
        const versionId = `sv_${project.slug}_${index}`
        const status = spec.status ?? 'passing'
        const proposed = status === 'proposed'
        const readiness = proposed || status === 'draft' ? 'draft' : 'ready'

        db.prepare(
          `INSERT INTO intent (id, project_id, title, description, status, current_version_id, schedule, readiness, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          intentId,
          project.id,
          spec.title,
          spec.description,
          status,
          proposed ? null : versionId,
          spec.schedule ?? null,
          readiness,
          author.id,
          now - between(20, 38) * DAY,
          now,
        )

        if (proposed) return

        db.prepare(
          `INSERT INTO script_version (id, intent_id, version, code, author, created_by, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          versionId,
          intentId,
          1,
          scriptFor(spec, defaultBaseUrl),
          'agent',
          author.id,
          'Generated from the intent and verified step by step.',
          now - between(20, 38) * DAY,
        )

        if (status !== 'draft') runnable.push({ intentId, versionId, spec })

        // The generation that wrote this script, so usage has something to add up.
        const generatedAt = now - between(20, 38) * DAY
        db.prepare(
          `INSERT INTO generation_job (id, kind, intent_id, project_id, environment_id, organization_id, status,
                                       model_id, script_version_id, turns, input_tokens, output_tokens, created_by,
                                       started_at, finished_at)
           VALUES (?, 'generate', ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `gen_${project.slug}_${index}`,
          intentId,
          project.id,
          defaultEnvironment,
          author.organizationId,
          DEMO_MODEL,
          versionId,
          between(1, 5),
          between(14_000, 46_000),
          between(400, 1_400),
          author.id,
          generatedAt,
          generatedAt + between(30_000, 240_000),
        )
      })

      // Fourteen days of regression history, grouped into one suite run per day.
      for (let dayOffset = TREND_DAYS - 1; dayOffset >= 0; dayOffset -= 1) {
        const dayStart = startOfToday - dayOffset * DAY
        const suitesToday = dayOffset === 0 ? 1 : between(1, 3)

        for (let suiteIndex = 0; suiteIndex < suitesToday; suiteIndex += 1) {
          const suiteId = `srun_${project.slug}_${dayOffset}_${suiteIndex}`
          const suiteStart = dayStart + between(6, 20) * 3_600_000
          if (suiteStart > now) continue

          let passed = 0
          let failed = 0
          const runRows: Array<() => void> = []

          runnable.forEach(({ intentId, versionId, spec }, testIndex) => {
            const flakiness = spec.flakiness ?? 0.02
            const isFailure = random() < flakiness
            const status = isFailure ? (random() < 0.85 ? 'failed' : 'error') : 'passed'
            if (isFailure) failed += 1
            else passed += 1

            const runId = `run_${project.slug}_${dayOffset}_${suiteIndex}_${testIndex}`
            const startedAt = suiteStart + testIndex * between(3_000, 9_000)
            const durationMs = between(1_800, 26_000)
            const failAt = isFailure ? between(1, Math.max(2, spec.steps.length)) - 1 : null
            const steps = stepRecords(spec, failAt)
            const errorMessage = isFailure
              ? ((steps.find((step) => step.error)?.error as string | undefined) ??
                'The script did not finish.')
              : null

            runRows.push(() => {
              db.prepare(
                `INSERT INTO run (id, intent_id, environment_id, project_id, script_version_id, suite_run_id,
                                  status, trigger, started_at, finished_at, purpose, environment_name, base_url, error_message)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'regression', ?, ?, ?)`,
              ).run(
                runId,
                intentId,
                defaultEnvironment,
                project.id,
                versionId,
                suiteId,
                status,
                spec.schedule ? 'schedule' : 'manual',
                startedAt,
                startedAt + durationMs,
                defaultEnvironmentName,
                defaultBaseUrl,
                errorMessage,
              )

              db.prepare(
                `INSERT INTO attempt (id, run_id, attempt_number, outcome, script_version_id, script_used,
                                      artifact_keys, logs, error_message, duration_ms, created_at, result)
                 VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              ).run(
                `att_${runId}`,
                runId,
                isFailure ? (status === 'error' ? 'error' : 'failed') : 'passed',
                versionId,
                scriptFor(spec, defaultBaseUrl),
                JSON.stringify({}),
                JSON.stringify([
                  `Navigating to ${defaultBaseUrl}`,
                  'Browser session started',
                  ...(isFailure ? ['Retrying locator once before giving up'] : []),
                  `Finished in ${(durationMs / 1000).toFixed(1)}s`,
                ]),
                errorMessage,
                durationMs,
                startedAt + durationMs,
                JSON.stringify({
                  outcome: isFailure ? (status === 'error' ? 'error' : 'failed') : 'passed',
                  steps,
                  errorMessage,
                  logs: [],
                  durationMs,
                }),
              )
            })
          })

          db.prepare(
            `INSERT INTO suite_run (id, project_id, environment_id, status, trigger, total_count,
                                    passed_count, failed_count, error_count, created_by, started_at, finished_at,
                                    environment_name, base_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
          ).run(
            suiteId,
            project.id,
            defaultEnvironment,
            failed > 0 ? 'failed' : 'passed',
            suiteIndex === 0 ? 'schedule' : 'manual',
            runnable.length,
            passed,
            failed,
            author.id,
            suiteStart,
            suiteStart + between(40_000, 180_000),
            defaultEnvironmentName,
            defaultBaseUrl,
          )

          for (const write of runRows) write()
        }
      }

      // A test marked failing must actually have failed most recently: the badge is
      // derived from the newest run, not from intent.status.
      for (const spec of project.tests) {
        if (spec.status !== 'failing') continue
        const index = project.tests.indexOf(spec)
        const intentId = `int_${project.slug}_${index}`
        const newest = db
          .prepare('SELECT id FROM run WHERE intent_id = ? ORDER BY started_at DESC LIMIT 1')
          .get(intentId) as { id: string } | undefined
        if (!newest) continue

        const steps = stepRecords(spec, spec.steps.length - 1)
        const message = steps.at(-1)?.error as string
        const durationMs = steps.reduce((sum, step) => sum + (step.durationMs as number), 0)

        db.prepare('UPDATE run SET status = ?, error_message = ? WHERE id = ?').run(
          'failed',
          message,
          newest.id,
        )
        db.prepare(
          'UPDATE attempt SET outcome = ?, error_message = ?, result = ? WHERE run_id = ?',
        ).run(
          'failed',
          message,
          JSON.stringify({ outcome: 'failed', steps, errorMessage: message, logs: [], durationMs }),
          newest.id,
        )
      }

      // Point each test at its most recent run.
      db.prepare(
        `UPDATE intent SET last_run_id = (
           SELECT r.id FROM run r WHERE r.intent_id = intent.id ORDER BY r.started_at DESC LIMIT 1
         ) WHERE project_id = ?`,
      ).run(project.id)

      for (const story of REPAIRS.filter((entry) => entry.projectId === project.id)) {
        seedRepair(db, story, {
          projectId: project.id,
          slug: project.slug,
          organizationId: author.organizationId,
          userId: author.id,
          environmentId: defaultEnvironment,
          environmentName: defaultEnvironmentName,
          baseUrl: defaultBaseUrl,
          now,
        })
      }
    }

    // Repairs are proposed for review in the demo organization; the walkthrough shows
    // the banner a person accepts.
    db.prepare(
      `INSERT INTO organization_settings (organization_id, heal_policy, updated_by, updated_at)
       VALUES (?, 'draft', ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET heal_policy = 'draft', updated_at = excluded.updated_at`,
    ).run(author.organizationId, author.id, now)

    // Point the run card at a run that actually failed, so the card matches the words.
    const failedRun = db
      .prepare(
        `SELECT id FROM run WHERE intent_id = 'int_storefront_5' AND status = 'failed'
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get() as { id: string } | undefined
    const failedSuite = db
      .prepare(
        `SELECT id FROM suite_run WHERE project_id = 'prj_demo_storefront' AND status = 'failed'
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get() as { id: string } | undefined

    // A short chat transcript on Storefront, with the cards the assistant answers in.
    const transcript: Array<{ role: 'user' | 'assistant'; parts: Array<unknown>; offset: number }> =
      [
        {
          role: 'user',
          offset: 46,
          parts: [
            {
              type: 'text',
              text: 'Add a test that checks a discount code reduces the order total. The code is WELCOME10 and it takes ten percent off.',
            },
          ],
        },
        {
          role: 'assistant',
          offset: 45,
          parts: [
            {
              type: 'text',
              text: 'Writing that one now. I will sign in first, put an item in the cart, then apply the code and compare the total before and after.',
            },
            {
              type: 'card',
              card: {
                kind: 'intent',
                intentId: 'int_storefront_5',
                title: 'A discount code reduces the total',
                status: 'failing',
                schedule: null,
              },
            },
          ],
        },
        {
          role: 'assistant',
          offset: 43,
          parts: [
            {
              type: 'text',
              text: 'The script is written and I ran it once to check it. It failed, and I think it found a real bug rather than a broken test: the total in the order summary does not change after the code is accepted. The discount shows on the line item but not in the sum.',
            },
            {
              type: 'card',
              card: {
                kind: 'run',
                runId: failedRun?.id ?? 'run_storefront_0_0_5',
                intentId: 'int_storefront_5',
                intentTitle: 'A discount code reduces the total',
                environmentName: 'Production',
                status: 'failed',
              },
            },
          ],
        },
        {
          role: 'user',
          offset: 40,
          parts: [{ type: 'text', text: 'Run the whole suite against staging so I can compare.' }],
        },
        {
          role: 'assistant',
          offset: 39,
          parts: [
            {
              type: 'text',
              text: 'Started. Ten ready tests against Staging. The discount test fails there too, so it is not a production-only problem.',
            },
            {
              type: 'card',
              card: {
                kind: 'suite',
                suiteRunId: failedSuite?.id ?? 'srun_storefront_0_0',
                environmentName: 'Staging',
                status: 'failed',
              },
            },
          ],
        },
        {
          role: 'user',
          offset: 31,
          parts: [
            {
              type: 'text',
              text: 'The checkout test started failing this morning. The page did not change as far as I know. Can you repair it?',
            },
          ],
        },
        {
          role: 'assistant',
          offset: 30,
          parts: [
            {
              type: 'text',
              text: 'Replaying it now to find the step that broke. Repairs in this organization wait for review, so I will leave the result on the test for you to accept.',
            },
            {
              type: 'card',
              card: {
                kind: 'generation',
                job: 'repair',
                jobId: 'rep_storefront_2',
                intentId: 'int_storefront_2',
                intentTitle: 'Checkout completes with a test card',
                environmentName: 'Production',
              },
            },
          ],
        },
      ]

    db.prepare('DELETE FROM chat_message WHERE project_id = ?').run('prj_demo_storefront')
    transcript.forEach((message, index) => {
      db.prepare(
        `INSERT INTO chat_message (id, project_id, role, parts, status, model_id, input_tokens, output_tokens, created_by, created_at)
         VALUES (?, ?, ?, ?, 'complete', ?, ?, ?, ?, ?)`,
      ).run(
        `msg_demo_${index}`,
        'prj_demo_storefront',
        message.role,
        JSON.stringify(message.parts),
        message.role === 'assistant' ? DEMO_MODEL : null,
        message.role === 'assistant' ? between(6_000, 14_000) : 0,
        message.role === 'assistant' ? between(120, 420) : 0,
        message.role === 'user' ? author.id : null,
        now - message.offset * 60_000,
      )
    })
  })

  insert()

  const counts = db
    .prepare(
      `SELECT (SELECT count(*) FROM project WHERE id LIKE 'prj_demo_%') AS projects,
              (SELECT count(*) FROM intent WHERE project_id LIKE 'prj_demo_%') AS tests,
              (SELECT count(*) FROM run WHERE project_id LIKE 'prj_demo_%') AS runs,
              (SELECT count(*) FROM suite_run WHERE project_id LIKE 'prj_demo_%') AS suites`,
    )
    .get() as Record<string, number>

  db.close()
  console.log(
    `Demo data ready for ${email}: ${counts.projects} projects, ${counts.tests} tests, ${counts.runs} runs across ${counts.suites} suite runs.`,
  )
  console.log('Open http://localhost:3009/dashboard')
}

await main()
