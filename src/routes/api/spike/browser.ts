import fs from 'node:fs'
import { type Browser, launch } from '@cloudflare/playwright'
import { expect } from '@cloudflare/playwright/test'
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { devOnly } from '#/routes/api/spike/-dev-only.ts'

const TRACE_PATH = '/tmp/flaremender-spike-trace.zip'

async function handler() {
  const blocked = devOnly()
  if (blocked) return blocked

  const startedAt = Date.now()
  let browser: Browser | undefined

  try {
    browser = await launch(env.BROWSER)
    const page = await browser.newPage()
    const context = page.context()

    await context.tracing.start({ screenshots: true, snapshots: true })
    await page.goto('https://example.com')
    await expect(page.getByRole('heading', { name: 'Example Domain' })).toBeVisible()

    const title = await page.title()
    const screenshot = await page.screenshot()
    const ariaSnapshot = await page.locator('body').ariaSnapshot()

    await context.tracing.stop({ path: TRACE_PATH })
    const trace = await fs.promises.readFile(TRACE_PATH)

    return Response.json({
      ok: true,
      title,
      screenshotBytes: screenshot.byteLength,
      traceBytes: trace.byteLength,
      ariaSnapshotPreview: ariaSnapshot.slice(0, 500),
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: String(error),
        stack: error instanceof Error ? error.stack : null,
        durationMs: Date.now() - startedAt,
      },
      { status: 500 },
    )
  } finally {
    await browser?.close()
  }
}

export const Route = createFileRoute('/api/spike/browser')({
  server: { handlers: { GET: handler } },
})
