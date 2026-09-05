# Measuring generation

`pnpm eval` generates a fixed set of tests against the two example apps in
`examples/` and scores what came back. Run it before and after a prompt change, or
across models, and compare the tables. Without it, "the agent seems better" is a
feeling.

## What it measures

Twelve scenarios in [evals/scenarios.ts](../evals/scenarios.ts): seven against
Taskbox (a task list behind a sign-in form) and five against Guestbook (a public
message board). Ten describe real behaviour. Two describe features that do not
exist, because a test generator that invents a passing test for a missing feature
is worse than one that gives up.

| Column      | Meaning                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| `score`     | Scenarios whose outcome matched what the scenario expected                                |
| `generated` | Real scenarios where a script was saved at all, verified or not                           |
| `verified`  | Real scenarios where the saved script replayed green in a fresh browser                   |
| `asserted`  | Real scenarios whose script ends in an assertion that would fail if the behaviour broke   |
| `honest`    | Missing-feature scenarios where the agent stopped short instead of shipping a green test  |
| `inverted`  | The number of missing-feature scenarios that came back verified and ready. Should be zero |
| `avgTurns`  | Model turns per scenario, up to four tool calls each                                      |
| `tokens`    | Input plus output tokens across the run, as reported by the provider                      |
| `minutes`   | Wall-clock time summed across scenarios                                                   |

Every result row is also written to `evals/results/<timestamp>.json` with the job
id, the dashboard link and the reason a generation stopped, so a low number can be
traced to the scripts behind it.

## Where things stand

Twelve scenarios, concurrency two, measured on September 5, 2026 against the
prompts in this repository:

| Model                       | Score | Verified | Asserted | Honest | Avg turns | Tokens | Minutes |
| --------------------------- | ----- | -------- | -------- | ------ | --------- | ------ | ------- |
| `openai:gpt-5.6-luna`       | 100%  | 100%     | 100%     | 100%   | 2.3       | 285k   | 5.1     |
| `anthropic:claude-sonnet-5` | 92%   | 90%      | 100%     | 100%   | 2.2       | 474k   | 7.7     |

Both refused the two missing-feature scenarios rather than inventing a passing
test. Sonnet's miss was a generated script that did not replay green. Re-run
these before trusting them for a decision; a single run has noise in it.

**Through AI Gateway.** The same day, the five Guestbook scenarios with the OpenAI
key forwarded over the gateway (`--tag gateway`) scored 80% against 100% direct:
one generated script did not replay green. The gateway's OpenAI route uses the
chat-completions API, which refuses tool calls with reasoning enabled, so
Flaremender sends `reasoning_effort: none` there. That is the likely cost. Five
scenarios is a small sample; treat it as a hint that the direct route is worth a
few cents more when a key is available, not as a verdict.

## Running it

```bash
pnpm dev                                   # in one terminal
pnpm eval --model anthropic:claude-sonnet-5  # in another
```

It signs in as the demo account from `pnpm demo:seed` (override with
`FLAREMENDER_EVAL_EMAIL` and `FLAREMENDER_EVAL_PASSWORD`), starts the example apps
if their ports are free, seeds one project per model and app straight into the
local database, then creates and generates every test through the
[API](webhooks.md#creating-and-generating-tests) the same way a script on your
machine would.

Useful flags:

```bash
pnpm eval --model openai:gpt-5.4-mini --model workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast
pnpm eval --model anthropic:claude-sonnet-5 --only guestbook        # one app
pnpm eval --model anthropic:claude-sonnet-5 --only taskbox-add-task # one scenario
pnpm eval --model anthropic:claude-sonnet-5 --limit 3 --concurrency 2
pnpm eval --model anthropic:claude-sonnet-5 --keep   # leave the eval projects in the app
pnpm eval --model anthropic:claude-sonnet-5 --tag before-prompt-change
```

`EVAL_MODELS=a,b` is the same as repeating `--model`. A model id is
`{provider}:{slug}`, and the provider needs a key on the instance or in the
organization; it does not have to be on the allowlist.

## What it costs

Each scenario is a full generation: a real browser for a few minutes and up to 96
model calls, followed by a verification run. On a hosted model, expect a full run
of twelve scenarios to use a few hundred thousand tokens. On Workers AI it uses
Neurons and Browser Rendering minutes on your account. Start with `--limit 2` when
trying a new model.

The eval projects are deleted when the run finishes unless you pass `--keep`.

## Adding a scenario

Add an entry to `SCENARIOS` in `evals/scenarios.ts`. Quote the exact labels from
the page, say what must be true at the end, and pick `expect: 'pass'` or
`expect: 'refuse'`. If the scenario needs a page the example apps do not have, add
the page to the example app rather than pointing the eval at a site you do not
control: the point is that a run today and a run next month measure the same
thing.
