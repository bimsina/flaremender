/**
 * What Flaremender tells the outside world about, and the shape it says it in. The
 * same event object feeds a signed JSON webhook, a Slack or Discord message and an
 * email, so anything added here reaches every channel.
 */
export const NOTIFICATION_EVENTS = [
  'run.passed',
  'run.failed',
  'run.error',
  'suite.passed',
  'suite.failed',
  'repair.pending',
  'repair.adopted',
  'repair.failed',
] as const
export type NotificationEventType = (typeof NOTIFICATION_EVENTS)[number]

export const NOTIFICATION_EVENT_LABEL: Record<NotificationEventType, string> = {
  'run.passed': 'A test run passed',
  'run.failed': 'A test run failed',
  'run.error': 'A test run could not finish',
  'suite.passed': 'A suite passed',
  'suite.failed': 'A suite failed',
  'repair.pending': 'A repair is waiting for review',
  'repair.adopted': 'A repair was adopted automatically',
  'repair.failed': 'A repair could not fix the test',
}

/** What a new destination listens to until someone changes it. */
export const DEFAULT_NOTIFICATION_EVENTS: Array<NotificationEventType> = [
  'run.failed',
  'run.error',
  'suite.failed',
  'repair.pending',
  'repair.adopted',
]

export interface EventProject {
  id: string
  name: string
}

export interface EventEnvironment {
  id: string
  name: string
  baseUrl: string | null
}

export interface EventRun {
  id: string
  status: string
  trigger: string
  test: { id: string; title: string }
  environment: EventEnvironment
  errorMessage: string | null
  durationMs: number | null
  startedAt: string
  finishedAt: string | null
  url: string
  reportUrl: string
}

export interface EventSuite {
  id: string
  status: string
  trigger: string
  environment: EventEnvironment
  counts: { total: number; passed: number; failed: number; error: number }
  failures: Array<{
    id: string
    status: string
    test: { id: string; title: string }
    errorMessage: string | null
    url: string
  }>
  startedAt: string
  finishedAt: string | null
  url: string
  reportUrl: string
}

export interface EventRepair {
  jobId: string
  status: 'succeeded' | 'failed'
  adopted: boolean
  test: { id: string; title: string }
  environment: EventEnvironment
  version: number | null
  whatFailed: string | null
  reason: string | null
  sourceRun: { id: string; url: string } | null
  url: string
}

export type NotificationEvent =
  | { type: 'run.passed' | 'run.failed' | 'run.error'; project: EventProject; run: EventRun }
  | { type: 'suite.passed' | 'suite.failed'; project: EventProject; suite: EventSuite }
  | {
      type: 'repair.pending' | 'repair.adopted' | 'repair.failed'
      project: EventProject
      repair: EventRepair
    }

export function isNotificationEvent(value: string): value is NotificationEventType {
  return (NOTIFICATION_EVENTS as ReadonlyArray<string>).includes(value)
}
