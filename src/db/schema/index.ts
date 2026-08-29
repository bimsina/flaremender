import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export * from './auth.ts'

export const todos = sqliteTable('todos', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  title: text().notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
})
