# Flaremender

An open-source, Cloudflare-native natural language test runner. Describe a test
in plain English, get a Playwright spec, run it in a Cloudflare browser, and let
a failure feed itself back into the next generation until it passes.

## Stack

| Layer | Choice                                                               |
| ----- | -------------------------------------------------------------------- |
| App   | TanStack Start (file router, server functions) on Cloudflare Workers |
| UI    | Cloudflare Kumo + Tailwind v4, Phosphor icons                        |
| Data  | D1 via Drizzle ORM                                                   |
| Auth  | Better Auth with the `organization` and `admin` plugins              |

## Getting started

```bash
pnpm install
pnpm dev
```

The app runs at http://localhost:3000 against the local D1 database under
`.wrangler/`.

### Database

Schema lives in `src/db/schema/`. `auth.ts` is generated — never edit it by hand.

```bash
pnpm auth:generate   # regenerate src/db/schema/auth.ts from auth.config.ts
pnpm db:push         # apply src/db/schema to the local D1 database
pnpm db:studio       # browse the local database
```

`auth.config.ts` exists only for code generation; the runtime configuration is
`src/lib/auth.ts`. Keep their plugin lists in sync or the generated schema will
drift from what the app needs.

### Making yourself an admin

There is no bootstrap flow yet. Sign up, then promote the account directly:

```bash
sqlite3 "$(ls -t .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite | grep -v metadata | head -1)" "UPDATE user SET role='admin' WHERE email='you@example.com';"
```

Sign out and back in, and the Administration section appears in the sidebar.

## How it fits together

```
src/
  db/schema/      app.ts (projects, intents, runs) + auth.ts (generated)
  lib/            auth client, theme, query options, formatting
  server/         server functions, split by resource
    auth.ts       session middleware and the organization tenant boundary
  engine/         the run engine — Workflow, harness, artifacts (see below)
  components/     shared UI
  routes/         _auth.* (signed out), _app.* (signed in), api/auth/$,
                  api/artifacts/$ (org-checked R2 reads)
```

Route groups carry the guards: `_auth` redirects signed-in users away,
`_app` requires a session and an organization, and `_app/admin` requires
`role: 'admin'`. Every organization-scoped server function goes through
`orgMiddleware`, which reads the organization id from the session and never
from the client.

### The run engine

Nothing executes in a request handler. `runIntent` inserts a `queued` run and
creates a `RunWorkflow` instance named after it, then returns; the Workflow
loads, executes and persists in three durable steps.

```
src/engine/
  contract.ts          result and event types shared by all three sides
  harness/runtime.ts   the Dynamic Worker entrypoint (bundled, not imported)
  harness/instrument.ts proxies that turn Playwright calls into step records
  runner/loader.ts     LOADER.load() wiring
  runner/browser.ts    browser lifecycle (compiled into the harness)
  runner/artifacts.ts  R2 writes under runs/{orgId}/{projectId}/{runId}/
  runner/scrub.ts      secret redaction
  run-workflow.ts      load → execute → persist
```

A script runs inside a **Dynamic Worker**, an isolate built from two modules:
the pre-bundled harness and the saved script. Its only bindings are the browser,
the environment's decrypted variables and a base URL — no D1, no R2, no ambient
network — so an untrusted script has nothing to reach for. Artifacts travel back
to the host as bytes and are written to R2 from there.

Dynamic Workers require **Workers Paid** in production. They are free locally.

#### The harness bundle

`@cloudflare/playwright` cannot be imported by the host Worker and handed
across the loader boundary — the loader takes module _source_. `pnpm harness`
(run automatically by `pnpm dev` and `pnpm build`) uses esbuild to bundle
`src/engine/harness/runtime.ts` plus all of Playwright into
`src/engine/harness/harness.generated.js`, which the host imports as a string.
The file is generated, not committed.

Two things about that build are load-bearing: `keepNames` must stay on, because
Playwright dispatches on `constructor.name`, and `./user-script.js` must stay
external, because that import is the slot the loader fills with the saved
script.

#### What a script looks like

```js
export default async function ({ page, expect, secret }) {
  await page.goto('/') // relative URLs resolve against the environment base URL
  await page.getByLabel('Email').fill(secret('EMAIL'))
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}
```

`page` and `expect` are the real Playwright objects behind an instrumenting
proxy, so anything in the Playwright docs works. The proxy records each call as
a step. `secret()` reads an environment variable; its value — raw,
URL-encoded or base64 — is replaced with `***` in every log, label and error
message before anything is stored. Screenshots and traces can still _show_ a
secret: that is a visual leak no string replacement can fix.

## Theming

Kumo resolves light and dark through CSS `light-dark()`, keyed on `data-mode`
on `<html>` — never use Tailwind's `dark:` variant. The preference (light, dark
or system) is stored in a cookie and in `localStorage`, and applied by a
blocking script in `<head>` so there is no flash before hydration.

## Commands

```bash
pnpm dev             # build the harness, then dev server on :3000
pnpm build           # build the harness, then production build
pnpm harness         # rebuild src/engine/harness/harness.generated.js only
pnpm deploy          # build and deploy to Cloudflare
pnpm lint            # oxlint
pnpm format          # oxfmt
pnpm generate-routes # regenerate routeTree.gen.ts
```
