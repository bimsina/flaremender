import { and, eq, isNotNull, notInArray } from 'drizzle-orm'
import { intent, UNADOPTED_INTENT_STATUSES } from '#/db/schema/app.ts'

export const isAdoptedIntent = notInArray(intent.status, [...UNADOPTED_INTENT_STATUSES])
export const isRunnableIntent = and(
  isAdoptedIntent,
  eq(intent.readiness, 'ready'),
  isNotNull(intent.currentVersionId),
)
