import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import { attempt, generationJob, intent, run } from '../src/db/schema/app.ts'
import { recordRunError, recordRunResult } from '../src/engine/run-records.ts'
import type { ExecutedRun, LoadedRun } from '../src/engine/run-steps.ts'
import { createInstrumentation } from '../src/engine/harness/instrument.ts'
import { scrubPatterns, scrubWith } from '../src/engine/runner/scrub.ts'
import { writeArtifacts } from '../src/engine/runner/artifacts.ts'
import { exportRun, junitReport } from '../src/lib/report-export.ts'
import { readJob, readRunReport, readSuiteReport } from '../src/server/reports.server.ts'
import { isRunnableIntent } from '../src/server/test-policy.ts'
import { appendScriptVersion } from '../src/server/script-records.ts'
import { enqueueWork } from '../src/server/enqueue.ts'
import { dispatchSchedules } from '../src/engine/schedule-dispatch.ts'
import { hasSupportedAssertions } from '../src/lib/assertions.ts'
import { testDatabase } from './database.ts'

const execution: ExecutedRun = {
  result: {
    outcome: 'passed',
    steps: [{ label: "page.goto('/')", ok: true, durationMs: 4 }],
    errorMessage: null,
    logs: [],
    durationMs: 5,
  },
  artifactKeys: {},
  artifactWarnings: ['Trace upload unavailable'],
  sessionId: null,
}
function loaded(
  version = 'sv_1',
  purpose: LoadedRun['purpose'] = 'regression',
  startedAt = 1000,
): LoadedRun {
  return {
    intentId: 'int_test',
    projectId: 'prj_test',
    environmentId: 'env_test',
    scriptVersionId: version,
    code: 'source snapshot',
    baseUrl: 'http://localhost:4175',
    prefix: 'runs/org_test/prj_test/run_test/',
    purpose,
    startedAt,
  }
}
async function addRun(db: ReturnType<typeof testDatabase>['db'], id: string, data = loaded()) {
  await db.insert(run).values({
    id,
    intentId: data.intentId,
    projectId: data.projectId,
    environmentId: data.environmentId,
    scriptVersionId: data.scriptVersionId,
    purpose: data.purpose,
    startedAt: new Date(data.startedAt),
    environmentName: 'Local snapshot',
    baseUrl: data.baseUrl,
  })
}

test('draft checks and generation verification cannot promote tests or enter suites', async () => {
  const { db, sqlite } = testDatabase()
  for (const purpose of ['draft-check', 'generation-verification'] as const) {
    await db
      .update(intent)
      .set({ status: 'draft', readiness: 'draft', lastRunId: null })
      .where(eq(intent.id, 'int_test'))
    const data = loaded('sv_1', purpose)
    await addRun(db, purpose, data)
    await recordRunResult(db, purpose, data, execution, 'passed')
    const [test] = await db.select().from(intent)
    assert.equal(test.readiness, 'draft')
    assert.equal(test.status, 'draft')
    assert.equal(test.lastRunId, null)
    assert.equal((await db.select().from(intent).where(isRunnableIntent)).length, 0)
  }
  sqlite.close()
})

test('a failing ready test remains runnable and persists structured evidence', async () => {
  const { db, sqlite } = testDatabase()
  await addRun(db, 'run_test')
  const failed: ExecutedRun = {
    ...execution,
    result: {
      ...execution.result,
      outcome: 'failed',
      errorMessage: 'Expected visible <checkout> & got nothing',
      steps: [
        {
          label: 'expect(checkout).toBeVisible()',
          ok: false,
          durationMs: 1000,
          error: 'Missing checkout',
        },
      ],
    },
  }
  await recordRunResult(db, 'run_test', loaded(), failed, 'failed')
  const [test] = await db.select().from(intent)
  assert.equal(test.status, 'failing')
  assert.equal(test.readiness, 'ready')
  assert.equal((await db.select().from(intent).where(isRunnableIntent)).length, 1)
  const report = await readRunReport(db, 'org_test', 'run_test')
  assert.deepEqual(report.attempts[0].result, failed.result)
  assert.deepEqual(report.attempts[0].artifactWarnings, execution.artifactWarnings)
  const exported = exportRun(report)
  assert.equal(exported.attempts[0].steps[0].label, failed.result.steps[0].label)
  assert.match(junitReport('suite & test', [exported]), /failures="1"/)
  assert.match(junitReport('suite & test', [exported]), /&lt;checkout&gt; &amp;/)
  assert.ok(!JSON.stringify(exported).includes('source snapshot'))
  sqlite.close()
})

test('old-version completion and late older runs never replace a current result', async () => {
  const { db, sqlite } = testDatabase()
  await addRun(db, 'run_old', loaded('sv_1'))
  await db.update(intent).set({ currentVersionId: 'sv_2' }).where(eq(intent.id, 'int_test'))
  await recordRunResult(db, 'run_old', loaded('sv_1'), execution, 'passed')
  assert.equal((await db.select().from(intent))[0].lastRunId, null)
  await addRun(db, 'run_new', loaded('sv_2', 'regression', 3000))
  await addRun(db, 'run_late', loaded('sv_2', 'regression', 2000))
  await recordRunResult(db, 'run_new', loaded('sv_2', 'regression', 3000), execution, 'passed')
  await recordRunResult(
    db,
    'run_late',
    loaded('sv_2', 'regression', 2000),
    { ...execution, result: { ...execution.result, outcome: 'failed' } },
    'failed',
  )
  assert.equal((await db.select().from(intent))[0].lastRunId, 'run_new')
  assert.equal((await db.select().from(intent))[0].status, 'passing')
  sqlite.close()
})

test('workflow persistence retries do not rewrite a verdict or duplicate attempts', async () => {
  const { db, sqlite } = testDatabase()
  await addRun(db, 'run_test')
  await recordRunResult(db, 'run_test', loaded(), execution, 'passed')
  await recordRunResult(
    db,
    'run_test',
    loaded(),
    { ...execution, result: { ...execution.result, outcome: 'failed' } },
    'failed',
  )
  assert.equal((await db.select().from(attempt)).length, 1)
  assert.equal((await db.select().from(run))[0].status, 'passed')
  assert.equal((await recordRunError(db, 'run_test', 'Late workflow failure')).status, 'passed')
  sqlite.close()
})

test('infrastructure errors update the current regression result without fabricating an attempt', async () => {
  const { db, sqlite } = testDatabase()
  await addRun(db, 'run_pass')
  await recordRunResult(db, 'run_pass', loaded(), execution, 'passed')
  await addRun(db, 'run_infra', loaded('sv_1', 'regression', 2000))
  await recordRunError(db, 'run_infra', 'Browser unavailable')
  assert.equal((await db.select().from(intent))[0].lastRunId, 'run_infra')
  const report = await readRunReport(db, 'org_test', 'run_infra')
  assert.equal(report.run.status, 'error')
  assert.equal(report.attempts.length, 0)
  assert.match(junitReport('infra', [exportRun(report)]), /errors="1"/)
  sqlite.close()
})

test('a concurrent late result cannot attach a successful attempt to a settled infrastructure error', async () => {
  const { db, sqlite } = testDatabase()
  await addRun(db, 'run_test')
  await Promise.all([
    recordRunError(db, 'run_test', 'Workflow stopped'),
    recordRunResult(db, 'run_test', loaded(), execution, 'passed'),
  ])
  const report = await readRunReport(db, 'org_test', 'run_test')
  assert.equal(report.run.status, 'error')
  assert.equal(report.attempts.length, 0)
  sqlite.close()
})

test('report readers deny another organization and retain execution environment snapshots', async () => {
  const { db, sqlite } = testDatabase()
  await addRun(db, 'run_test')
  await recordRunResult(db, 'run_test', loaded(), execution, 'passed')
  sqlite.exec("UPDATE environment SET name = 'Renamed', base_url = 'https://changed.invalid'")
  const report = await readRunReport(db, 'org_test', 'run_test')
  assert.equal(report.environment.name, 'Local snapshot')
  assert.equal(report.environment.baseUrl, 'http://localhost:4175')
  await assert.rejects(readRunReport(db, 'org_other', 'run_test'), /not found/)
  sqlite.exec(
    "INSERT INTO suite_run (id, project_id, environment_id) VALUES ('srun_test', 'prj_test', 'env_test')",
  )
  await assert.rejects(readSuiteReport(db, 'org_other', 'srun_test'), /not found/)
  sqlite.close()
})

test('JUnit does not turn successful draft checks into CI passes', async () => {
  const { db, sqlite } = testDatabase()
  await addRun(db, 'run_draft', loaded('sv_1', 'draft-check'))
  await recordRunResult(db, 'run_draft', loaded('sv_1', 'draft-check'), execution, 'passed')
  const xml = junitReport('drafts', [exportRun(await readRunReport(db, 'org_test', 'run_draft'))])
  assert.match(xml, /skipped="1"/)
  assert.match(xml, /<skipped message="draft-check: passed"/)
  sqlite.close()
})

test('historical job queries keep terminal state without an event channel and enforce organization scope', async () => {
  const { db, sqlite } = testDatabase()
  for (const kind of ['generate', 'explore', 'batch'] as const) {
    await db.insert(generationJob).values({
      id: `job_${kind}`,
      kind,
      intentId: kind === 'generate' ? 'int_test' : null,
      projectId: 'prj_test',
      environmentId: 'env_test',
      organizationId: 'org_test',
      status: 'succeeded',
      createdBy: 'usr_test',
      finishedAt: new Date(1000),
    })
    assert.equal((await readJob(db, 'org_test', `job_${kind}`))?.status, 'succeeded')
    assert.equal(await readJob(db, 'org_other', `job_${kind}`), null)
  }
  assert.equal(await readJob(db, 'org_test', 'job_missing'), null)
  sqlite.close()
})

test('artifact upload failures keep the test outcome and omit missing keys', async () => {
  const bucket = {
    put: async (key: string) => {
      if (key.endsWith('.zip')) throw new Error('Storage unavailable')
    },
  }
  const result = await writeArtifacts(bucket as unknown as R2Bucket, 'runs/org/project/run/', {
    screenshot: null,
    trace: new ArrayBuffer(4),
    result: execution.result,
  })
  assert.equal(result.keys.trace, undefined)
  assert.ok(result.keys.logs)
  assert.deepEqual(result.failures, ['trace.zip: Storage unavailable'])
  assert.equal(execution.result.outcome, 'passed')
})

test('JUnit exposes suite startup failures and unfinished suites without member runs', () => {
  const failed = junitReport('unavailable workflow', [], {
    status: 'error',
    errorMessage: 'Could not enqueue <suite>',
  })
  assert.match(failed, /tests="1" failures="0" errors="1" skipped="0"/)
  assert.match(failed, /Could not enqueue &lt;suite&gt;/)
  const pending = junitReport('pending workflow', [], { status: 'queued', errorMessage: null })
  assert.match(pending, /tests="1" failures="0" errors="0" skipped="1"/)
})

test('concurrent instrumented steps retain start order and redact labels', async () => {
  const instrumentation = createInstrumentation({
    redact: (text) => text.replaceAll('private', '***'),
  })
  let release!: () => void
  const target = instrumentation.watch(
    {
      slow: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      fast: async (_value: string) => {},
    },
    'page',
  )
  const first = target.slow()
  await target.fast('private')
  release()
  await first
  assert.match(instrumentation.steps[0].label, /slow/)
  assert.match(instrumentation.steps[1].label, /\*\*\*/)
})

test('a secret longer than the argument limit is redacted before it is truncated', async () => {
  // A 107-character JWT: longer than MAX_ARG_LENGTH, so clipping it first would leave
  // the scrubber nothing to match and write the surviving prefix into the step label.
  const token =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const patterns = scrubPatterns([token])
  const instrumentation = createInstrumentation({
    redact: (text) => scrubWith(text, patterns),
  })
  const target = instrumentation.watch({ fill: async (_value: string) => {} }, 'page')

  await target.fill(token)

  const [step] = instrumentation.steps
  assert.equal(step.label, "page.fill('***')")
  assert.ok(!step.label.includes(token.slice(0, 20)), 'no prefix of the token may survive')
})

test('saving and restoring preserve immutable history and reset version readiness', async () => {
  const { db, sqlite } = testDatabase()
  await addRun(db, 'run_test')
  await recordRunResult(db, 'run_test', loaded(), execution, 'passed')
  const saved = await appendScriptVersion(db, {
    intentId: 'int_test',
    status: 'passing',
    code: 'unfinished code',
    author: 'user',
    note: 'Work in progress',
    createdBy: 'usr_test',
  })
  const [test] = await db.select().from(intent)
  assert.equal(test.currentVersionId, saved.id)
  assert.equal(test.status, 'draft')
  assert.equal(test.readiness, 'draft')
  assert.equal(test.lastRunId, null)
  assert.equal((await readRunReport(db, 'org_test', 'run_test')).scriptVersion.id, 'sv_1')
  const restored = await appendScriptVersion(db, {
    intentId: 'int_test',
    status: 'draft',
    code: 'version one',
    author: 'user',
    note: 'Restored v1',
    createdBy: 'usr_test',
  })
  assert.equal(restored.version, saved.version + 1)
  assert.equal(
    sqlite.prepare("SELECT code FROM script_version WHERE id = 'sv_1'").pluck().get(),
    'version one',
  )
  assert.equal(sqlite.prepare('SELECT count(*) FROM script_version').pluck().get(), 4)
  sqlite.close()
})

test('failed enqueue settles its record, while a lost response recovers the same workflow', async () => {
  let failures = 0
  const reject = async () => {
    throw new Error('Workflow unavailable')
  }
  await assert.rejects(
    enqueueWork(reject, reject, async () => {
      failures++
    }),
    /could not be started/,
  )
  assert.equal(failures, 1)
  await enqueueWork(
    reject,
    async () => ({ status: 'running' }),
    async () => {
      failures++
    },
  )
  assert.equal(failures, 1, 'An existing workflow must not be marked failed')
})

test('scheduled drafts are excluded; ready schedules enqueue once with an environment snapshot', async () => {
  const { db, sqlite, client } = testDatabase()
  const started: unknown[] = []
  const env = {
    DB: client,
    SUITE_WORKFLOW: {
      create: async (input: unknown) => {
        started.push(input)
      },
    },
  } as unknown as Cloudflare.Env
  await db
    .update(intent)
    .set({ schedule: '* * * * *', readiness: 'draft', status: 'draft' })
    .where(eq(intent.id, 'int_test'))
  const tick = new Date('2026-08-31T06:00:00Z')
  assert.equal((await dispatchSchedules(env, tick)).suitesCreated, 0)
  await db
    .update(intent)
    .set({ readiness: 'ready', status: 'ready' })
    .where(eq(intent.id, 'int_test'))
  assert.equal((await dispatchSchedules(env, tick)).suitesCreated, 1)
  assert.equal((await dispatchSchedules(env, tick)).suitesCreated, 0)
  assert.equal(started.length, 1)
  const suite = sqlite.prepare('SELECT base_url, environment_name FROM suite_run').get() as {
    base_url: string
    environment_name: string
  }
  assert.equal(suite.base_url, 'http://localhost:4175')
  assert.equal(suite.environment_name, 'Local')
  sqlite.close()
})

test('assertion hints ignore examples in comments and strings', () => {
  assert.equal(
    hasSupportedAssertions("// await expect(page).toHaveTitle('Example')\nawait page.goto('/')"),
    false,
  )
  assert.equal(hasSupportedAssertions('console.log("expect(page).toHaveTitle(whatever)")'), false)
  assert.equal(
    hasSupportedAssertions("await expect(page.getByRole('button', {name: 'Save'})).toBeVisible()"),
    true,
  )
  assert.equal(hasSupportedAssertions("await expect(page).not.toHaveTitle('Missing')"), true)
})
