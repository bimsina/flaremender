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

function loadWranglerIds(): { accountId: string; databaseId: string } {
  const raw = fs.readFileSync('wrangler.jsonc', 'utf8')
  const json = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const parsed = JSON.parse(json) as {
    account_id: string
    d1_databases: Array<{ database_id: string }>
  }
  const databaseId = parsed.d1_databases[0]?.database_id
  if (!parsed.account_id || !databaseId) {
    throw new Error('account_id / d1 database_id missing from wrangler.jsonc')
  }
  return { accountId: parsed.account_id, databaseId }
}

const wranglerIds = remote ? loadWranglerIds() : null

export default defineConfig({
  out: './migrations',
  schema: './src/db/schema/index.ts',
  dialect: 'sqlite',
  tablesFilter: ['!_cf_*', '!d1_migrations'],
  ...(remote
    ? {
        driver: 'd1-http' as const,
        dbCredentials: {
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? wranglerIds!.accountId,
          databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? wranglerIds!.databaseId,
          token: process.env.CLOUDFLARE_D1_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN!,
        },
      }
    : {
        dbCredentials: {
          url: findLocalD1Sqlite(),
        },
      }),
})
