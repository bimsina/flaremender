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
  db/schema/      app.ts (projects, test cases, runs) + auth.ts (generated)
  lib/            auth client, theme, query options, formatting
  server/         server functions, split by resource
    auth.ts       session middleware and the organization tenant boundary
    engine.ts     generate → run → repair, behind a swappable seam
  components/     shared UI
  routes/         _auth.* (signed out), _app.* (signed in), api/auth/$
```

Route groups carry the guards: `_auth` redirects signed-in users away,
`_app` requires a session and an organization, and `_app/admin` requires
`role: 'admin'`. Every organization-scoped server function goes through
`orgMiddleware`, which reads the organization id from the session and never
from the client.

### The engine is a stub

`src/server/engine.ts` currently pattern-matches the prompt into Playwright
calls and simulates the run — deterministically, so a given attempt always
replays the same way. Nothing above that file knows the difference. To make it
real:

1. Add `ai` and `browser` bindings to `wrangler.jsonc`.
2. Replace `generateSpec` with a Workers AI call.
3. Replace `executeSpec` with a Browser Rendering session that executes the spec.

The signatures in that file are the contract.

## Theming

Kumo resolves light and dark through CSS `light-dark()`, keyed on `data-mode`
on `<html>` — never use Tailwind's `dark:` variant. The preference (light, dark
or system) is stored in a cookie and in `localStorage`, and applied by a
blocking script in `<head>` so there is no flash before hydration.

## Commands

```bash
pnpm dev             # dev server on :3000
pnpm build           # production build
pnpm deploy          # build and deploy to Cloudflare
pnpm lint            # oxlint
pnpm format          # oxfmt
pnpm generate-routes # regenerate routeTree.gen.ts
```
