import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('additive migrations preserve history and classify verification from recorded job metadata', () => {
  const db = new Database(':memory:')
  const baseline = readFileSync('migrations/0000_wealthy_wong.sql', 'utf8')
  db.exec(baseline)
  db.exec(`
    INSERT INTO user (id, name, email) VALUES ('u', 'Author', 'author@fixture.test');
    INSERT INTO organization (id, name, slug, created_at) VALUES ('o', 'Org', 'org', 1);
    INSERT INTO project (id, organization_id, name, slug, created_by) VALUES ('p', 'o', 'Project', 'project', 'u');
    INSERT INTO environment (id, project_id, name, base_url, created_by) VALUES ('e', 'p', 'Local', 'http://localhost:4175', 'u');
    INSERT INTO intent (id, project_id, title, description, status, current_version_id, last_run_id, created_by) VALUES ('i', 'p', 'Incomplete', 'Expected behavior', 'passing', 'v', 'verification', 'u');
    INSERT INTO script_version (id, intent_id, version, code, created_by) VALUES ('v', 'i', 1, 'original source', 'u');
    INSERT INTO run (id, intent_id, environment_id, project_id, script_version_id, status, trigger) VALUES ('verification', 'i', 'e', 'p', 'v', 'passed', 'manual'), ('regression', 'i', 'e', 'p', 'v', 'passed', 'manual');
    INSERT INTO generation_job (id, intent_id, project_id, environment_id, organization_id, status, script_version_id, run_id, stuck_reason, created_by) VALUES ('g', 'i', 'p', 'e', 'o', 'failed', 'v', 'verification', 'Incomplete expected behavior', 'u');
  `)
  db.exec(baseline)
  db.exec(readFileSync('migrations/0001_bent_nextwave.sql', 'utf8'))
  db.exec(readFileSync('migrations/0002_tricky_reavers.sql', 'utf8'))
  assert.equal(db.prepare('SELECT count(*) FROM run').pluck().get(), 2)
  assert.equal(db.prepare('SELECT code FROM script_version').pluck().get(), 'original source')
  assert.equal(
    db.prepare("SELECT purpose FROM run WHERE id = 'verification'").pluck().get(),
    'generation-verification',
  )
  assert.equal(
    db.prepare("SELECT purpose FROM run WHERE id = 'regression'").pluck().get(),
    'regression',
  )
  assert.deepEqual(db.prepare('SELECT status, readiness, last_run_id FROM intent').get(), {
    status: 'draft',
    readiness: 'draft',
    last_run_id: null,
  })
  db.close()
})
