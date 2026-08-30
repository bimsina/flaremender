import { launch } from '@cloudflare/playwright'
import { expect } from '@cloudflare/playwright/test'
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'

export interface RunWorkflowParams {
  runId: string
}

export interface SpikeStepResult {
  ok: boolean
  runId: string
  title: string
  screenshotBytes: number
}

/**
 * The durable run engine.
 *
 * Only the `spike` step exists so far: it proves a Workflow exported from the
 * custom server entry can drive Browser Rendering through `@cloudflare/playwright`.
 * The real generate → run → repair steps replace it in a later milestone.
 */
export class RunWorkflow extends WorkflowEntrypoint<Cloudflare.Env, RunWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<RunWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<SpikeStepResult> {
    const { runId } = event.payload

    return await step.do('spike', async (): Promise<SpikeStepResult> => {
      const browser = await launch(this.env.BROWSER)
      try {
        const page = await browser.newPage()
        await page.goto('https://example.com')
        await expect(page.getByRole('heading', { name: 'Example Domain' })).toBeVisible()

        const title = await page.title()
        const screenshot = await page.screenshot()

        return { ok: true, runId, title, screenshotBytes: screenshot.byteLength }
      } finally {
        await browser.close()
      }
    })
  }
}
