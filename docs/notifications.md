# Notifications

Flaremender tells you when a test fails, when a suite finishes and when the agent
has repaired something. It can do that through a signed webhook, a Slack or Discord
channel, or an email. Destinations live under a project's Settings tab. The
organization's owners and admins manage them.

## Events

| Event            | When                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| `run.failed`     | A regression run of a ready test failed on its own, outside a suite             |
| `run.error`      | A regression run could not finish: the browser or the environment was missing   |
| `run.passed`     | A regression run passed, outside a suite                                        |
| `suite.failed`   | A suite finished with at least one failure or error                             |
| `suite.passed`   | A suite finished green                                                          |
| `repair.pending` | The agent repaired a failed test and the repaired version is waiting for review |
| `repair.adopted` | A repair verified and, under an `auto` policy, became the current version       |
| `repair.failed`  | The agent could not repair a failed test                                        |

Runs inside a suite do not fire `run.*` events. The suite fires once with its
failures listed, so a scheduled suite of forty tests is one message, not forty.
Draft checks and the verification runs behind generation and repair never notify.

A new destination listens to `run.failed`, `run.error`, `suite.failed`,
`repair.pending` and `repair.adopted`. Change that per destination.

## Slack and Discord

Create an incoming webhook in Slack under **Apps > Incoming Webhooks**, or a channel
webhook in Discord under **Channel settings > Integrations > Webhooks**. Then add a
destination of that kind with the URL. Messages carry the headline, the environment,
the first line of the error and a link to the run. Use **Send test** on the row to
see one.

## Signed webhooks

A `webhook` destination receives every event as JSON, `POST`ed to your URL with
these headers:

```http
Content-Type: application/json
X-Flaremender-Event: run.failed
X-Flaremender-Delivery: dlv_…
X-Flaremender-Signature: t=1757040000,v1=<hex>
```

The signature is an HMAC-SHA256 of `<t>.<raw body>` under the secret shown once
when the destination was created. Verify it before you trust the body, and reject
anything older than a few minutes:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verify(secret, header, rawBody) {
  const [t, v1] = header.split(',').map((part) => part.split('=')[1])
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1))
}
```

The body is the event itself plus `schemaVersion`, `deliveryId` and `occurredAt`:

```json
{
  "schemaVersion": 1,
  "deliveryId": "dlv_…",
  "occurredAt": "2026-09-05T04:00:00.000Z",
  "type": "run.failed",
  "project": { "id": "prj_…", "name": "Storefront" },
  "run": {
    "id": "run_…",
    "status": "failed",
    "trigger": "schedule",
    "test": { "id": "int_…", "title": "Checkout completes with a test card" },
    "environment": { "id": "env_…", "name": "Production", "baseUrl": "https://shop.example.com" },
    "errorMessage": "locator.click: Timeout 30000ms exceeded…",
    "durationMs": 31240,
    "startedAt": "…",
    "finishedAt": "…",
    "url": "https://flaremender.example/projects/prj_…/runs/run_…",
    "reportUrl": "https://flaremender.example/api/reports/runs/run_…"
  }
}
```

`suite.*` events carry `suite` with `counts` and a `failures` list. `repair.*`
events carry `repair` with the test, the version, what broke and whether it was
adopted. The event types are defined in
[src/engine/notifications/events.ts](../src/engine/notifications/events.ts).

Flaremender tries each delivery twice. If the first response is not 2xx, it waits
three seconds and tries again. It logs the result on the destination row. Links in
the payload point at the origin the destination was created from.

## Email

Email goes through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/).
It is off until the instance opts in, because the binding needs an account with
Email Service set up:

1. Onboard a sending domain under **Compute > Email Service > Email Sending**. Until
   a domain is onboarded, Email Service only delivers to
   [verified destination addresses](https://developers.cloudflare.com/email-service/platform/limits/#verified-destination-addresses)
   in your account, which is fine for one team.
2. In `wrangler.jsonc`, uncomment the `send_email` binding and set
   `NOTIFY_FROM_ADDRESS` to an address on that domain.
3. Redeploy. Email destinations show as enabled on the project's Notifications card.

Without the binding, you can still create an email destination. Every delivery to
it is logged as failed with a message that says what is missing.

In local development the binding is simulated. `wrangler dev` writes each message
to a file under `.wrangler/` and prints its path instead of sending.
