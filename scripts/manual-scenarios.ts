export const manualScenarios = [
  {
    id: 'isolation',
    title: 'Each run starts with an empty browser context',
    expected: 'passed',
    code: `await page.goto('/'); await expect(page.locator('#count')).toHaveText('0 tasks'); await page.getByLabel('Task name').fill('Context marker'); await page.getByRole('button', { name: 'Add task', exact: true }).click(); await expect(page.locator('#count')).toHaveText('1 task');`,
  },
  {
    id: 'validation',
    title: 'Empty and whitespace-only input are rejected',
    expected: 'passed',
    code: `await page.goto('/'); await page.getByRole('button', { name: 'Add task', exact: true }).click(); await expect(page.locator('#task-error')).toHaveText('Enter a task name'); await page.getByLabel('Task name').fill('   '); await page.getByRole('button', { name: 'Add task', exact: true }).click(); await expect(page.locator('#count')).toHaveText('0 tasks');`,
  },
  {
    id: 'duplicates',
    title: 'Duplicate task names are rejected',
    expected: 'passed',
    code: `await page.goto('/'); await page.getByLabel('Task name').fill('Release'); await page.getByRole('button', { name: 'Add task', exact: true }).click(); await page.getByLabel('Task name').fill('release'); await page.getByRole('button', { name: 'Add task', exact: true }).click(); await expect(page.locator('#task-error')).toHaveText('A task with that name already exists'); await expect(page.locator('#count')).toHaveText('1 task');`,
  },
  {
    id: 'crud',
    title: 'Create, edit and delete a task',
    expected: 'passed',
    code: `await page.goto('/'); await page.getByLabel('Task name').fill('Original'); await page.getByRole('button', { name: 'Add task', exact: true }).click(); await page.getByRole('button', { name: 'Edit Original', exact: true }).click(); await page.getByLabel('Task name').fill('Updated'); await page.getByRole('button', { name: 'Save task', exact: true }).click(); await expect(page.locator('#tasks')).toContainText('Updated'); await page.getByRole('button', { name: 'Delete Updated', exact: true }).click(); await expect(page.locator('#count')).toHaveText('0 tasks');`,
  },
  {
    id: 'characters',
    title: 'Special characters remain literal text',
    expected: 'passed',
    code: `await page.goto('/'); const value = '<script>alert(1)</script> & "नमस्ते" 🚀'; await page.getByLabel('Task name').fill(value); await page.getByRole('button', { name: 'Add task', exact: true }).click(); await expect(page.locator('#tasks li span')).toHaveText(value); await expect(page.locator('#tasks script')).toHaveCount(0);`,
  },
  {
    id: 'delayed',
    title: 'Delayed responses and saving are awaited',
    expected: 'passed',
    code: `await page.goto('/delayed'); await page.getByLabel('Task name').fill('Slow save'); await page.getByLabel('Delay saving').check(); await page.getByRole('button', { name: 'Add task', exact: true }).click(); await expect(page.getByRole('status')).toHaveText('Task saved'); await expect(page.locator('#count')).toHaveText('1 task');`,
  },
  {
    id: 'authentication',
    title: 'Authentication rejects invalid credentials and signs out',
    expected: 'passed',
    code: `await page.goto('/'); await page.getByLabel('Email', { exact: true }).fill('wrong@lab.test'); await page.getByLabel('Password', { exact: true }).fill('invalid'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.locator('#login-error')).toHaveText('Email or password is incorrect'); await page.getByLabel('Email', { exact: true }).fill('demo@lab.test'); await page.getByLabel('Password', { exact: true }).fill('fixtures-only'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Welcome, demo', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();`,
  },
  {
    id: 'broken',
    title: 'Deliberate missing feature produces a failed expectation',
    expected: 'failed',
    code: `await page.goto('/'); await expect(page.getByRole('button', { name: 'Travel through time', exact: true })).toBeVisible({ timeout: 500 });`,
  },
  {
    id: 'credentials',
    title: 'Missing credentials explain how to recover',
    expected: 'error',
    code: `await page.goto('/'); secret('INTENTIONALLY_MISSING');`,
  },
  {
    id: 'syntax',
    title: 'Syntax errors produce execution errors',
    expected: 'error',
    code: `const invalid = ;`,
  },
  {
    id: 'timeout',
    title: 'Locator timeouts are test failures',
    expected: 'failed',
    code: `await page.goto('/'); await page.getByRole('button', { name: 'Never appears', exact: true }).click({ timeout: 500 });`,
  },
  {
    id: 'unavailable',
    title: 'Unavailable targets produce a useful error',
    expected: 'error',
    code: `await page.goto('http://127.0.0.1:49159', { timeout: 1000 });`,
  },
  {
    id: 'noassertions',
    title: 'Assertion-free drafts do not count as regressions',
    expected: 'passed',
    draft: true,
    code: `await page.goto('/');`,
  },
  {
    id: 'incomplete',
    title: 'Incomplete drafts remain editable',
    expected: 'error',
    draft: true,
    code: `await page.goto('/'); throw new Error('Incomplete fixture: expected behavior is not implemented');`,
  },
  {
    id: 'artifacts',
    title: 'Artifact capture failures are separate from the test error',
    expected: 'error',
    draft: true,
    code: `await page.goto('/'); await page.close(); throw new Error('Deliberate script error after closing page');`,
  },
] as const

export function scenarioScript(code: string) {
  return `export default async function ({ page, expect, secret }) {\n${code}\n}\n`
}
