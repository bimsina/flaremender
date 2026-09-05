# Local reliability walkthrough

A repeatable way to check the run engine end to end on a laptop, without a model
and without spending anything. Everything below targets local state. Browser
Rendering may still go through the configured Cloudflare binding, so this is not
a quota or production deployment test.

## Repeatable fixtures

Start the app and dedicated test application in separate terminals:

```bash
pnpm db:migrate
pnpm dev
pnpm manual:app
pnpm manual:fixtures
```

The fixture seeder adds **Manual reliability lab** to the local instance admin's
organization. It is idempotent and preserves existing fixture edits and runs.
The target is `http://127.0.0.1:4175`; all mutations stay inside this disposable
application. Each browser context starts with its own local task data.

The project contains 12 ready scenarios and three drafts:

| Scenarios                                                                                                            | Expected result                          |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Browser isolation, input validation, duplicates, CRUD, Unicode/special characters, delayed responses, authentication | 7 passes                                 |
| Deliberately missing feature, locator timeout                                                                        | 2 test failures                          |
| Missing credentials, syntax error, unavailable target                                                                | 3 execution errors                       |
| Assertion-free draft                                                                                                 | Pass, excluded from regression counts    |
| Incomplete draft                                                                                                     | Error, remains a draft                   |
| Script closes its page before failing                                                                                | Error with a separate screenshot warning |

Choose **Run suite** twice. Each suite must report 12 runs, 7 passed, 2 failed
and 3 errors. The three drafts must not appear. A suite marked “Error” here is
the intended result, not a failed QA check.

Validate actual authenticated report endpoints after the suite finishes:

```bash
FLAREMENDER_TEST_PASSWORD='<local admin password>' pnpm manual:verify
```

The verifier signs in with a separate session, compares each run's JSON report
with the suite export and scenario expectations, checks JUnit counts, and
verifies anonymous and cross-organization access is denied. It creates and
deletes its own temporary organization without changing the browser session.
Set `FLAREMENDER_TEST_EMAIL` if the local instance uses a different admin email.
Do not commit real credentials.

## Manual acceptance sequence

1. Create a project and environment through the UI. Open **Create manually**;
   the code editor should be visible immediately.
2. Save an assertion-free script. Run it with **Save and run** and confirm its
   exact saved version is reported as a draft check. It must not become ready.
3. Enter code and a version note; switch between Script, Runs and History.
   Both edits should survive. Navigation away and regeneration should prompt
   before discarding them.
4. Mark a saved script ready. An assertion-free script must display a coverage
   warning; an author can still explicitly choose readiness.
5. Introduce a failed expectation. Confirm the report shows the recorded error,
   failed step, screenshot and trace link. Logs should start collapsed.
6. Save or restore another version. It must be a draft with no inherited pass.
   The old run must retain its original version and environment.
7. Set a schedule while the test is a draft; it must show paused. Mark it ready
   to enable the schedule. Remove walkthrough schedules afterward.
8. Run the dedicated artifact-failure draft. Its test error must remain distinct
   from the screenshot collection warning.
9. Refresh historical Chat cards after their event channels expire. Finished
   generation, exploration and batch cards must resolve from their job IDs.
10. Review desktop and narrow screens, keyboard focus and both themes.

## Verification completed in this pass

- Four actual local workflow suites: `srun_4bdcce4a7da848c38c2c`,
  `srun_6cf341575d0743d39c56`, `srun_c8f615c030384c3d97e1` and
  `srun_3fe0398af9db4b308882`, all with the expected 7/2/3 results.
  The final suites use restored version 3 of the isolation
  test and an unused local port for a genuine connection-refused error.
- Actual JSON/JUnit export equality, anonymous 401 and cross-organization 404.
- Manual Guestbook creation, assertion-free draft execution, deliberate failed
  expectation with screenshot/trace evidence, note preservation across tabs,
  regeneration warning, schedule pause, manual readiness and version restore.
- UI project and environment creation, encrypted credential storage, a real
  artifact-failure draft with a separate screenshot warning and available trace,
  and historical Guestbook cards settling after refresh without live events.
- Desktop/light, dark theme, keyboard focus and 390px report/Overview review.
  Tab-scroll buttons work by keyboard; long report titles wrap and version,
  environment and export controls remain accessible without page overflow.
- Seventeen passing automated checks for additive migrations, metadata-based historical
  classification, version/result isolation, late completion, persistence retries,
  readiness filters, scheduling, assertion hints, artifact failures and report
  authorization, including an infrastructure-error/late-success race that must
  not attach contradictory evidence. Run with `pnpm test`.
- TypeScript, lint and production build have passed during implementation.
  Re-run `pnpm exec tsc --noEmit`, `pnpm lint` and `pnpm build` after further edits.

## Fresh AI validation and remaining limits

Fresh AI validation completed in **AI reliability lab**, using the dedicated
fixture and encrypted variable references. Exploration proposed nine scenarios
covering authentication, validation, duplicates, CRUD, special characters and
delayed saving. All nine generated scripts contain assertions and passed two
fresh regression suites: `srun_9fc13dca72ac47d985ea` (requested through Chat) and
`srun_1f92fdadfd9445fbb5ab` (started from Overview).

A tenth scenario required an intentionally nonexistent “Travel through time”
feature. The agent saved only partial setup, explained the missing feature, and
left the test draft. Its passing setup verification did not count as a regression
pass, and its JUnit export was skipped. After a server restart, generation and
batch cards resolved to their persisted final states.

Add `FLAREMENDER_AI_PROJECT_ID=prj_cc8369fce4ad4712bdde` to the `manual:verify`
command above to validate this AI acceptance project too. The verifier checks
nine regression passes, exclusion of the impossible draft, skipped verification,
matching individual/suite reports and absence of the fixture credentials.

Observed AI limitations: one proposed validation message was inaccurate and was
corrected through the plan editor before generation. Chat also supplied a mistyped
environment ID once; authorization rejected it and Chat recovered using the
project's default environment. The missing-feature prefix contained unnecessary
sign-out/sign-in steps, so partial code still needs review before an author marks
it ready. None of these cases changed the requested expected behavior.

The development server occasionally lost TanStack server-function registrations
after repeated hot reloads. A clean local restart restored them. This was not
reproduced in the production build; avoid editing modules during acceptance jobs
and wait for HTTP readiness before reloading the browser. A production build is
not evidence that hot-reload behavior or production deployment has been tested.

Self-healing is **not implemented** in this milestone. Its implementation must
retain original failures, candidate diffs and immutable versions; default to
enabled with a per-test opt-out; and require review when preservation of expected
behavior is ambiguous. Never turn “make it pass” into weakening an assertion.

Deployment onboarding, billing, recorders and visual step editors remain outside
this milestone. Remote Cloudflare quotas, real cron delivery and provider limits
were not tested by the local fixtures.
