export type RunOutcome = 'passed' | 'failed' | 'error'

export interface RunStep {
  label: string
  ok: boolean
  durationMs: number
  error?: string
}

export interface RunResult {
  outcome: RunOutcome
  steps: Array<RunStep>
  errorMessage: string | null
  logs: Array<string>
  durationMs: number
}

export type RunErrorKind = 'browser' | 'script' | 'harness'

export interface HarnessResponse {
  artifactWarnings?: Array<string>
  result: RunResult
  errorKind: RunErrorKind | null
  screenshot: ArrayBuffer | null
  trace: ArrayBuffer | null
  sessionId: string | null
  sessionReused: boolean
}

export interface HarnessRequest {
  timeoutMs: number
  actionTimeoutMs: number
  trace: boolean
  sessionId?: string | null
  keepSessionAlive?: boolean
}

export interface PageObservation {
  url: string
  title: string
  snapshot: string
  truncated: boolean
}

export interface AttachRequest {
  sessionId: string
  actionTimeoutMs: number
  timeoutMs: number
  snapshotLimit: number
  stepIndexOffset?: number
}

export interface SessionStartRequest {
  actionTimeoutMs: number
  snapshotLimit: number
}

export interface SessionStartResponse {
  sessionId: string | null
  observation: PageObservation | null
  errorMessage: string | null
}

export interface ObserveResponse {
  observation: PageObservation | null
  errorMessage: string | null
  sessionLost: boolean
}

export interface ActResponse {
  ok: boolean
  steps: Array<RunStep>
  logs: Array<string>
  errorMessage: string | null
  observation: PageObservation | null
  durationMs: number
  sessionLost: boolean
}

export type RunEvent =
  | { type: 'run.started'; runId: string; at: number }
  | { type: 'step.started'; runId: string; index: number; label: string; at: number }
  | { type: 'step.finished'; runId: string; index: number; step: RunStep; at: number }
  | { type: 'log'; runId: string; line: string; at: number }
  | {
      type: 'run.finished'
      runId: string
      outcome: RunOutcome
      errorMessage: string | null
      at: number
    }

export interface RunEventEnvelope {
  seq: number
  event: RunEvent
}

export interface RunChannelSink {
  push(event: RunEvent): Promise<void>
}
