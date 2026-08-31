import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { manualScenarios } from './manual-scenarios.ts'

const origin = 'http://localhost:3000'
const password = process.env.FLAREMENDER_TEST_PASSWORD
if (!password) throw new Error('Set FLAREMENDER_TEST_PASSWORD for the local instance account.')
const cookies = new Map<string, string>()
async function request(path: string, body?: unknown, authenticated = true) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      ...(authenticated
        ? { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0]
    const at = pair.indexOf('=')
    cookies.set(pair.slice(0, at), pair.slice(at + 1))
  }
  return response
}
const login = await request('/api/auth/sign-in/email', {
  email: process.env.FLAREMENDER_TEST_EMAIL ?? 'admin@flaremender.test',
  password,
})
assert.equal(login.status, 200, 'Local sign-in failed')
const directory = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'
let db: Database.Database | undefined
for (const name of readdirSync(directory).filter(
  (file) => file.endsWith('.sqlite') && file !== 'metadata.sqlite',
)) {
  const candidate = new Database(join(directory, name), { readonly: true })
  if (candidate.prepare("SELECT name FROM sqlite_master WHERE name = 'suite_run'").get()) {
    db = candidate
    break
  }
  candidate.close()
}
assert.ok(db)
const project = db
  .prepare("SELECT organization_id AS org FROM project WHERE id = 'prj_manual_lab'")
  .get() as { org: string }
const active = await request('/api/auth/organization/set-active', { organizationId: project.org })
assert.equal(active.status, 200)
const suite = db
  .prepare(
    "SELECT * FROM suite_run WHERE project_id = 'prj_manual_lab' ORDER BY started_at DESC LIMIT 1",
  )
  .get() as {
  id: string
  status: string
  total_count: number
  passed_count: number
  failed_count: number
  error_count: number
}
assert.ok(suite, 'Run the manual fixture suite in the UI first')
assert.equal(suite.status, 'error', 'The fixture intentionally includes execution errors')
assert.equal(suite.total_count, 12)
assert.equal(suite.passed_count, 7)
assert.equal(suite.failed_count, 2)
assert.equal(suite.error_count, 3)
const path = `/api/reports/suites/${suite.id}`
assert.equal((await request(path, undefined, false)).status, 401)
const json = await request(path)
assert.equal(json.status, 200)
assert.match(json.headers.get('Cache-Control') ?? '', /no-store/)
const report = (await json.json()) as {
  suite: { totalCount: number }
  runs: Array<{
    id: string
    status: string
    purpose: string
    test: { id: string }
    attempts: Array<{ steps: unknown[]; errorMessage: string | null }>
  }>
}
assert.equal(report.runs.length, suite.total_count)
for (const run of report.runs) {
  const scenario = manualScenarios.find((item) => run.test.id === `int_lab_${item.id}`)
  assert.ok(scenario)
  assert.equal(run.purpose, 'regression')
  assert.equal(run.status, scenario.expected, scenario.title)
  assert.ok(!('draft' in scenario))
  const individual = (await (await request(`/api/reports/runs/${run.id}`)).json()) as {
    run: unknown
  }
  assert.deepEqual(individual.run, run)
}
const junit = await request(`${path}?format=junit`)
assert.equal(junit.status, 200)
const xml = await junit.text()
assert.match(xml, /tests="12" failures="2" errors="3" skipped="0"/)
assert.ok(!JSON.stringify(report).includes('encryptedValue'))
assert.ok(!JSON.stringify(report).includes('scriptUsed'))

// Optional fresh-AI acceptance project: nine complete scenarios and one
// deliberately impossible feature. Verification must not count as regression.
const aiProjectId = process.env.FLAREMENDER_AI_PROJECT_ID
if (aiProjectId) {
  const aiSuite = db
    .prepare(
      'SELECT id, status, total_count, passed_count FROM suite_run WHERE project_id = ? ORDER BY started_at DESC LIMIT 1',
    )
    .get(aiProjectId) as
    | { id: string; status: string; total_count: number; passed_count: number }
    | undefined
  assert.ok(aiSuite, 'Run the AI acceptance suite first')
  assert.equal(aiSuite.status, 'passed')
  assert.equal(aiSuite.total_count, 9)
  assert.equal(aiSuite.passed_count, 9)
  const aiPath = `/api/reports/suites/${aiSuite.id}`
  const aiResponse = await request(aiPath)
  assert.equal(aiResponse.status, 200)
  const aiReport = (await aiResponse.json()) as typeof report
  assert.equal(aiReport.runs.length, 9)
  for (const run of aiReport.runs) {
    assert.equal(run.purpose, 'regression')
    assert.equal(run.status, 'passed')
    const individual = (await (await request(`/api/reports/runs/${run.id}`)).json()) as {
      run: unknown
    }
    assert.deepEqual(individual.run, run)
  }
  assert.match(
    await (await request(`${aiPath}?format=junit`)).text(),
    /tests="9" failures="0" errors="0" skipped="0"/,
  )
  for (const value of ['demo@lab.test', 'fixtures-only', 'encryptedValue', 'scriptUsed']) {
    assert.ok(!JSON.stringify(aiReport).includes(value), `AI report must not expose ${value}`)
  }
  const drafts = db
    .prepare('SELECT id, last_run_id FROM intent WHERE project_id = ? AND readiness = ?')
    .all(aiProjectId, 'draft') as Array<{ id: string; last_run_id: string | null }>
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].last_run_id, null)
  assert.ok(aiReport.runs.every((run) => run.test.id !== drafts[0].id))
  const checks = db
    .prepare('SELECT id, purpose FROM run WHERE intent_id = ?')
    .all(drafts[0].id) as Array<{ id: string; purpose: string }>
  assert.ok(checks.length > 0)
  for (const check of checks) {
    assert.equal(check.purpose, 'generation-verification')
    const checkXml = await (await request(`/api/reports/runs/${check.id}?format=junit`)).text()
    assert.match(checkXml, /skipped="1"/)
  }
  console.log(
    `Verified ${aiSuite.id}: nine AI regression passes; missing-feature draft excluded; verification skipped in JUnit; exported reports agree and contain no fixture credentials.`,
  )
}

// A separate session creates its own temporary organization. It never changes the browser's session.
const createdResponse = await request('/api/auth/organization/create', {
  name: 'Report isolation audit',
  slug: `report-isolation-${Date.now()}`,
})
assert.equal(createdResponse.status, 200)
const created = (await createdResponse.json()) as { id: string }
try {
  assert.equal(
    (await request('/api/auth/organization/set-active', { organizationId: created.id })).status,
    200,
  )
  assert.equal((await request(path)).status, 404, 'Cross-organization suite export must be denied')
  assert.equal(
    (await request(`/api/reports/runs/${report.runs[0].id}`)).status,
    404,
    'Cross-organization run export must be denied',
  )
} finally {
  await request('/api/auth/organization/delete', { organizationId: created.id })
  await request('/api/auth/organization/set-active', { organizationId: project.org })
  await request('/api/auth/sign-out', {})
  db.close()
}
console.log(
  `Verified ${suite.id}: 12 regression runs, 7 passed, 2 failed, 3 errors; drafts excluded; JSON/JUnit agree; anonymous and cross-organization exports denied.`,
)
