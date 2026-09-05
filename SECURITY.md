# Security

Flaremender stores the credentials of the apps it tests and runs scripts written by
an AI agent. Please report anything that undermines either.

## What protects your credentials, and what does not

Flaremender stores the passwords to your app. Here is what guards them, and what
does not.

- **Tenancy.** Every organization-scoped server function goes through `orgMiddleware`,
  which reads the organization id from the session, never from the client, and
  re-checks membership on every call. Resources load through an org-joined query.
- **Secrets at rest.** Environment variables and provider API keys, both the
  instance's and each organization's own, are encrypted with AES-256-GCM under
  `ENCRYPTION_KEY`.
- **Secrets in flight.** `secret()` values become `***` in logs, step labels and
  error messages before anything is written down.
- **Script isolation.** Scripts run in a Dynamic Worker with `globalOutbound: null` and
  no D1, R2 or AI bindings.

The gaps:

- **Screenshots and traces can still show a secret.** No string redaction can fix a
  visual leak. Treat run artifacts as sensitive.
- **The browser binding reaches the whole account.** A hostile script can get at
  more than the `{ page, expect, secret }` context suggests, because the script is a
  module of the same Dynamic Worker that holds the browser binding. Only let people
  write scripts if you would hand them the credentials anyway.
- **A password pasted into chat reaches the model provider once**, in that message
  and in the tool call that stores it, before redaction takes over.

## Reporting

Open a [security advisory](https://github.com/bimsina/flaremender/security/advisories/new)
rather than a public issue. I will confirm receipt, agree a fix window with you, and
credit you in the release notes unless you would rather I did not.

This is a spare-time project with one maintainer, so please do not expect a same-day
reply.

## What is in scope

- Reading or writing another organization's projects, tests, runs or environments.
- Recovering a stored credential in plain text: from the UI, an export, a run
  artifact, a log line, or the database.
- Escaping the Dynamic Worker sandbox that runs test scripts, or reaching a binding
  from inside it that the sandbox is not supposed to hold.
- Bypassing the webhook API key check, or using one project's key against another.
- Using an MCP OAuth token outside the organization or scopes it was granted for,
  or getting a token issued without the consent page.
- Privilege escalation to instance admin.
- Making a repaired script current without the `auto` policy or a person accepting it.

## Known and documented

The gaps listed above are known and written down on purpose. Reports that restate
them are welcome, but will be closed as known rather than fixed twice.

## Running your own instance

Set `ENCRYPTION_KEY` to 32 random bytes and never rotate it in place. Set
`DISABLE_SIGNUP=true` once your team has accounts. Put an authenticating proxy such
as Cloudflare Access in front of any instance that does not need to be public.
