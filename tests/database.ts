import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { createDb } from '../src/db/index.ts'

export function testDatabase() {
  const sqlite = new Database(':memory:')
  for (const file of readdirSync('migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'))
  }
  class Statement {
    constructor(
      readonly query: string,
      readonly params: unknown[] = [],
    ) {}
    bind(...params: unknown[]) {
      return new Statement(this.query, params)
    }
    execute() {
      const statement = sqlite.prepare(this.query)
      if (statement.reader)
        return { results: statement.all(...this.params), success: true, meta: {} }
      const result = statement.run(...this.params)
      return { results: [], success: true, meta: { changes: result.changes } }
    }
    async all() {
      return this.execute()
    }
    async run() {
      return this.execute()
    }
    async raw() {
      return sqlite
        .prepare(this.query)
        .raw()
        .all(...this.params)
    }
  }
  const client = {
    prepare: (query: string) => new Statement(query),
    batch: async (statements: Statement[]) =>
      sqlite.transaction(() => statements.map((statement) => statement.execute()))(),
  }
  const db = createDb(client as unknown as D1Database)
  sqlite.exec(`
    INSERT INTO user (id, name, email) VALUES ('usr_test', 'Test author', 'author@fixtures.test');
    INSERT INTO organization (id, name, slug, created_at) VALUES ('org_test', 'Test org', 'test-org', 1), ('org_other', 'Other org', 'other-org', 1);
    INSERT INTO project (id, organization_id, name, slug, created_by) VALUES ('prj_test', 'org_test', 'Fixture project', 'fixtures', 'usr_test');
    INSERT INTO environment (id, project_id, name, base_url, is_default, created_by) VALUES ('env_test', 'prj_test', 'Local', 'http://localhost:4175', 1, 'usr_test');
    INSERT INTO intent (id, project_id, title, description, status, readiness, current_version_id, created_by) VALUES ('int_test', 'prj_test', 'Expected <behavior>', 'Expected behavior', 'ready', 'ready', 'sv_1', 'usr_test');
    INSERT INTO script_version (id, intent_id, version, code, created_by) VALUES ('sv_1', 'int_test', 1, 'version one', 'usr_test'), ('sv_2', 'int_test', 2, 'version two', 'usr_test');
  `)
  return { db, sqlite, client: client as unknown as D1Database }
}
