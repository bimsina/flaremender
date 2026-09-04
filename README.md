# Flaremender

**Write a test in English. Get a Playwright script that runs in a real browser.**

Type what the test should do. "Sign in, add a task, check it appears in the list."
An agent opens your app in a real browser, tries each step, and keeps the code only
once it has watched the step work. What you get back is an ordinary Playwright
script. Read it, edit it, delete half of it. It is yours.

Flaremender runs on your own Cloudflare account. Your app's passwords, your scripts
and your run history stay there.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bimsina/flaremender)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/dashboard-dark.webp">
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/dashboard.webp">
  <img alt="The Flaremender dashboard: three projects, a fourteen-day run history and a 92 percent pass rate" src="docs/screenshots/dashboard.webp">
</picture>

## What it does

- **Writes tests from a sentence.** The agent drives a live browser and verifies
  every fragment before it keeps it.
- **Finds its own work.** Point it at your app and it explores, then hands you a
  checklist of proposed tests to approve, edit or throw away.
- **Runs them.** On demand, on a cron schedule, or from CI through a
  [webhook API](docs/webhooks.md) with idempotency keys and JUnit output.
- **Keeps the evidence.** Steps, logs, screenshots and a full Playwright trace per
  run, with the trace viewer built in.
- **Sandboxes what it wrote.** Scripts execute in a Dynamic Worker with no database,
  no object storage and no ambient network.

Ask for a test in the project chat, and the assistant answers with cards. Each card
is a real row, not something that exists only in the conversation.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/project-chat-dark.webp">
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/project-chat.webp">
  <img alt="The project chat: a request for a discount-code test, the intent card it created, and the failed run it reports back" src="docs/screenshots/project-chat.webp">
</picture>

What you get is ordinary Playwright, so anything in the Playwright docs works:

```js
export default async function ({ page, expect, secret }) {
  await page.goto('/') // relative URLs resolve against the environment base URL
  await page.getByLabel('Email').fill(secret('EMAIL'))
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}
```

When a test fails, the evidence is already there. Note the second step: the password
went in through `secret()`, so what was stored is `***`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/run-detail-dark.webp">
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/run-detail.webp">
  <img alt="A failed run: the recorded timeout error and a step history where the filled password reads three asterisks" src="docs/screenshots/run-detail.webp">
</picture>

## Deploy it

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bimsina/flaremender)

You need **Workers Paid** ($5/month), because Dynamic Workers sandbox every test
script and they are not on the free plan. You also need R2 enabled, and a
`BETTER_AUTH_SECRET` and `ENCRYPTION_KEY` (`openssl rand -hex 32` each).

The first account to register becomes the instance admin, so sign up straight after
deploying, then set `DISABLE_SIGNUP=true` and redeploy.

Full prerequisites, costs and the manual path: **[docs/deploying.md](docs/deploying.md)**.

## Run it locally

```bash
pnpm install
wrangler login                 # the AI binding runs remotely even in dev
cp .env.example .env.local     # then set BETTER_AUTH_SECRET and ENCRYPTION_KEY
pnpm db:migrate
pnpm dev                       # http://localhost:3009
pnpm demo:seed                 # optional: fill it with demo projects and runs
```

Dynamic Workers are free locally, so a local instance runs tests without a paid plan.

## Status

It works, and it is early. Specifically:

- **Self-healing is not implemented.** The name promises it. The code does not do it
  yet. A failing test stays failing until a person repairs it.
- **The deploy path has not been exercised end to end yet.** Everything has been
  built and tested against a local Cloudflare runtime. If the button breaks for you,
  that is a bug worth an issue.
- No email verification, no password reset, no usage caps. One organization can
  spend the whole account's budget.
- Generated scripts need a read before you trust them, which is why they start as
  drafts and a person has to mark them ready.

Flaremender holds the credentials to the apps it tests. Before you deploy it, read
what protects them and what does not: **[SECURITY.md](SECURITY.md)**.

## Docs

|                                              |                                                                 |
| -------------------------------------------- | --------------------------------------------------------------- |
| [docs/deploying.md](docs/deploying.md)       | Prerequisites, costs, one-click and manual deploys, local setup |
| [docs/architecture.md](docs/architecture.md) | How the run engine, chat, explorer and scheduler fit together   |
| [docs/webhooks.md](docs/webhooks.md)         | Triggering runs from CI, polling, idempotency, JUnit            |
| [SECURITY.md](SECURITY.md)                   | Threat model, what is in scope, how to report                   |
| [CONTRIBUTING.md](CONTRIBUTING.md)           | Setup, checks, and the things that will trip you up             |

## Stack

TanStack Start on Cloudflare Workers, Cloudflare Kumo and Tailwind v4, D1 via
Drizzle, Better Auth with the organization, admin and API-key plugins. Tests execute
in Dynamic Workers with `@cloudflare/playwright`.

## License

[MIT](LICENSE) © Bibek Timsina
