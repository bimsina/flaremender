import { createFileRoute } from '@tanstack/react-router'
import { exportRun, junitReport } from '#/lib/report-export.ts'
import { AuthError, getDb, readSession } from '#/server/auth/auth.ts'
import { readRunReport, readSuiteReport } from '#/server/runs/reports.server.ts'

export const Route = createFileRoute('/api/reports/$kind/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await readSession()
        if (!session?.user) return new Response('Unauthorized', { status: 401 })
        const organizationId = session.session.activeOrganizationId
        if (!organizationId) return new Response('Not found', { status: 404 })
        const format = new URL(request.url).searchParams.get('format') ?? 'json'
        if (!['json', 'junit'].includes(format))
          return new Response('Use json or junit.', { status: 400 })
        if (params.kind !== 'runs' && params.kind !== 'suites')
          return new Response('Not found', { status: 404 })
        try {
          const db = getDb()
          const suite =
            params.kind === 'suites' ? await readSuiteReport(db, organizationId, params.id) : null
          const reports = suite ? suite.runs : [await readRunReport(db, organizationId, params.id)]
          const runs = reports.map(exportRun)
          const payload = suite
            ? { schemaVersion: 1, suite: suite.suiteRun, runs }
            : { schemaVersion: 1, run: runs[0] }
          return new Response(
            format === 'junit'
              ? junitReport(params.id, runs, suite?.suiteRun)
              : JSON.stringify(payload, null, 2),
            {
              headers: {
                'Content-Type':
                  format === 'junit'
                    ? 'application/xml; charset=utf-8'
                    : 'application/json; charset=utf-8',
                'Content-Disposition': `attachment; filename="${params.kind}-${params.id.replace(/[^a-zA-Z0-9_-]/g, '')}.${format === 'junit' ? 'xml' : 'json'}"`,
                'Cache-Control': 'private, no-store',
                'X-Content-Type-Options': 'nosniff',
              },
            },
          )
        } catch (error) {
          if (error instanceof AuthError) return new Response('Not found', { status: 404 })
          console.error('Report export failed', error)
          return new Response('The report could not be exported.', { status: 500 })
        }
      },
    },
  },
})
