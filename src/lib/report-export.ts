import type { readRunReport } from '#/server/runs/reports.server.ts'
import { readTranscript } from './transcript.ts'

type Report = Awaited<ReturnType<typeof readRunReport>>

export function exportRun(report: Report) {
  return {
    id: report.run.id,
    status: report.run.status,
    purpose: report.run.purpose,
    trigger: report.run.trigger,
    startedAt: report.run.startedAt,
    finishedAt: report.run.finishedAt,
    errorMessage: report.run.errorMessage,
    environment: {
      id: report.environment.id,
      name: report.environment.name,
      baseUrl: report.environment.baseUrl,
    },
    scriptVersion: report.scriptVersion,
    test: report.intent,
    attempts: report.attempts.map((attempt) => ({
      number: attempt.attemptNumber,
      outcome: attempt.outcome,
      errorMessage: attempt.errorMessage,
      durationMs: attempt.durationMs,
      ...readTranscript(attempt),
      artifactWarnings: attempt.artifactWarnings ?? [],
      artifactKeys: attempt.artifactKeys,
    })),
  }
}

function xml(value: unknown): string {
  return (
    String(value ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(
        /[<>&"']/g,
        (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!,
      )
  )
}

export function junitReport(
  name: string,
  reports: Array<ReturnType<typeof exportRun>>,
  suite?: { status: string; errorMessage: string | null },
) {
  const skipped = (report: (typeof reports)[number]) =>
    report.purpose !== 'regression' || report.status === 'queued' || report.status === 'running'
  const failures = reports.filter((r) => !skipped(r) && r.status === 'failed').length
  let errors = reports.filter((r) => !skipped(r) && r.status === 'error').length
  let skippedCount = reports.filter(skipped).length
  const cases = reports.map((report) => {
    const last = report.attempts.at(-1)
    const duration =
      report.attempts.reduce((sum, attempt) => sum + (attempt.durationMs ?? 0), 0) / 1000
    const message = last?.errorMessage ?? report.errorMessage ?? 'No error details were recorded.'
    const result = skipped(report)
      ? `<skipped message="${xml(`${report.purpose}: ${report.status}`)}"/>`
      : report.status === 'failed'
        ? `<failure message="${xml(message.split('\n')[0])}">${xml(message)}</failure>`
        : report.status === 'error'
          ? `<error message="${xml(message.split('\n')[0])}">${xml(message)}</error>`
          : ''
    return `<testcase name="${xml(report.test.title)}" classname="${xml(report.environment.name)}" time="${duration}"><properties><property name="runId" value="${xml(report.id)}"/><property name="purpose" value="${xml(report.purpose)}"/><property name="status" value="${xml(report.status)}"/><property name="scriptVersionId" value="${xml(report.scriptVersion.id)}"/><property name="environmentId" value="${xml(report.environment.id)}"/></properties>${result}<system-out>${xml(JSON.stringify({ attempts: report.attempts }))}</system-out></testcase>`
  })
  if (suite?.status === 'error' && (suite.errorMessage || errors === 0)) {
    const message = suite.errorMessage ?? 'The suite could not finish.'
    cases.push(
      `<testcase name="Suite execution" classname="${xml(name)}"><error message="${xml(message)}">${xml(message)}</error></testcase>`,
    )
    errors += 1
  } else if (suite?.status === 'queued' || suite?.status === 'running') {
    cases.push(
      `<testcase name="Suite execution" classname="${xml(name)}"><skipped message="Suite ${suite.status}; results are incomplete"/></testcase>`,
    )
    skippedCount += 1
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="${xml(name)}" tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="${skippedCount}">${cases.join('')}</testsuite></testsuites>`
}
