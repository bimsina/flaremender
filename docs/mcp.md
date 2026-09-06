# MCP server

Flaremender is a Model Context Protocol (MCP) server. Connect it to Claude, Cursor,
ChatGPT, Claude Code or any other assistant that speaks MCP. The assistant can then
list your projects, write tests, run them, read the failures and ask for repairs. It
acts as you, inside one organization you choose.

The endpoint is `/mcp` on your instance, over Streamable HTTP, protected by OAuth
2.1. There is nothing to configure on the Flaremender side and no key to copy. The
assistant discovers the authorization server on its own, sends you to a consent
page, and gets a token that expires after an hour and refreshes itself.

## Connect an assistant

Give the assistant the URL:

```
https://flaremender.example.com/mcp
```

For Claude Code:

```bash
claude mcp add --transport http flaremender https://flaremender.example.com/mcp
```

For Claude.ai and Claude Desktop, add it under **Settings > Connectors > Add custom
connector**. For Cursor, add it to `mcp.json`:

```json
{
  "mcpServers": {
    "flaremender": { "url": "https://flaremender.example.com/mcp" }
  }
}
```

The first tool call opens a browser tab on your instance. Sign in with your normal
account if you are not already, pick the organization the connection may act in,
and allow it. The page names the client and lists the two scopes it can hold:

| Scope   | Lets the assistant                                                     |
| ------- | ---------------------------------------------------------------------- |
| `read`  | see projects, tests, runs and reports                                  |
| `write` | create tests, start runs, and ask the AI to generate or repair scripts |

A client that asks for no particular scope gets both. Every tool runs as you, so it
can reach exactly what you can reach and nothing more. Rows it creates are
attributed to you. Anything the assistant starts shows up in the dashboard like
anything a person starts, with the live browser, the run history and the
notifications the project has.

## Tools

| Tool              | Does                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_projects`   | Projects in the organization, with their environments and test counts                                                                                         |
| `list_tests`      | Tests in a project: status, whether a script exists, the latest run. Filter by status                                                                         |
| `get_test`        | One test in full: the intent, the current script, the last ten runs                                                                                           |
| `create_test`     | Add a test from a plain-English description, and by default generate its script straight away                                                                 |
| `generate_test`   | Write or rewrite a test's script by performing the flow in a real browser                                                                                     |
| `explore_project` | Send the agent to browse the app, propose the tests worth having, and generate all of them. Optional focus                                                    |
| `get_job`         | Poll a generation, exploration or repair: pending, succeeded or failed, with the script produced and its verification run                                     |
| `run_test`        | Run one ready test against an environment                                                                                                                     |
| `run_suite`       | Run every ready test in a project, or a chosen subset                                                                                                         |
| `get_run`         | One run's result: status, the step that failed and why, the diagnosis, the last log lines, a link to the screenshot and trace                                 |
| `get_suite_run`   | A suite run's counts and a one-line result per test                                                                                                           |
| `repair_run`      | Ask the agent to fix the script behind a failed run. The repaired version waits for a person unless the [heal policy](architecture.md#repairs) says otherwise |

Generation, exploration and repair are background jobs. The tool returns a job id,
and the assistant polls `get_job` until `pending` is false. Runs work the same way
with `get_run`. Every answer carries a `dashboardUrl`, so the assistant can hand you
a link to the full picture.

Tool errors come back as ordinary results with `isError` set and a sentence saying
what went wrong, the same sentence the dashboard would show. The assistant reads it
and adjusts. A missing environment variable, a test that has no script yet, or a run
that cannot be repaired because a newer script exists are all reported that way.

## Rate limits

Tool calls share the [webhook API](webhooks.md) limits, keyed by user: 120 reads and
10 triggers per minute. A tool that hits the limit says so, and the assistant should
wait a minute.

## Revoke a connection

Tokens live an hour and the refresh token rotates on every use. To cut a client off
for good, delete its grant from the `OAUTH_KV` namespace in the Cloudflare dashboard.
Grant keys are prefixed `grant:`. A "Connected assistants" page in Organization
settings, listing grants with a revoke button, is on the roadmap.

## What the deploy needs

The MCP server needs one binding the rest of the app does not: a KV namespace
called `OAUTH_KV`, which holds clients, grants and tokens. The Deploy button creates
it. By hand:

```bash
wrangler kv namespace create OAUTH_KV
```

Paste the id it prints into `kv_namespaces` in `wrangler.jsonc`. Locally, dev mode
creates one under `.wrangler/` on its own.

Clients register themselves through Dynamic Client Registration, which every MCP
client in wide use supports today. Client ID Metadata Documents, the newer scheme,
turn on once `global_fetch_strictly_public` is added to `compatibility_flags`. The
Worker logs a line at startup saying so.

## How it is built

`src/mcp/server.ts` defines the tools with the Agents SDK's stateless
`createMcpHandler` and `@modelcontextprotocol/server`. The tools reuse the same
actions the dashboard and the webhook API call. Nothing here has its own path into
the database. `src/mcp/authorize.ts` is the consent page, backed by the Better Auth
session. `src/server.ts` wraps both in `@cloudflare/workers-oauth-provider`, which
owns `/oauth/token`, `/oauth/register`, the `.well-known` discovery documents and
token validation. The props it encrypts into each token say who authorized the
connection, for which organization, with which scopes, and where the instance
lives. That is how tools know what to check and what links to hand back.
