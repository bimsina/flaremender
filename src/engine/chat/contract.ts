/**
 * The wire between the three halves of a chat: the `ProjectChat` Durable Object
 * that runs the turn, the D1 rows that outlive it, and the browser that watches.
 *
 * Two decisions shape everything here.
 *
 * **A message is a list of typed parts, not a blob of prose.** The assistant's
 * job is to *act* — create an intent, launch a generation, store a credential —
 * and the interesting product of an action is the object it produced, not the
 * sentence describing it. So a message alternates short text with **cards**,
 * each of which is a reference to a real row: an intent id, a run id, a
 * generation job id. The card carries a snapshot of what to print (a title, a
 * status) so a three-day-old transcript renders without a query per card, and it
 * carries the id so a live card can subscribe to the same channels the rest of
 * the app already uses.
 *
 * **Nothing exists only in the conversation.** Every card names a row that the
 * ordinary UI can open, and every action behind one went through the same
 * org-scoped code path the buttons use.
 *
 * Everything in this file is structured-clone friendly and stored as JSON, so
 * no classes, no functions, no `Date`s.
 */
import type { IntentStatus, RunStatus, SuiteRunStatus } from '#/db/schema/app.ts'

export const CHAT_ROLES = ['user', 'assistant'] as const
export type ChatRole = (typeof CHAT_ROLES)[number]

/**
 * `'streaming'` is only ever written by the Durable Object mid-turn, and only
 * survives a crash: a message that finishes normally is inserted `'complete'`.
 */
export const CHAT_MESSAGE_STATUSES = ['complete', 'streaming', 'error'] as const
export type ChatMessageStatus = (typeof CHAT_MESSAGE_STATUSES)[number]

/** An intent the turn created, changed, or was asked about. */
export interface IntentCard {
  kind: 'intent'
  intentId: string
  title: string
  status: IntentStatus
  /** Five-field UTC cron, when the intent runs on a clock. */
  schedule: string | null
}

/**
 * A generation job. `jobId` is also the id of the `RunChannel` the job streams
 * through, which is what lets the card show the script being written live.
 */
export interface GenerationCard {
  kind: 'generation'
  jobId: string
  intentId: string
  intentTitle: string
  environmentName: string
}

/** One run. Live through its own `RunChannel`, exactly like the intent page. */
export interface RunCard {
  kind: 'run'
  runId: string
  intentId: string
  intentTitle: string
  environmentName: string
  /** What it was when the card was made; the live card polls for the rest. */
  status: RunStatus
}

/** A "run all". Not a run: a suite has counts and members, and no channel. */
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
  /** Variable names only. A value has never been in this type. */
  variableNames: Array<string>
}

/**
 * Reserved for M9c: a proposed test plan, rendered as a reviewable checklist
 * with a "generate all" action. Declared now so a transcript written today
 * still parses when the explorer starts producing them.
 */
export interface PlanCard {
  kind: 'plan'
  planId: string
  title: string
  items: Array<{ intentId: string | null; title: string; description: string }>
}

export type ChatCard =
  | IntentCard
  | GenerationCard
  | RunCard
  | SuiteCard
  | EnvironmentCard
  | PlanCard

export type ChatPart = { type: 'text'; text: string } | { type: 'card'; card: ChatCard }

/** One persisted message, as both the socket and the history query hand it over. */
export interface ChatMessageWire {
  id: string
  role: ChatRole
  parts: Array<ChatPart>
  status: ChatMessageStatus
  /** Null for the assistant. */
  createdBy: string | null
  /** Who to attribute it to in the UI; null for the assistant. */
  createdByName: string | null
  /** Epoch milliseconds — this crosses a Durable Object RPC boundary. */
  createdAt: number
}

/**
 * What the Durable Object says while a turn is happening.
 *
 * The shape mirrors `RunEvent` on purpose: one envelope type, one sequence
 * number, one replay rule. The differences are all about what a chat *is* —
 * text arrives in fragments, tools announce themselves before they act, and a
 * message is only durable once it is whole.
 *
 * There is deliberately **no event for the user's own message**. It is the one
 * string in the system that can contain a credential the redactor has not been
 * told about yet — that is the entire premise of credential lifting — so
 * broadcasting it on arrival would hand the raw value to every other viewer in
 * the fraction of a second before `set_environment_variable` runs. The sender
 * renders their own message from what they typed, everyone else sees it when the
 * turn ends and the history is re-read, by which point it is redacted in D1.
 */
export type ChatEvent =
  /** The assistant is about to speak; `messageId` is the row it will become. */
  | { type: 'message.started'; messageId: string; at: number }
  | { type: 'text.delta'; messageId: string; text: string; at: number }
  /** A summary written by us, never the model's raw arguments. */
  | { type: 'tool.started'; messageId: string; toolCallId: string; name: string; summary: string }
  | {
      type: 'tool.finished'
      messageId: string
      toolCallId: string
      name: string
      ok: boolean
      /** One line about what happened. Absent when the cards say it. */
      detail: string | null
      /** Usually one; a listing tool produces several, an action tool none. */
      cards: Array<ChatCard>
    }
  | { type: 'message.finished'; message: ChatMessageWire; at: number }
  /**
   * A message already on screen has been rewritten — the only cause today is a
   * credential being lifted into an environment variable, which redacts the
   * message that carried it.
   */
  | { type: 'message.redacted'; messageId: string; parts: Array<ChatPart>; at: number }
  /** A second send arrived while a turn was running. Nothing was stored. */
  | { type: 'busy'; at: number }
  | { type: 'error'; messageId: string | null; message: string; at: number }

/**
 * The sequence number is assigned by the Durable Object and is what makes a
 * replay and a live broadcast indistinguishable to the client: it drops
 * anything it has already seen.
 */
export interface ChatEventEnvelope {
  seq: number
  event: ChatEvent
}

/** What `sendChatMessage` hands the Durable Object. */
export interface ChatTurnRequest {
  projectId: string
  organizationId: string
  userId: string
  userName: string
  text: string
}

export interface ChatTurnAck {
  accepted: boolean
  /** The user message's id, when it was accepted. */
  messageId: string | null
  /** When it was stored, so the sender's own copy sorts where D1 will put it. */
  createdAt: number | null
  /** Why not, in the words the composer shows. */
  reason: string | null
}
