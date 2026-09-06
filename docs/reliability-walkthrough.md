# Check the run engine locally

A repeatable way to check the run engine end to end on a laptop, without a model
and without spending anything. Everything below targets local state. Browser
Rendering may still go through the configured Cloudflare binding, so this is not a
quota test or a production deployment test.

## Seed the fixtures

Start the app and the dedicated test application in separate terminals:

```bash
pnpm db:migrate
pnpm dev
pnpm manual:app
pnpm manual:fixtures
```

The fixture seeder adds a project called **Manual reliability lab** to the local
instance admin's organization. Re-running it is safe. It keeps existing fixture
edits and runs. The target is `http://127.0.0.1:4175`, and every mutation stays
inside that disposable application. Each browser context starts with its own local
task data.

The project contains 12 ready scenarios and three drafts:

| Scenarios                                                                                                                | Expected result                          |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Browser isolation, input validation, duplicates, CRUD, Unicode and special characters, delayed responses, authentication | 7 passes                                 |
| Deliberately missing feature, locator timeout                                                                            | 2 test failures                          |
| Missing credentials, syntax error, unavailable target                                                                    | 3 execution errors                       |
| Assertion-free draft                                                                                                     | Pass, excluded from regression counts    |
| Incomplete draft                                                                                                         | Error, remains a draft                   |
| Script closes its page before failing                                                                                    | Error with a separate screenshot warning |

Click **Run suite** twice. Each suite must report 12 runs: 7 passed, 2 failed and
3 errors. The three drafts must not appear. A suite marked "Error" here is the
intended result, not a failed check.

## Verify the report endpoints

After the suite finishes, check the authenticated report endpoints:

```bash
FLAREMENDER_TEST_PASSWORD='<local admin password>' pnpm manual:verify
```

The verifier signs in with a separate session, compares each run's JSON report with
the suite export and the scenario expectations, checks the JUnit counts, and
confirms that anonymous and cross-organization access is denied. It creates and
deletes its own temporary organization without changing the browser session. Set
`FLAREMENDER_TEST_EMAIL` if the local instance uses a different admin email. Do not
commit real credentials.

To also check a project the agent built, set `FLAREMENDER_AI_PROJECT_ID` to that
project's id. The verifier then checks its regression passes, the exclusion of any
draft that describes a missing feature, the skipped verification runs, matching
individual and suite reports, and the absence of the fixture credentials from the
exports.

## Walk through the UI by hand

1. Create a project and an environment through the UI. Open **Create manually**.
   The code editor must be visible at once.
2. Save an assertion-free script. Run it with **Save and run** and confirm that the
   report names its exact saved version as a draft check. It must not become ready.
3. Enter code and a version note, then switch between Script, Runs and History.
   Both edits must survive. Navigating away and regenerating must prompt before
   discarding them.
4. Mark a saved script ready. An assertion-free script must show a coverage
   warning. An author can still choose readiness.
5. Introduce a failed expectation. Confirm the report shows the recorded error, the
   failed step, the screenshot and the trace link. Logs must start collapsed.
6. Save or restore another version. It must be a draft with no inherited pass. The
   old run must keep its original version and environment.
7. Set a schedule while the test is a draft. It must show as paused. Mark the test
   ready to enable the schedule. Remove walkthrough schedules afterwards.
8. Run the dedicated artifact-failure draft. Its test error must stay distinct from
   the screenshot collection warning.
9. Refresh historical chat cards after their event channels expire. Finished
   generation, exploration and batch cards must resolve from their job ids.
10. Review desktop and narrow screens, keyboard focus and both themes.

## Automated checks

`pnpm test` covers additive migrations, metadata-based historical classification,
version and result isolation, late completion, persistence retries, readiness
filters, scheduling, assertion hints, artifact failures, report authorization,
redaction, webhook idempotency, notifications and repairs. One case is an
infrastructure-error and late-success race that must not attach contradictory
evidence.

## What this does not cover

- Remote Cloudflare quotas, real cron delivery and provider limits. The local
  fixtures never touch them.
- Repairs. The fixtures have no model, and the repair loop needs one. See
  [Repairs](architecture.md#repairs) for how the loop is bounded.
- Hot reload. The dev server has occasionally lost TanStack server-function
  registrations after repeated hot reloads. A clean restart restores them, and the
  production build did not reproduce it. Do not edit modules while an acceptance
  job is running, and wait for HTTP readiness before you reload the browser.
