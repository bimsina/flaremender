import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'
import fs from 'node:fs'
import path from 'node:path'

config({ path: ['.env.local', '.env'] })

const remote = process.env.DRIZZLE_D1_REMOTE === '1' || process.env.DRIZZLE_D1_REMOTE === 'true'

function findLocalD1Sqlite(): string {
  const dir = path.join('.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject')
  if (!fs.existsSync(dir)) {
    throw new Error(
      'Local D1 SQLite not found. Run `pnpm db:migrate` or `pnpm dev` once to create it.',
    )
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
    .map((f) => {
      const full = path.join(dir, f)
      return { full, mtime: fs.statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)

  const latest = files[0]
  if (!latest) {
    throw new Error('No local D1 database file found under .wrangler')
  }

  return latest.full
}

/**
 * Remote credentials come from the environment only. `wrangler.jsonc` carries no
 * account id, and its `database_id` is a placeholder the deploy flow rewrites, so
 * neither is a trustworthy source for drizzle-kit.
 */
function remoteCredentials(): { accountId: string; databaseId: string; token: string } {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const databaseId = process.env.CLOUDFLARE_DATABASE_ID
  const token = process.env.CLOUDFLARE_D1_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN

  if (!accountId || !databaseId || !token) {
    throw new Error(
      'Remote drizzle-kit needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID and CLOUDFLARE_D1_TOKEN (or CLOUDFLARE_API_TOKEN). Find the ids with `wrangler d1 info flaremender`.',
    )
  }

  return { accountId, databaseId, token }
}

export default defineConfig({
  out: './migrations',
  schema: './src/db/schema/index.ts',
  dialect: 'sqlite',
  tablesFilter: ['!_cf_*', '!d1_migrations'],
  ...(remote
    ? {
        driver: 'd1-http' as const,
        dbCredentials: remoteCredentials(),
      }
    : {
        dbCredentials: {
          url: findLocalD1Sqlite(),
        },
      }),
})
