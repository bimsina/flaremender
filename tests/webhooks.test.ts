import assert from 'node:assert/strict'
import { test } from 'node:test'

import { WEBHOOK_API_KEY_CONFIG, createAuth } from '../src/lib/auth/auth.ts'
import { testDatabase } from './database.ts'

function authEnv(): Cloudflare.Env {
  return {
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters',
    BETTER_AUTH_URL: 'http://localhost:3009',
  } as Cloudflare.Env
}

test('Better Auth hashes project webhook API keys and enforces their lifecycle', async () => {
  const { client, sqlite } = testDatabase()
  const auth = createAuth(client, authEnv())

  const created = await auth.api.createApiKey({
    body: {
      configId: WEBHOOK_API_KEY_CONFIG,
      name: 'CI',
      expiresIn: 90 * 24 * 60 * 60,
      organizationId: 'org_test',
      userId: 'usr_test',
      metadata: { projectId: 'prj_test', createdByName: 'Test author' },
      permissions: { webhook: ['trigger', 'read'] },
      rateLimitEnabled: false,
    },
  })

  assert.match(created.key, /^flm_pk_/)
  const stored = sqlite
    .prepare('SELECT key, reference_id, metadata, enabled FROM apikey WHERE id = ?')
    .get(created.id) as {
    key: string
    reference_id: string
    metadata: string
    enabled: number
  }
  assert.notEqual(stored.key, created.key)
  assert.equal(stored.reference_id, 'org_test')
  assert.equal(JSON.parse(stored.metadata).projectId, 'prj_test')
  assert.equal(stored.enabled, 1)

  const verified = await auth.api.verifyApiKey({
    body: {
      configId: WEBHOOK_API_KEY_CONFIG,
      key: created.key,
      permissions: { webhook: ['trigger'] },
    },
  })
  assert.equal(verified.valid, true)
  assert.equal(verified.key?.referenceId, 'org_test')

  sqlite.prepare('UPDATE apikey SET enabled = 0 WHERE id = ?').run(created.id)
  const revoked = await auth.api.verifyApiKey({
    body: {
      configId: WEBHOOK_API_KEY_CONFIG,
      key: created.key,
      permissions: { webhook: ['read'] },
    },
  })
  assert.equal(revoked.valid, false)
  assert.equal(revoked.error?.code, 'KEY_DISABLED')
  sqlite.close()
})

test('webhook migration adds idempotency and attribution without exposing API keys', () => {
  const { sqlite } = testDatabase()
  const apiKeyColumns = sqlite.prepare('PRAGMA table_info(apikey)').all() as Array<{ name: string }>
  const requestColumns = sqlite.prepare('PRAGMA table_info(api_execution_request)').all() as Array<{
    name: string
  }>
  const runColumns = sqlite.prepare('PRAGMA table_info(run)').all() as Array<{ name: string }>

  assert.ok(apiKeyColumns.some((column) => column.name === 'key'))
  assert.ok(requestColumns.some((column) => column.name === 'dispatch_state'))
  assert.ok(runColumns.some((column) => column.name === 'webhook_api_key_name'))
  sqlite.close()
})
