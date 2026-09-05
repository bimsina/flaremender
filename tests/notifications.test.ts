import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'

import type { NotificationEvent } from '../src/engine/notifications/events.ts'
import { discordBody, emailBody, render, slackBody } from '../src/engine/notifications/format.ts'
import { signPayload } from '../src/engine/notifications/sign.ts'

const failed: NotificationEvent = {
  type: 'run.failed',
  project: { id: 'prj_1', name: 'Storefront' },
  run: {
    id: 'run_1',
    status: 'failed',
    trigger: 'schedule',
    test: { id: 'int_1', title: 'Checkout completes with a test card' },
    environment: { id: 'env_1', name: 'Production', baseUrl: 'https://shop.example.com' },
    errorMessage:
      "locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button')",
    durationMs: 31_240,
    startedAt: '2026-09-05T04:00:00.000Z',
    finishedAt: '2026-09-05T04:00:31.000Z',
    url: 'https://flaremender.example/projects/prj_1/runs/run_1',
    reportUrl: 'https://flaremender.example/api/reports/runs/run_1',
  },
}

test('a failed run renders as a headline, the environment, and the first line of the error', () => {
  const view = render(failed)
  assert.equal(view.headline, 'Checkout completes with a test card failed')
  assert.equal(view.severity, 'bad')
  assert.match(view.lines[0]!, /Storefront · Production/)
  assert.equal(view.lines.at(-1), 'Error: locator.click: Timeout 30000ms exceeded.')
  assert.equal(view.url, failed.run.url)
})

test('Slack, Discord and email bodies carry the headline and link and escape HTML', () => {
  const slack = JSON.parse(slackBody(failed)) as {
    text: string
    attachments: Array<{ color: string }>
  }
  assert.match(slack.text, /Checkout completes with a test card failed/)
  assert.equal(slack.attachments[0]!.color, '#e01e5a')

  const discord = JSON.parse(discordBody(failed)) as { embeds: Array<{ url: string }> }
  assert.equal(discord.embeds[0]!.url, failed.run.url)

  const email = emailBody({
    ...failed,
    run: { ...failed.run, errorMessage: '<script>alert(1)</script>' },
  })
  assert.equal(email.subject, '[Flaremender] Checkout completes with a test card failed')
  assert.ok(!email.html.includes('<script>'))
  assert.ok(email.html.includes('&lt;script&gt;'))
})

test('a suite event lists its failures and caps the list', () => {
  const view = render({
    type: 'suite.failed',
    project: { id: 'prj_1', name: 'Storefront' },
    suite: {
      id: 'srun_1',
      status: 'failed',
      trigger: 'schedule',
      environment: { id: 'env_1', name: 'Production', baseUrl: null },
      counts: { total: 12, passed: 2, failed: 10, error: 0 },
      failures: Array.from({ length: 10 }, (_, index) => ({
        id: `run_${index}`,
        status: 'failed',
        test: { id: `int_${index}`, title: `Test ${index}` },
        errorMessage: null,
        url: 'https://flaremender.example/x',
      })),
      startedAt: '2026-09-05T04:00:00.000Z',
      finishedAt: null,
      url: 'https://flaremender.example/projects/prj_1?tab=runs',
      reportUrl: 'https://flaremender.example/api/reports/suites/srun_1',
    },
  })
  assert.equal(view.headline, 'Suite failed: 10 of 12 in Storefront')
  assert.equal(view.lines.filter((line) => line.startsWith('✘')).length, 8)
  assert.equal(view.lines.at(-1), '…and 2 more')
})

test('the webhook signature is an HMAC of "<t>.<body>" a receiver can recompute', async () => {
  const body = JSON.stringify({ hello: 'world' })
  const header = await signPayload('whsec_test', body, 1_757_040_000)
  const [t, v1] = header.split(',').map((part) => part.split('=')[1])
  assert.equal(t, '1757040000')
  assert.equal(v1, createHmac('sha256', 'whsec_test').update(`1757040000.${body}`).digest('hex'))
})
