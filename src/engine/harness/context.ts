import type { Page } from '@cloudflare/playwright'
import type { expect } from '@cloudflare/playwright/test'

export interface ScriptContext {
  page: Page
  expect: typeof expect
  secret: (name: string) => string
}

export type ScriptModule = (context: ScriptContext) => void | Promise<void>
