import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assembleScript } from '../src/engine/generation/script.ts'
import { bodyOf, splitStatements } from '../src/engine/repair/statements.ts'
import { combineHealPolicy } from '../src/server/runs/heal-policy.ts'

test('splitStatements recovers the statements a script was assembled from', () => {
  const fragments = [
    "await page.goto('/')",
    "await page.getByLabel('Email').fill(secret('EMAIL'))\nawait page.getByRole('button', { name: 'Sign in' }).click()",
    "await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()",
  ]
  const code = assembleScript(fragments)

  assert.deepEqual(splitStatements(code), [
    "await page.goto('/')",
    "await page.getByLabel('Email').fill(secret('EMAIL'))",
    "await page.getByRole('button', { name: 'Sign in' }).click()",
    "await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()",
  ])

  // Round trip: re-assembling the statements gives back the same statements.
  const compact = (text: string) => bodyOf(text).replace(/\n\s*\n/g, '\n')
  assert.equal(compact(assembleScript(splitStatements(code))), compact(code))
})

test('splitStatements keeps a multi-line statement together and drops comments', () => {
  const code = `export default async function ({ page, expect, secret }) {
  // sign in first
  await page.goto('/')
  await expect(
    page.getByRole('button', { name: 'Add (item)' }),
  ).toBeVisible()
  await page
    .getByLabel('Name')
    .fill('Ada')

  await expect(page.getByText('Ada')).toBeVisible()
}
`
  const statements = splitStatements(code)
  assert.equal(statements.length, 4)
  assert.match(statements[1]!, /^await expect\(\n/)
  assert.match(statements[2]!, /^await page\n\s*\.getByLabel/)
  assert.equal(statements[3], "await expect(page.getByText('Ada')).toBeVisible()")
})

test('splitStatements accepts a bare body without the function wrapper', () => {
  assert.deepEqual(splitStatements("await page.goto('/')\nawait page.reload()"), [
    "await page.goto('/')",
    'await page.reload()',
  ])
})

test('the heal policy is read test, then project, then organization, and defaults to off', () => {
  assert.equal(
    combineHealPolicy({ test: 'inherit', project: 'inherit', organization: null }).effective,
    'off',
  )
  assert.deepEqual(
    combineHealPolicy({ test: 'inherit', project: 'inherit', organization: 'draft' }),
    {
      effective: 'draft',
      source: 'organization',
      test: 'inherit',
      project: 'inherit',
      organization: 'draft',
    },
  )
  assert.equal(
    combineHealPolicy({ test: 'inherit', project: 'off', organization: 'auto' }).effective,
    'off',
  )
  assert.equal(
    combineHealPolicy({ test: 'auto', project: 'off', organization: 'off' }).effective,
    'auto',
  )
  assert.equal(
    combineHealPolicy({ test: 'auto', project: 'off', organization: 'off' }).source,
    'test',
  )
})
