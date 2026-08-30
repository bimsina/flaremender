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
    actions.ts    the shared core each of them (and the chat) calls
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
  suite-workflow.ts    a project's intents, run one after another
  schedule-dispatch.ts the minute tick: which intents are due
  retention.ts         the nightly sweep: what history to drop
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

### The project chat

Every project's default tab is a chat, and it is a console rather than a
chatbot: the assistant carries requests out with tools that call the same
org-scoped functions in `src/server/actions.ts` the dialogs and buttons call, and
answers with **cards** — an intent, a live generation, a run, a suite, an
environment — each of which links to the row it names. Nothing exists only inside
a conversation.

```
src/engine/
  chat/contract.ts   message parts, cards and the socket's event types
  chat/prompts.ts    the system prompt and the project's standing facts
  chat/tools.ts      the tool belt, wrapping server/actions.ts
  project-chat.ts    the ProjectChat Durable Object
src/server/
  actions.ts         what the product does, with nobody in particular asking
  chat.ts            listChatMessages + sendChatMessage
```

One `ProjectChat` Durable Object per project, addressed by the project id,
serialises turns — a second send while one is running is refused rather than
queued — runs the model turn (`streamText` with the tool belt), and streams
deltas, tool events and cards over hibernating WebSockets at
`/api/projects/:projectId/chat`. `src/server.ts` answers that upgrade the same
way it answers a run's: signed in, in an organization, and that organization owns
the project. Messages are persisted to D1 (`chat_message`, typed JSON parts) and
the history is what the model is shown next turn, with cards compacted to
one-line facts so it never has to invent an id.

**Credential lifting.** Paste a password into the chat and the assistant stores
it with `set_environment_variable`; from that moment the value is `***`
everywhere — the turn's redactor is rebuilt around it and the message that
carried it is rewritten in D1 and on every open socket. The user's own message is
never broadcast, precisely because it is the one string that can hold a value the
redactor has not been told about yet; the sender renders their own copy, everyone
else sees the redacted row when the turn ends. The residual risk is inherent and
documented: the value reached the configured model provider once, in that message
and in the tool call that stored it.

### Explore, propose, generate

The chat's other half. Rather than being told what to test, the assistant can go
and find out: `explore_project` starts an **ExploreWorkflow** that drives a real
browser round the app — signing in with the stored credentials, reading any docs
URL it is given — and ends by proposing tests. Those proposals are **real intent
rows** in a new `'proposed'` status, rendered in the conversation as a checklist
you tick, edit and approve; approving starts a **BatchGenerateWorkflow** that
writes each script with the same turn loop a single Generate does.

```
src/engine/
  explore/prompts.ts    what the explorer is told, and the context it writes back
  explore/loop.ts       one explore turn: observe, navigate, interact, read_docs
  explore/docs.ts       fetch a docs page, strip it to text, cap it twice
  explore/steps.ts      claim the job, write the intents, post the plan
  explore-workflow.ts   the ExploreWorkflow
  generation/job.ts     one generation, shared by Generate and the batch
  batch-workflow.ts     an approved plan, one test at a time
  agent-transcript.ts   pruning stale page trees, shared by both loops
src/server/
  explore.ts            explore / approve / dismiss / edit the context
```

The explorer is the generator's opposite twin, and deliberately so. A generation
is building a file, so every fragment it keeps is permanently a line somebody
reads and wandering is a defect — hence `detectReplay` and the navigation-churn
guard. An exploration is building an _opinion_, so nothing it does is kept and
wandering is the job: it may navigate freely and abandon what it tries. Only
`rejectUnsafeInteraction` still applies, because `evaluate` and `force: true` are
how an agent breaks somebody's real app.

**`'proposed'` is not a test yet.** A proposed intent is excluded from "run all",
from the scheduler, and from every count that answers "how many tests does this
project have" — `isAdoptedIntent` in `server/actions.ts` is the one filter all of
them wear. Approving flips it to `'draft'` and generates; dismissing deletes it,
because a rejected suggestion is not a state worth keeping and the next
exploration will propose it again if it was a good idea.

**`project.context`** is what the agents know about the app beyond any one
intent: the chat writes it with `set_project_context`, an exploration appends
what it found, and it is read into every chat turn and every generation's opening
message. Always redacted before it is written — a user pasting "log in with
ada@example.com / hunter2" is the _expected_ way this field gets its first
paragraph, and the value goes to an encrypted environment variable while the
sentence around it lands here with `***` in the middle. Editable on the project's
Settings tab, because a column that steers every future generation must not be
one only a machine can reach.

**Long jobs speak into the conversation.** An exploration finishes minutes after
the turn that started it ended, so the workflow posts its plan through
`ProjectChat.announce()` — which redacts what it is given and declines to
broadcast over a turn that is mid-answer, leaving the card in the transcript to
re-read the history when it sees the job finish.

### Schedules and retention

Two cron triggers reach `scheduled` in `src/server.ts`, told apart by the
expression that fired them:

- **`* * * * *`** — every intent whose own five-field cron matches this UTC
  minute is due. Due intents are grouped per project and handed to one
  `SuiteWorkflow` against the project's default environment, with trigger
  `schedule` and no `createdBy`. A project whose suite is still running is
  skipped rather than stacked, and the suite's id is derived from the project
  and the minute (`srun_sch_<project>_<yyyymmddhhmm>`) so a replayed tick
  creates nothing.
- **`30 3 * * *`** — keeps the newest N runs per intent (N from
  `instanceSettings.retentionRunsPerIntent`, default 50), deleting older runs,
  their attempts and their R2 prefixes. At most 500 objects per night; the rest
  waits for the next one.

Schedules are read in UTC. The grammar — `*`, numbers, lists, ranges and steps,
and the POSIX rule that a restricted day-of-month and day-of-week are ORed — is
documented on `src/lib/cron.ts`, which is the single parser behind the editor,
the badge and the dispatcher.

Cron triggers do not fire on their own under `pnpm dev`. Fire one by hand:

```bash
# a schedule tick for a specific UTC minute
curl "http://localhost:3000/cdn-cgi/handler/scheduled?cron=*%20*%20*%20*%20*&time=$(node -e 'console.log(Math.floor(Date.now()/60000)*60000)')"

# the nightly retention sweep
curl "http://localhost:3000/cdn-cgi/handler/scheduled?cron=30%203%20*%20*%20*"
```

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
