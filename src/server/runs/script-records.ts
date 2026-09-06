import { desc, eq } from 'drizzle-orm'
import type { Db } from '#/db/index.ts'
import { intent, scriptVersion } from '#/db/schema/app.ts'
import type { IntentStatus, ScriptAuthor } from '#/db/schema/app.ts'
import { createId } from '#/lib/ids.ts'

export async function appendScriptVersion(
  db: Db,
  input: {
    intentId: string
    status: IntentStatus
    code: string
    author: ScriptAuthor
    note: string | null
    createdBy: string
  },
) {
  const [last] = await db
    .select({ version: scriptVersion.version })
    .from(scriptVersion)
    .where(eq(scriptVersion.intentId, input.intentId))
    .orderBy(desc(scriptVersion.version))
    .limit(1)

  const row = {
    id: createId('sv'),
    intentId: input.intentId,
    version: (last?.version ?? 0) + 1,
    code: input.code,
    author: input.author,
    createdBy: input.createdBy,
    note: input.note,
  }

  await db.batch([
    db.insert(scriptVersion).values(row),
    db
      .update(intent)
      .set({
        currentVersionId: row.id,
        status: 'draft',
        readiness: 'draft',
        lastRunId: null,
      })
      .where(eq(intent.id, input.intentId)),
  ])

  return { id: row.id, version: row.version }
}
