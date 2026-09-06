## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How you checked it

<!-- What you ran and what you saw. `pnpm lint && pnpm format && pnpm typecheck && pnpm test` is the minimum. If the change is visible in the UI, add a screenshot in both themes. -->

## Checklist

- [ ] No generated file was hand-edited (`src/db/schema/auth.ts`, `src/routeTree.gen.ts`, `harness.generated.js`)
- [ ] Every new organization-scoped server function goes through `orgMiddleware`
- [ ] Every new binding handed to the harness is listed in SECURITY.md
- [ ] Docs are updated if behaviour or setup changed
