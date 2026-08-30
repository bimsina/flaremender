/**
 * The one object a test script receives.
 *
 * `page` and `expect` are the real `@cloudflare/playwright` objects behind a
 * thin instrumenting proxy, so anything the Playwright docs describe works
 * unchanged — the proxy only watches, it never reimplements.
 */
import type { Page } from '@cloudflare/playwright'
import type { expect } from '@cloudflare/playwright/test'

export interface ScriptContext {
  /** Relative URLs (`page.goto('/login')`) resolve against the environment's base URL. */
  page: Page
  expect: typeof expect
  /**
   * Reads an environment variable of the environment the run targets. Throws if
   * the variable is not set, so a missing credential fails loudly instead of
   * typing the string `undefined` into a login form. Values are redacted from
   * logs and error messages before anything is stored.
   */
  secret: (name: string) => string
}

export type ScriptModule = (context: ScriptContext) => void | Promise<void>
