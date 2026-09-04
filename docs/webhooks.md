# Webhook API

The webhook API starts Flaremender runs from CI or another server. Create a project API
key under Project Settings, Webhooks. The complete key is shown once.

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

Terminal test statuses are `passed`, `healed`, `failed`, and `error`. Terminal
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
