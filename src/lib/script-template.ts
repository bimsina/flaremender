/**
 * What a brand-new intent starts from.
 *
 * Shared between the editor (which seeds it), the docs and the generator, so
 * there is exactly one statement anywhere of what a script looks like.
 */

/**
 * The default export is called once per run with `{ page, expect, secret }`:
 *
 * - `page` and `expect` are real `@cloudflare/playwright` objects — anything in
 *   the Playwright docs works here unchanged.
 * - relative URLs resolve against the environment's base URL.
 * - `secret('NAME')` reads an environment variable of the environment the run
 *   targets; its value is redacted from logs and error messages.
 */
export const DEFAULT_SCRIPT_TEMPLATE = `export default async function ({ page, expect, secret }) {
  // Relative URLs resolve against this environment's base URL.
  await page.goto('/')

  // Anything from the Playwright docs works here.
  // await page.getByLabel('Email').fill(secret('EMAIL'))
  // await page.getByLabel('Password').fill(secret('PASSWORD'))
  // await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page).toHaveTitle(/./)
}
`
