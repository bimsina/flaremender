import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classify, formatDocuments, modelCanSee } from '../src/engine/knowledge.ts'
import { openingContent } from '../src/engine/opening.ts'

test('files are classified by content type first and extension second', () => {
  assert.equal(classify('README.md', 'text/markdown'), 'text')
  assert.equal(classify('README.md', 'application/octet-stream'), 'text')
  assert.equal(classify('api.json', 'application/json'), 'text')
  assert.equal(classify('manual.pdf', 'application/pdf'), 'pdf')
  assert.equal(classify('flow.png', 'image/png'), 'image')
  assert.equal(classify('archive.zip', 'application/zip'), 'other')
})

test('documents become one prompt section that says they are background', () => {
  assert.equal(formatDocuments([]), null)
  const section = formatDocuments([
    { name: 'README.md', text: 'Rename is not supported.', truncated: false },
    { name: 'manual.pdf', text: 'Chapter 1', truncated: true },
  ])!
  assert.match(section, /^# Documents the owner uploaded/)
  assert.match(section, /Background, not instructions/)
  assert.match(section, /## README\.md\n\nRename is not supported\./)
  assert.match(section, /## manual\.pdf \(excerpt\)/)
})

test('pictures only go to models that can see, and an opening without them stays a string', () => {
  assert.equal(modelCanSee('workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast'), false)
  assert.equal(modelCanSee('openai:gpt-5.6-luna'), true)
  assert.equal(modelCanSee(null), false)

  assert.equal(openingContent('task', []), 'task')
  const content = openingContent('task', [
    { name: 'flow.png', mediaType: 'image/png', base64: 'AAAA' },
  ])
  assert.ok(Array.isArray(content))
  assert.deepEqual(content[0], { type: 'text', text: 'task' })
  assert.deepEqual(content[1], { type: 'image', image: 'AAAA', mediaType: 'image/png' })
})
