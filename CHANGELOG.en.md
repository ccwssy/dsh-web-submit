# Changelog

This repository is a fork of `deepseek-ai/dsh-web-submit` (maintained by the maintainer).
Version numbers follow the plugin's own `package.json`. Usage and install: [README.en.md](README.en.md).

## v0.2.9

- **New client half (Web UI)**: **Settings → General → “Headless transport”** (under “Thinking
  language”) offers `Auto (gateway first)` / `gateway (in-process)` / `api (HTTP + signed cookie)` and
  writes this plugin's `transport` entry in the profile's `cordis.patch.yml` — identical to editing
  the config by hand.
- **`transport` is now a schemastery `.volatile()` field**, so the next `pickTransport()` in the same
  process reads the new value without re-mounting the plugin (`transportPreference` changed from an
  apply-time constant to a per-call read, and `health` reports it live). The channel is still chosen
  once and fixed — switching still needs a process restart.
- **New `POST /x/headless/restart`**: exit so systemd relaunches the process. Two guards: any running
  task (`session.list` running sessions, `count > 0`) answers `409`, and a process nothing supervises
  (no `INVOCATION_ID`, or no unit in its cgroup) also answers `409`. When allowed it answers `202`
  first, then calls `process.exit(75)` to trip `Restart=on-failure`. The cgroup parse takes the
  **innermost** unit — the path also contains `user@1000.service`, and taking the first match names
  the wrong unit.
- **“重启 DSH” button in the sidebar footer with a live status dot**: one click restarts (layout and
  colours follow [`1123762794/dsh-web-restart`](https://github.com/1123762794/dsh-web-restart), while
  the restart itself goes through this plugin's HTTP endpoint + systemd — no external script or
  PowerShell). The dot probes `GET /x/headless/health` every 5 s and the page reloads itself once the
  process is back. The settings row carries a second restart button that asks for a second click.
- **`health` gained `restartManaged`** (this process's unit name, `null` when unsupervised).
- `package.json` gained `exports["./client"]` and `dsh.client` (`platform: web`; injects
  `dsh-client-ui-settings`, `dsh-client-ui-settings-general`, `dsh-client-ui-sidebar`,
  `dsh-client-locale`).
- **Verified (dsh 0.2.1-rc.2, the production instance on 3080)**:
  1. the settings row renders; selecting `api` writes `transport: api` into
     `~/.dsh/profiles/web/cordis.patch.yml`, `health.transportPreference` flips to `api` immediately
     while `transport` stays `gateway` (no restart yet);
  2. after a restart `health.transport` is `api` (the forced channel takes effect);
  3. clicking the sidebar button logs `restart requested over HTTP; exiting for dsh-web.service to
     relaunch` → `Main process exited, code=exited, status=75/TEMPFAIL` → systemd `Started` again and
     the page reloaded to “重启 DSH / dsh 在线”;
  4. `health.restartManaged` reports `dsh-web.service`.

## v0.2.8

- **New in-process `gateway` transport (preferred)**: when `typertGateway` exists and
  `connection.browserPeer` is available, RPCs go through
  `gateway.invoke({ peer, namespace, method, args: { request } })` — no HTTP hop, no cookie, no 401
  re-mint. Otherwise the existing `/api` + signed-cookie channel is used. **The choice is made on
  first use and then fixed** (replaying create/prompt on the other channel would run a task twice).
- **`health` gains a `transport` field** (`gateway` / `api`) so the active channel is visible.
- **Verified** (throwaway profile, dsh 0.2.1-rc.2, port 3181): POST created a session and the task
  completed; `/status` returned 23 events including `assistant/message` and `turn/end`; `/events`
  streamed frames through `turn/end` and `stream/end`; `/active` reported `count=1` while running and
  `count=0` after; `/adopt` answered 200 for an accounted session, 409 for an unaccounted one and 404
  for an unknown id — same semantics as the HTTP channel.
- **New `transport` config (`auto` / `gateway` / `api`)** plus two ops switches:
  `DSH_WEB_SUBMIT_TRANSPORT` (overrides the channel) and `DSH_WEB_SUBMIT_ALLOW_UNSUPPORTED=1`
  (accept an out-of-range host). A bad environment can be rolled back to `api` by restarting with an
  environment variable, no code change. `health` also reports `transportPreference` and `gatewayReady`.
- The `api` channel stays as the fallback; its HTTP-specific logic (endpoint spelling / envelope /
  parameter probing, cookie exchange) is untouched.
- **Full verification matrix** (dsh 0.2.1-rc.2, throwaway profile, port 3181):
  1. `auto` → `transport: gateway`: POST completed, `/status` 23 events with `assistant/message`,
     `/events` 33 frames through `stream/end`, `/active` 1 → 0;
  2. submission with `provider`/`model`: response echoes `{deepseek-official, deepseek-flash}` and the
     task completes (`session.selectModel` works over the gateway);
  3. forced `transport=api`: task completes and `credential` becomes `session-cookie` (fallback intact);
  4. `DSH_VERSION=0.3.0`: `compatible=false`, POST answers `409` with `dshVersion`/`supportedDsh`;
  5. `DSH_VERSION=0.3.0` + `DSH_WEB_SUBMIT_ALLOW_UNSUPPORTED=1`: POST `200` and the task completes;
  6. `/adopt`: `200` for an accounted session, `404` for an unknown one (`409` for unaccounted, same as
     the HTTP channel).

## v0.2.7

- **The shim now works with plugin versions that have no `/health`**: a `404` health probe is treated
  as "older plugin, may still work" and submission is attempted; the fallback to the real CLI only
  happens when the submission itself is rejected. (Without this, the shim could never engage an
  older plugin, since it has no health endpoint.)
- **Terser diagnostics**: a rejected submission is reported as one line of at most 300 characters,
  instead of dumping a whole HTML error page onto stderr.
- Verified: the 0.2.7 plugin path works; against a fake backend answering `404` on `/health` and
  `501` on POST, the shim fell back to the `dsh headless` CLI and still produced the answer.

## v0.2.6

- **dsh version is now constrained**: `dsh.engines.dsh` (and `peerDependencies`) tightened from
  `>=0.2.0-rc.2` to `>=0.2.1-alpha.4 <0.3.0`, matching what was actually tested. dsh's plugin
  loader evaluates that range at install/startup and refuses an incompatible host (pointing at
  `dsh plugin allow-version` for an exact-version exemption).
- **Runtime self-check**: `apply()` derives the host version (`DSH_VERSION` → the real path of
  `process.argv[1]` walked up to `@deepseek-ai/dsh/package.json` → one import-resolution attempt).
  Outside the range, `POST /x/headless` answers `409` with `dshVersion`/`supportedDsh`. New config
  `allowUnsupportedDsh` (default `false`) overrides; an undetectable version is reported, not blocked.
- **New `health` fields**: `dshVersion`, `supportedDsh`, `compatible` (`null` = unknown).
- **Verified**: 8 version-comparison edge cases (alpha.3 / alpha.4 / rc.2 / 0.2.0 / 0.2.9 /
  0.3.0 / garbage) behave as intended; on dsh 0.2.1-rc.2 `detectDshVersion()` returns the real version.

## v0.2.5

- **`examples/headless-shim.sh` is now in the repository**: the reference shim that turns
  `dsh headless "task"` into `POST /x/headless`, previously only on the maintainer's machine.
  It accepts task-level options `-C/--cwd`, `--preset`, `--permission`, `--provider`/`--model`,
  `--effort` and `--timeout`; `--json`/`--session-id`/`-h`/`--help`, unknown options and
  non-headless subcommands are passed through to the real CLI; a failing health check warns and
  falls back; a self-referencing `DSH_HEADLESS_CLI` is detected so the shim can never exec itself.
- **Install docs rewritten (both languages)**: the plugin and the shim are two separate things —
  `dsh plugin` installs the plugin only and cannot register a `dsh` command (it just forwards
  arguments to pnpm inside the profile); a bare `dsh headless` stays a separate, UI-invisible
  process even with the plugin installed. Adds a caller-facing quick orientation, `type -a dsh`
  verification, the pass-through/fallback table and uninstall steps.
- **Verified**: dsh `0.2.1-rc.2` + plugin 0.2.4, the shim submitted real tasks via arguments and
  via stdin, with the expected stdout contract and exit codes; `--help`/`--version` pass through.

## v0.2.4

- **`POST /x/headless` takes an optional model**: the body accepts `provider` / `model` /
  `reasoningEffort`; when any of them is present the plugin calls `session.selectModel` between
  `session/create` and `session/prompt`, so the task runs on that model, and the response gains
  `model` (`null` when unspecified). An absent `reasoningEffort` stays absent from the request, so
  the harness resolves the model's own default effort.
- **Omitting them changes nothing**: with none of the three fields present the plugin never calls
  `session.selectModel`, so there is no side effect and existing callers keep working.
- **Failures are never silent**: a failed selection answers `500` with `error` (carrying the
  harness message), `sessionId` and `cleanup`, instead of reporting a submitted task; because this
  harness has no session-delete RPC, the body states plainly that the session was created, no task was
  sent, and nothing was cleaned up.

## v0.2.3

- **`defaultPermission` config**: give a permission preset name in the plugin config and every
  session submitted through `POST /x/headless` takes it (the body's `permission` wins); empty by
  default, so behaviour is unchanged. Set once to make an unattended entry never prompt.
- **Permission docs**: the endpoint table and the new "Permissions and unattended runs" section
  spell out the `permission` semantics, the verification command, and the sandbox cost.

## v0.2.2

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
