import type { IntentStatus, RunStatus, SuiteRunStatus } from '#/db/schema/app.ts'

export const CHAT_ROLES = ['user', 'assistant'] as const
export type ChatRole = (typeof CHAT_ROLES)[number]

export const CHAT_MESSAGE_STATUSES = ['complete', 'streaming', 'error'] as const
export type ChatMessageStatus = (typeof CHAT_MESSAGE_STATUSES)[number]

export interface IntentCard {
  kind: 'intent'
  intentId: string
  title: string
  status: IntentStatus
  schedule: string | null
}

export interface GenerationCard {
  kind: 'generation'
  jobId: string
  intentId: string
  intentTitle: string
  environmentName: string
}

export interface RunCard {
  kind: 'run'
  runId: string
  intentId: string
  intentTitle: string
  environmentName: string
  status: RunStatus
}

export interface SuiteCard {
  kind: 'suite'
  suiteRunId: string
  environmentName: string
  status: SuiteRunStatus
}

export interface EnvironmentCard {
  kind: 'environment'
  environmentId: string
  name: string
  baseUrl: string
  isDefault: boolean
  variableNames: Array<string>
}

export interface ExploreCard {
  kind: 'explore'
  jobId: string
  environmentName: string
  focus: string | null
}

export interface PlanCard {
  kind: 'plan'
  planId: string
  title: string
  items: Array<{ intentId: string | null; title: string; description: string }>
}

export interface BatchCard {
  kind: 'batch'
  jobId: string
  environmentName: string
  intentIds: Array<string>
}

export type ChatCard =
  | IntentCard
  | GenerationCard
  | RunCard
  | SuiteCard
  | EnvironmentCard
  | ExploreCard
  | PlanCard
  | BatchCard

export type ChatPart = { type: 'text'; text: string } | { type: 'card'; card: ChatCard }

export interface ChatMessageWire {
  id: string
  role: ChatRole
  parts: Array<ChatPart>
  status: ChatMessageStatus
  createdBy: string | null
  createdByName: string | null
  createdAt: number
}

export type ChatEvent =
  | { type: 'message.started'; messageId: string; at: number }
  | { type: 'text.delta'; messageId: string; text: string; at: number }
  | { type: 'tool.started'; messageId: string; toolCallId: string; name: string; summary: string }
  | {
      type: 'tool.finished'
      messageId: string
      toolCallId: string
      name: string
      ok: boolean
      detail: string | null
      cards: Array<ChatCard>
    }
  | { type: 'message.finished'; message: ChatMessageWire; at: number }
  | { type: 'message.redacted'; messageId: string; parts: Array<ChatPart>; at: number }
  | { type: 'busy'; at: number }
  | { type: 'error'; messageId: string | null; message: string; at: number }

export interface ChatEventEnvelope {
  seq: number
  event: ChatEvent
}

export interface ChatTurnRequest {
  projectId: string
  organizationId: string
  userId: string
  userName: string
  text: string
}

export interface ChatAnnouncement {
  projectId: string
  organizationId: string
  parts: Array<ChatPart>
}

export interface ChatTurnAck {
  accepted: boolean
  messageId: string | null
  createdAt: number | null
  reason: string | null
}
