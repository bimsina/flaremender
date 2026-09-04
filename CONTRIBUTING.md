# Contributing

Issues and pull requests are welcome. There is no process to speak of: open an issue
if you want to discuss something first, otherwise send the patch.

## Setup

```bash
pnpm install
wrangler login                    # the AI binding runs remotely even in dev
cp .env.example .env.local        # then set BETTER_AUTH_SECRET and ENCRYPTION_KEY
pnpm db:migrate
pnpm dev
```

Sign up at http://localhost:3009 and you are the admin.

## Demo data and screenshots

The README screenshots are generated, not hand-taken. To rebuild them, or just to
see the UI with a realistic amount of history in it:

```bash
pnpm dev        # in one terminal
pnpm demo       # in another: seeds the data, then captures the screenshots
```

`pnpm demo:seed` creates the `ada@example.com` account and an "Acme Inc."
organization if they do not exist yet, then writes three projects, twenty-five tests
and fourteen days of runs straight into the local D1 database. It talks to no model
and drives no browser, so it costs nothing and is safe to re-run. The random numbers
are seeded, so re-running produces the same shape of history, shifted to end today.

`pnpm screenshots` signs in as that account with headless Chromium and writes
lossless WebP to `docs/screenshots/` at 2x. Re-run it after any UI change the docs
show. It needs `cwebp` or `magick` on PATH (`brew install webp`, or
`brew install imagemagick`); without either it leaves the PNGs in place and says so.

Both take an email as their first argument if you would rather use your own account.

## Before you push

```bash
pnpm lint
pnpm format
pnpm typecheck
pnpm test
```

CI runs exactly these, plus `pnpm build`.

## Things that will trip you up

- **Three files are generated.** `src/db/schema/auth.ts` (`pnpm auth:generate`),
  `src/routeTree.gen.ts` (`pnpm generate-routes`) and
  `src/engine/harness/harness.generated.js` (`pnpm harness`). Regenerate them, never
  hand-edit them.
- **`auth.config.ts` is not the runtime config.** It exists so the Better Auth CLI can
  generate the schema. The real configuration is `src/lib/auth.ts`. If you add a
  plugin, add it to both or the generated schema drifts.
- **Never use Tailwind's `dark:` variant.** Kumo resolves light and dark through CSS
  `light-dark()` keyed on `data-mode`.
- **The harness build has two load-bearing settings.** `keepNames` must stay on,
  because Playwright dispatches on `constructor.name`, and `./user-script.js` must
  stay external, because that import is the slot the Worker Loader fills.
- **Redact before you truncate.** The scrubber replaces whole values, so clipping a
  string first defeats it. There is a regression test for this.
- **Migrations are additive.** Do not run `db:push` against a database that has
  history.

## Tests

`tests/` covers the invariants that are expensive to get wrong: organization scoping,
run verdict races, draft-versus-ready promotion, redaction and webhook idempotency.
If you change any of those, the test that guards it should fail first.
