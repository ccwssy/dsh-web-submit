# dsh-web-submit

DeepSeek Harness plugin that lets you drive the **running** `dsh web` instance
from the command line — the task executes inside the web process, so the Web
UI shows it live (same session store, same event stream), and permission /
approval questions appear in the Web UI.

No separate headless process, no webhook glue: one plugin, four endpoints.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/x/headless` | `{"task": "...", "cwd": "...", "preset": "standard", "mode": "queue"}` → `{"ok": true, "sessionId": "session-..."}` |
| `GET` | `/x/headless/status?sessionId=...` | Latest session events (non-streaming poll) |
| `GET` | `/x/headless/events?sessionId=...` | SSE live event stream; ends after `turn/end` |
| `GET` | `/x/headless/health` | Plugin state and credential mode |

Loopback requests only (`127.0.0.1` / `localhost`), same trust posture as the
built-in `/api` surface: every endpoint is refused unless the `Host` header is
a loopback authority.

## How it talks to the harness

The plugin runs inside the `dsh web` process, so it can do what an external CLI
cannot: mint the `/api` credential from the process launch token.

- **dsh >= 0.2.1-alpha.4** — `/api` is fenced by `Connection.admit()` and requires
  the signed browser/API cookie. The launch token is process-local and never
  written to disk, so the plugin asks the `connection` service for the tokenized
  URL (`HostConnectionService.authenticatedUrl`), exchanges it once at
  `GET /connect?token=...&interactions=answer`, and replays the resulting cookie
  on every `/api` request. A 401 drops the cookie and re-exchanges once.
- **older 0.2.x** — `/api` is open on loopback; the exchange is skipped
  automatically and requests go out bare.

Because the credential comes from inside the process, nothing is configured by
hand and no token has to be copied around.

## Install

```bash
dsh plugin --profile web add file:/path/to/dsh-web-submit
```

Windows: `dsh plugin --profile web add file:C:/path/to/dsh-web-submit`.

The bundle patch rule (`cordis.patch.yml`) is applied automatically by
`dsh plugin add`, so no manual edit to the host profile is needed.

Restart `dsh web` to load the plugin.

## Example (CLI)

```bash
# submit a task
curl -s -X POST http://127.0.0.1:3080/x/headless \
  -H 'content-type: application/json' \
  -d '{"task":"Summarize the README","cwd":"/home/me/project","preset":"coding"}'

# tail it live
curl -sN "http://127.0.0.1:3080/x/headless/events?sessionId=session-xxx"

# check the plugin is loaded and how it authenticated
curl -s http://127.0.0.1:3080/x/headless/health
```

While it runs, open the Web UI: the session is visible in real time, exactly
as if you had typed the task there.

## Config

| Key | Default | Meaning |
|---|---|---|
| `routePrefix` | `/x` | Route prefix for all endpoints |
| `maxBodyBytes` | `1048576` | Max request body size |
| `pollIntervalMs` | `1500` | Poll interval behind the SSE stream |

## Fork changes (ccwssy/dsh-web-submit, 0.2.0)

- **Fixed the dead `/api` path.** The plugin used to POST to `/api/<method>` with
  no credentials. Since dsh 0.2.1-alpha.4 that surface answers `401 unauthorized`
  (verified against a live 3080 instance), so `POST /x/headless` always failed
  with HTTP 500. The plugin now mints and replays the signed session cookie
  in-process, with one automatic re-authentication per request.
- **Added `GET /x/headless/health`** so a caller can tell whether the plugin is
  loaded and which credential mode is active.
- **Clearer `/api` failures**: a non-JSON response (for example the 401 body) is
  reported as `HTTP <status>: <body>` instead of a JSON parse error.
- **Declared dependencies** (`@deepseek-ai/schemastery`, peer `@deepseek-ai/dsh`,
  Node `>=20`) instead of relying on host hoisting.
- Documentation: real install paths for Linux/macOS and Windows, config table
  completed, stale `ApiProxyService` claim removed.

Verified RPC contract against dsh 0.2.1-alpha.4: `session.create` (`cwd`,
`agentPreset`), `session.prompt` (`mode: queue|steer`, `content`),
`session.history` (`maxMessages`), and the
`{type: "server-response", rpcId, result: {ok, value}}` envelope are unchanged.

## License

MIT
