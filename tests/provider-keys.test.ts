import assert from 'node:assert/strict'
import { test } from 'node:test'

import { providerKey } from '../src/db/schema/app.ts'
import { pickProviderKey } from '../src/server/org/provider-keys.ts'
import { testDatabase } from './database.ts'

const decrypt = async (envelope: string) => envelope.replace(/^enc:/, '')

test('an organization key wins over the Worker secret and the instance key', async () => {
  const { db } = testDatabase()

  await db.insert(providerKey).values([
    {
      id: 'pk_instance',
      organizationId: null,
      provider: 'anthropic',
      encryptedKey: 'enc:instance',
      addedBy: 'usr_test',
    },
    {
      id: 'pk_org',
      organizationId: 'org_test',
      provider: 'anthropic',
      encryptedKey: 'enc:own',
      addedBy: 'usr_test',
    },
  ])

  const own = await pickProviderKey(db, {
    provider: 'anthropic',
    organizationId: 'org_test',
    secret: 'sk-secret',
    decrypt,
  })
  assert.deepEqual(own, { source: 'organization', key: 'own' })

  const other = await pickProviderKey(db, {
    provider: 'anthropic',
    organizationId: 'org_other',
    secret: 'sk-secret',
    decrypt,
  })
  assert.deepEqual(other, { source: 'secret', key: 'sk-secret' })

  const noSecret = await pickProviderKey(db, {
    provider: 'anthropic',
    organizationId: 'org_other',
    secret: null,
    decrypt,
  })
  assert.deepEqual(noSecret, { source: 'database', key: 'instance' })

  const none = await pickProviderKey(db, {
    provider: 'openai',
    organizationId: 'org_test',
    secret: null,
    decrypt,
  })
  assert.deepEqual(none, { source: 'none', key: null })

  const workersAi = await pickProviderKey(db, {
    provider: 'workers-ai',
    organizationId: 'org_test',
    secret: null,
    decrypt,
  })
  assert.equal(workersAi.source, 'secret')
})

test('one instance key and one key per organization per provider', async () => {
  const { db } = testDatabase()

  await db.insert(providerKey).values({
    id: 'pk_1',
    organizationId: null,
    provider: 'openai',
    encryptedKey: 'enc:a',
    addedBy: 'usr_test',
  })
  await assert.rejects(
    db.insert(providerKey).values({
      id: 'pk_2',
      organizationId: null,
      provider: 'openai',
      encryptedKey: 'enc:b',
      addedBy: 'usr_test',
    }),
    /UNIQUE|Failed query/,
  )

  await db.insert(providerKey).values({
    id: 'pk_3',
    organizationId: 'org_test',
    provider: 'openai',
    encryptedKey: 'enc:c',
    addedBy: 'usr_test',
  })
  await assert.rejects(
    db.insert(providerKey).values({
      id: 'pk_4',
      organizationId: 'org_test',
      provider: 'openai',
      encryptedKey: 'enc:d',
      addedBy: 'usr_test',
    }),
    /UNIQUE|Failed query/,
  )
  await db.insert(providerKey).values({
    id: 'pk_5',
    organizationId: 'org_other',
    provider: 'openai',
    encryptedKey: 'enc:e',
    addedBy: 'usr_test',
  })
})
