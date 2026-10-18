# dsh-web-submit

DeepSeek Harness plugin that lets you drive the **running** `dsh web` instance
from the command line — the task executes inside the web process, so the Web
UI shows it live (same session store, same event stream), and permission /
approval questions appear in the Web UI.

No separate headless process, no webhook glue: one plugin, four endpoints.

> 中文文档:[README.md](README.md)

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/x/headless` | `{"task": "...", "cwd": "...", "preset": "coding", "mode": "queue"}` → `{"ok": true, "sessionId": "session-..."}` |
| `GET` | `/x/headless/status?sessionId=...` | Latest session events (non-streaming poll) |
| `GET` | `/x/headless/events?sessionId=...` | SSE live event stream; ends after `turn/end` |
| `GET` | `/x/headless/health` | Plugin state and credential mode |
| `GET` | `/x/headless/active` | Sessions whose turn is still running (`{ok,count,active[]}`); check it before a restart |

Loopback requests only: every endpoint is refused unless the `Host` header is a
loopback authority (`127.0.0.1` / `localhost`). That is a loopback check, not an
additional credential — the endpoints serve a local CLI, and the signed cookie
the plugin needs for `/api` is minted by the plugin itself (next section).

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

The credential comes from inside the process, so nothing is configured by hand
and no token has to be copied around.

**RPC contract.** Old builds register dotted endpoints (`session.create`) with
arguments at the top level of the payload; current builds register the typert
spelling (`session/create`) with arguments wrapped as `args.request`, and read
history through `session.page` (which needs an `address` and an inclusive log
cut `throughSeq`). The plugin probes and remembers both the spelling and the
envelope this harness uses, so either generation works.

## dsh compatibility

| dsh version | `/api` authentication | Endpoints and arguments | Status |
|---|---|---|---|
| `0.2.1-alpha.4` (tested here) | Signed cookie required; the plugin mints it in-process from the launch token | typert endpoints `session/create`, `session/prompt`; arguments wrapped as `args.request`; history via `session.page` (`address` + `throughSeq`) | Verified end to end |
| earlier `0.2.x` | `/api` is open on loopback; the exchange is skipped | dotted endpoints `session.create`, `session.prompt`; arguments at the payload top level; history via `session.history` | Compatibility branch kept, not regression-tested per release |

`package.json` declares `dsh.engines.dsh >= 0.2.0-rc.2` and Node `>=20`. The only npm
dependency the plugin itself needs is `@deepseek-ai/schemastery`; `@deepseek-ai/dsh`
is a host-provided peer marked `optional`, so pnpm does not drag the whole dsh
dependency tree in during install.
The plugin hard-codes neither generation: on the first call it probes outward
(endpoint spelling, `args` envelope, `request` envelope) and caches whatever
worked, so both harness generations keep working.

## Install

Install this repository directly:

```bash
dsh plugin --profile web add git+https://github.com/ccwssy/dsh-web-submit.git
```

Or clone it first and install with an **absolute path** — `dsh plugin` runs pnpm
inside the profile directory (`$DSH_HOME/profiles/web`), so a relative `file:`
argument resolves there, not in the shell directory you are standing in:

```bash
git clone https://github.com/ccwssy/dsh-web-submit.git
dsh plugin --profile web add "file:$PWD/dsh-web-submit"
```

Windows: `dsh plugin --profile web add file:C:/path/to/dsh-web-submit` (use the absolute path you cloned to).

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

The `preset` in the example is your profile's own (use whatever preset name your
profile configures); omit it to take the profile's default preset.

While it runs, open the Web UI: the session is visible in real time, exactly
as if you had typed the task there.

## Config

| Key | Default | Meaning |
|---|---|---|
| `routePrefix` | `/x` | Route prefix for all endpoints |
| `maxBodyBytes` | `1048576` | Max request body size |
| `pollIntervalMs` | `1500` | Poll interval behind the SSE stream |

## Fork changes (ccwssy/dsh-web-submit, 0.2.1)

- **Fixed the dead `/api` path.** The plugin used to POST to `/api/<method>` with
  no credentials. Since dsh 0.2.1-alpha.4 that surface answers `401 unauthorized`
  (reproduced against a live 3080 instance), so `POST /x/headless` always failed
  with HTTP 500. The plugin now mints and replays the signed session cookie
  in-process, with one automatic re-authentication per request.
- **Adapted to the new RPC contract.** Current builds register the typert
  endpoints (`session/create`), wrap arguments as `args.request`, and page
  history through `session.page` (address plus an inclusive `throughSeq`, retried
  with the cursor the Host reports). The plugin probes and caches both the
  endpoint spelling and the envelope.
- **Added `GET /x/headless/health`** so a caller can tell whether the plugin is
  loaded and which credential mode is active.
- **Added `GET /x/headless/active`**, listing sessions whose turn is still running,
  so a restart can be deferred until nothing is in flight.
- **Sessions join the workspace**: creation first resolves `workspace/create` for
  the `cwd` and then creates the session under that `workspaceId`, so the Web UI
  sidebar lists headless sessions.
- **Clearer `/api` failures**: a non-JSON response (for example the 401 body) is
  reported as `HTTP <status>: <body>` instead of a JSON parse error.
- **Declared dependencies** (`@deepseek-ai/schemastery`, peer `@deepseek-ai/dsh`,
  Node `>=20`) instead of relying on host hoisting.
- Documentation: real install paths for Linux/macOS and Windows, config table
  completed, stale `ApiProxyService` claim removed, Chinese is now the default
  README language (this file is the English one).
- **Bilingual plugin description**: `package.json` `description` now carries the
  Chinese and English text in one line, visible in the GUI component panel and in
  plugin marketplaces.

Verified end to end on dsh 0.2.1-alpha.4: `POST /x/headless` creates the session and
queues the task, `/status` reads the full event list back, `/events` streams SSE.
The contract actually used is `session/create` (`request.cwd`,
`request.agentPreset`), `session/prompt` (`request: { requestId, sessionId,
mode: queue|steer, content }`), `session/page` (`request: { address,
throughSeq, maxMessages }`), with the
`{type: "server-response", rpcId, result: {ok, value}}` envelope.

## License

MIT
