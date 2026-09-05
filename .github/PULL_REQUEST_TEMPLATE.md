## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How you checked it

<!-- What you ran and what you saw. `pnpm lint && pnpm format && pnpm typecheck && pnpm test` is the minimum. If the change is visible in the UI, a screenshot in both themes helps. -->

## Checklist

- [ ] No generated file was hand-edited (`src/db/schema/auth.ts`, `src/routeTree.gen.ts`, `harness.generated.js`)
- [ ] Any new organization-scoped server function goes through `orgMiddleware`
- [ ] Any new binding handed to the harness is reflected in SECURITY.md
- [ ] Docs updated if behaviour or setup changed
