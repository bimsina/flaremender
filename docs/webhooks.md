# Webhook API

The webhook API starts Flaremender runs from CI or another server, and can create tests
and generate their scripts. Create a project API key under Project Settings, Webhooks.
The complete key is shown once.

Set the host and key in your CI secret store:

```bash
export FLAREMENDER_URL="https://flaremender.example.com"
export FLAREMENDER_API_KEY="flm_pk_..."
```

Never put the key in a URL. Every request uses the Bearer header:

```http
Authorization: Bearer flm_pk_...
```

## Trigger a project

This snapshots every currently ready test and queues one suite run:

```bash
curl --request POST \
  --url "$FLAREMENDER_URL/api/v1/projects/prj_123/runs" \
  --header "Authorization: Bearer $FLAREMENDER_API_KEY" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: deploy-$CI_COMMIT_SHA" \
  --data '{}'
```

## Trigger one test

The test must be marked ready:

```bash
curl --request POST \
  --url "$FLAREMENDER_URL/api/v1/projects/prj_123/tests/int_123/runs" \
  --header "Authorization: Bearer $FLAREMENDER_API_KEY" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: test-$CI_COMMIT_SHA" \
  --data '{"environmentId":"env_123"}'
```

An empty body or omitted `environmentId` uses the project default environment.
The response is `202 Accepted` and includes an execution ID, `statusUrl`,
`reportUrl`, and dashboard link.

## Poll an execution

Poll the returned `statusUrl`. Queued and running responses include
`Retry-After: 3` and `pollAfterMs: 2500`.

```bash
curl --url "$FLAREMENDER_URL/api/v1/executions/run_123" \
  --header "Authorization: Bearer $FLAREMENDER_API_KEY"
```

Terminal test statuses are `passed`, `healed`, `failed`, and `error`; `healed` is a
failed run whose script the agent repaired and, under an `auto` repair policy, adopted.
Terminal
suite statuses are `passed`, `failed`, and `error`.

## Download reports

Reports become available when the execution finishes:

```bash
curl --url "$FLAREMENDER_URL/api/v1/executions/run_123/report?format=json" \
  --header "Authorization: Bearer $FLAREMENDER_API_KEY"

curl --url "$FLAREMENDER_URL/api/v1/executions/run_123/report?format=junit" \
  --header "Authorization: Bearer $FLAREMENDER_API_KEY"
```

API keys do not grant access to screenshots, traces, logs, or the dashboard.

## Idempotency and limits

`Idempotency-Key` is optional and may contain 1 to 128 visible ASCII characters
without spaces. Flaremender remembers it for 24 hours per API key. Repeating the same
request returns the original execution. Reusing it with different input returns
`409`.

Each key may make 10 trigger requests per minute and 120 status or report reads
per minute. A limited response returns `429` with `Retry-After: 60`.

For rotation, create the replacement key, update the calling system, verify one
request, then revoke the old key. Revoked keys cannot be restored.

## Creating and generating tests

These two endpoints, and the job endpoint they hand you, also accept a signed-in
browser session instead of a key, so a script on a developer's machine can use the
cookie the dashboard uses. Cookie-authenticated `POST`s must carry an `Origin` header
matching the instance.

Create a test from a plain-English description. It starts as a draft with no script:

```bash
curl --request POST \
  --url "$FLAREMENDER_URL/api/v1/projects/prj_123/tests" \
  --header "Authorization: Bearer $FLAREMENDER_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"title":"Visitor can sign in","description":"Sign in with APP_EMAIL and APP_PASSWORD. The Dashboard heading should be visible."}'
```

The response is `201 Created` with the test id and its dashboard link.

Start the agent that writes the script. It opens a real browser on the environment,
performs the flow and saves a version only if a full replay passes:

```bash
curl --request POST \
  --url "$FLAREMENDER_URL/api/v1/projects/prj_123/tests/int_123/generate" \
  --header "Authorization: Bearer $FLAREMENDER_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{}'
```

The response is `202 Accepted` with a job id and `statusUrl`. A test with a generation
already in flight answers `409 GENERATION_IN_FLIGHT`. Keys created before this endpoint
existed answer `403`; create a new key.

Poll the job. Queued and running responses include `Retry-After: 5` and
`pollAfterMs: 5000`:

```bash
curl --url "$FLAREMENDER_URL/api/v1/jobs/gen_123" \
  --header "Authorization: Bearer $FLAREMENDER_API_KEY"
```

Terminal job statuses are `succeeded` and `failed`. A finished job reports the model,
the number of turns, input and output tokens, the reason it stopped if it did, the
verification run's status, and whether the saved script ends in an assertion. It
never includes the script source; open the dashboard link for that.
