# Contributing

Issues and pull requests are welcome. There is no process. Open an issue if you
want to discuss something first. Otherwise send the patch.

## Set up

```bash
pnpm install
wrangler login                    # the AI binding runs remotely even in dev
cp .env.example .env.local        # then set BETTER_AUTH_SECRET and ENCRYPTION_KEY
pnpm db:migrate
pnpm dev
```

Sign up at http://localhost:3009 and you are the admin.

## Demo data and screenshots

The README screenshots are generated, not hand-taken. To rebuild them, or to see
the UI with a realistic amount of history in it:

```bash
pnpm dev        # in one terminal
pnpm demo       # in another: seeds the data, then captures the screenshots
```

`pnpm demo:seed` creates the `ada@example.com` account and an "Acme Inc."
organization if they do not exist yet. It then writes three projects, twenty-five
tests and fourteen days of runs straight into the local D1 database. It talks to no
model and drives no browser, so it costs nothing and is safe to re-run. The random
numbers are seeded, so re-running produces the same shape of history, shifted to
end today.

`pnpm screenshots` signs in as that account with headless Chromium and walks the app
twice, once in light and once in dark. It writes lossless WebP to `docs/screenshots/`
at 2x. The docs pair each `name.webp` with its `name-dark.webp` in a `<picture>`, so
GitHub shows whichever matches the reader's theme. Re-run it after any UI change the
docs show. It needs `cwebp` or `magick` on PATH. Install one with `brew install webp`
or `brew install imagemagick`. Without either, it leaves the PNGs in place and says so.

Both scripts take an email as their first argument if you would rather use your own
account.

## Before you push

```bash
pnpm lint
pnpm format
pnpm typecheck
pnpm test
```

CI runs exactly these, plus `pnpm build`.

## Things that will trip you up

- **Three files are generated.** `src/db/schema/auth.ts` comes from
  `pnpm auth:generate`, `src/routeTree.gen.ts` from `pnpm generate-routes` and
  `src/engine/harness/harness.generated.js` from `pnpm harness`. Regenerate them.
  Never hand-edit them.
- **`auth.config.ts` is not the runtime config.** It exists so the Better Auth CLI
  can generate the schema. The real configuration is `src/lib/auth/auth.ts`. If you
  add a plugin, add it to both, or the generated schema drifts.
- **Never use Tailwind's `dark:` variant.** Kumo resolves light and dark through CSS
  `light-dark()` keyed on `data-mode`.
- **The harness build has two load-bearing settings.** `keepNames` must stay on,
  because Playwright dispatches on `constructor.name`. `./user-script.js` must stay
  external, because that import is the slot the Worker Loader fills.
- **Redact before you truncate.** The scrubber replaces whole values, so clipping a
  string first defeats it. A regression test covers this.
- **Migrations are additive.** Do not run `db:push` against a database that has
  history.

## Evals

Prompt and agent-loop changes are measured, not eyeballed. `pnpm eval --model …`
generates a fixed scenario set against the example apps and prints a score table.
See [docs/evals.md](docs/evals.md). Include the before and after tables in any PR
that touches `src/engine/*/prompts.ts`.

## Tests

`tests/` covers the invariants that are expensive to get wrong: organization scoping,
run verdict races, draft-versus-ready promotion, redaction and webhook idempotency.
If you change any of those, the test that guards it should fail first.
