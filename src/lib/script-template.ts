export const DEFAULT_SCRIPT_TEMPLATE = `export default async function ({ page, expect, secret }) {
  await page.goto('/')

  await expect(page).toHaveTitle(/./)
}
`
