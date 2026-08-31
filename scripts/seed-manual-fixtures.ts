import Database from 'better-sqlite3'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { manualScenarios, scenarioScript } from './manual-scenarios.ts'

const directory = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'
let database: Database.Database | undefined
for (const file of readdirSync(directory).filter(
  (name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite',
)) {
  const candidate = new Database(join(directory, file))
  if (candidate.prepare("SELECT name FROM sqlite_master WHERE name = 'intent'").get()) {
    database = candidate
    break
  }
  candidate.close()
}
if (!database) throw new Error('Start Flaremender locally and apply local migrations first.')
const db = database
const author = db
  .prepare(
    `SELECT u.id, m.organization_id AS organizationId FROM user u JOIN member m ON m.user_id = u.id WHERE u.email = ? LIMIT 1`,
  )
  .get(process.argv[2] ?? 'admin@flaremender.test') as
  | { id: string; organizationId: string }
  | undefined
if (!author) throw new Error('The local fixture author must belong to an organization.')
db.transaction(() => {
  db.prepare(
    `INSERT OR IGNORE INTO project (id, organization_id, name, slug, description, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'prj_manual_lab',
    author.organizationId,
    'Manual reliability lab',
    'manual-reliability-lab',
    'Controlled local scenarios, including intentional failures. No AI credentials required.',
    author.id,
  )
  db.prepare(
    `INSERT OR IGNORE INTO environment (id, project_id, name, base_url, is_default, created_by) VALUES (?, ?, ?, ?, 1, ?)`,
  ).run('env_manual_lab', 'prj_manual_lab', 'Local lab', 'http://127.0.0.1:4175', author.id)
  for (const scenario of manualScenarios) {
    const id = `int_lab_${scenario.id}`
    const readiness = 'draft' in scenario && scenario.draft ? 'draft' : 'ready'
    db.prepare(
      `INSERT OR IGNORE INTO intent (id, project_id, title, description, status, readiness, current_version_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      'prj_manual_lab',
      scenario.title,
      `${scenario.title}. This controlled fixture should finish with outcome: ${scenario.expected}.`,
      readiness,
      readiness,
      `sv_lab_${scenario.id}`,
      author.id,
    )
    db.prepare(
      `INSERT OR IGNORE INTO script_version (id, intent_id, version, code, author, note, created_by) VALUES (?, ?, 1, ?, 'user', 'Repeatable local reliability fixture', ?)`,
    ).run(`sv_lab_${scenario.id}`, id, scenarioScript(scenario.code), author.id)
  }
})()
console.log(
  `Local fixture project ready: http://localhost:3000/projects/prj_manual_lab (${manualScenarios.length} scenarios; re-running preserves edits and history).`,
)
db.close()
