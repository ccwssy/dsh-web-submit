# dsh-web-submit

DeepSeek Harness plugin that lets you drive the **running** `dsh web` instance
from the command line — the task executes inside the web process, so the Web
UI shows it live (same session store, same event stream), and permission /
approval questions appear in the Web UI.

No separate headless process, no webhook glue: one plugin, six endpoints.

> 中文文档:[README.md](README.md)

## Quick orientation (callers, AI agents, scripts)

1. **A task is only visible in the Web UI if it runs inside the web process** — there are exactly
   two ways in: call this plugin's HTTP endpoints, or wrap `dsh headless "task"` with
   [`examples/headless-shim.sh`](examples/headless-shim.sh).
2. **A bare `dsh headless` is always a separate process**: invisible in the UI, no sidebar entry,
   no completion signal. **Installing the plugin does not change that** — the CLI resolves that
   subcommand before any plugin is loaded, so a plugin cannot intercept it.
3. **Unattended runs must pass `permission`** (or set `defaultPermission` in the plugin config);
   otherwise an approval step stalls waiting for a human. Decide success from `turn/end` →
   `reason.kind`, not from the HTTP 200 at submit time.
4. **Only dsh `>=0.2.1-alpha.4 <0.3.0` is supported**: dsh refuses to install the plugin outside
   that range, and submissions answer `409` at runtime (`health.compatible` tells you directly).

The sections below cover endpoints → install → usage in that order.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/x/headless` | `{"task": "...", "cwd": "...", "preset": "coding", "mode": "queue", "permission": "danger-full-access", "provider": "...", "model": "...", "reasoningEffort": "high"}` → `{"ok": true, "sessionId": "session-...", "model": {"provider": "...", "model": "...", "reasoningEffort": "high"}}`; the three model fields are optional — omit them to leave the model unspecified |
| `GET` | `/x/headless/status?sessionId=...` | Latest session events (non-streaming poll) |
| `GET` | `/x/headless/events?sessionId=...` | SSE live event stream; ends after `turn/end` |
| `GET` | `/x/headless/health` | Plugin state, credential mode and host version (`dshVersion` / `supportedDsh` / `compatible`) |
| `GET` | `/x/headless/active` | Sessions whose turn is still running (`{ok,count,active[]}`); check it before a restart |
| `POST` | `/x/headless/adopt` | `{"sessionId":"session-..."}`: re-register an existing session in the workspace matching its `cwd` |
| `POST` | `/x/headless/restart` | Exit so systemd relaunches the process (new transport, new plugin version). **Refused with `409` while a task is running, and when nothing supervises the process**; on success it answers `202` then calls `process.exit(75)` to trip `Restart=on-failure` |

Loopback requests only: every endpoint is refused unless the `Host` header is a
loopback authority (`127.0.0.1` / `localhost`). That is a loopback check, not an
additional credential — the endpoints serve a local CLI, and the signed cookie
the plugin needs for `/api` is minted by the plugin itself (next section).

## How it talks to the harness

The plugin runs inside the `dsh web` process and has two channels. **One is picked on first use and
then fixed**:

| Channel | Available when | Mechanism |
|---|---|---|
| `gateway` (preferred) | `typertGateway` exists and `connection.browserPeer` is available (dsh >= 0.2.1-rc.2) | `gateway.invoke({ peer, namespace, method, args: { request } })` — in-process, no HTTP hop and no cookie; the owner Peer comes from the connection service because `invoke()` asserts `peer.signal` |
| `api` (fallback) | either of the above is missing (older harness) | `/api` on this process with a signed cookie; a 401 drops and re-mints it once |

`GET /x/headless/health` reports the active channel in `transport`, the configured value in
`transportPreference`, and whether the in-process gateway plus owner Peer is currently usable in
`gatewayReady` (useful when `gateway` is forced on an environment that cannot provide it).

**Why it never switches on failure**: replaying `session/create` or `session/prompt` over the other
channel would submit the same task twice, so the choice is made once and a failing call is reported.

### Switching the channel in the Web UI

The plugin ships a client half: **Settings → General → “Headless transport”** (directly under
“Thinking language”) offers `Auto (gateway first)` / `gateway (in-process)` / `api (HTTP + signed cookie)`.
The choice is written to this plugin's entry in the profile's `cordis.patch.yml` (the `transport`
field), exactly like editing the config by hand.

- `transport` is a schemastery **volatile field**: once written, the next `pickTransport()` in the same
  process reads it without re-mounting the plugin.
- The channel is still **fixed once chosen**, so a process that has already submitted a task needs a
  `dsh web` restart to actually switch (the card's subtitle says so). After switching,
  `GET /x/headless/health` reports the new `transportPreference` immediately while `transport` keeps
  the old value until that restart.
- `DSH_WEB_SUBMIT_TRANSPORT` still wins over the UI/config write, and using it requires a restart.

### One-click restart (sidebar button)

The sidebar footer carries a **“重启 DSH”** button (a labelled row with a status line when the rail is
expanded, a round icon with a corner dot when it is collapsed). It takes **two clicks within 4 s**: the
footer corner is easy to hit by accident, so the first click only arms the button (red “确认重启?” plus a
pulsing icon) and it falls back after 4 s on its own. The confirmed click calls
`POST /x/headless/restart`; the process exits, systemd relaunches it, and the page reloads itself once
`health` answers again.

- The dot probes `GET /x/headless/health` every 5 s: green = online, red = offline (it goes red for a
  moment during the restart).
- **Refused while a task is running**: the host checks the running sessions from `session.list` and
  answers `409` when `count > 0`, so a channel switch never kills a live turn.
- **Only under a service manager**: `health.restartManaged` is the unit name (`dsh-web.service`); on a
  hand-started `dsh web` it is `null` and the endpoint answers `409` instead of taking the UI down.
- The “Headless transport” row in Settings carries the same restart button (with a second click to
  confirm), which is the natural place to restart right after switching the channel.

### Credential details of the `api` channel

It can do what an external CLI cannot: mint the `/api` credential from the process launch token.

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

## Supported dsh versions

**Supported range: `>=0.2.1-alpha.4 <0.3.0`** (tested on `0.2.1-alpha.4` and `0.2.1-rc.2`).
Outside it, two gates refuse the work:

1. **Install/startup, enforced by dsh itself**: `package.json`'s `dsh.engines.dsh` is evaluated by
   the dsh plugin loader, which refuses an incompatible install/startup and points at
   `dsh plugin allow-version` for an exact-version exemption. `peerDependencies` declares the
   same range.
2. **Runtime, enforced by the plugin**: `apply()` derives the host version (`DSH_VERSION` first,
   then the real path of `process.argv[1]` walked up to `@deepseek-ai/dsh/package.json`, then one
   import-resolution attempt). Outside the range, `POST /x/headless` answers `409` with
   `dshVersion` and `supportedDsh`, unless the plugin config sets `allowUnsupportedDsh: true`.
   **An undetectable version counts as unknown: reported, never blocked.**

| dsh version | `/api` authentication | Endpoints and arguments | Status |
|---|---|---|---|
| `0.2.1-alpha.4` / `0.2.1-rc.2` | Signed cookie required; the plugin mints it in-process from the launch token | typert endpoints `session/create`, `session/prompt`; arguments wrapped as `args.request`; history via `session.page` (`address` + `throughSeq`) | Verified end to end |
| `< 0.2.1-alpha.4` | `/api` is open on loopback; the exchange is skipped | dotted endpoints `session.create`, `session.prompt`; arguments at the payload top level; history via `session.history` | **Not supported**: the probe branch remains in code, but the manifest makes dsh refuse the install |
| `>= 0.3.0` | not verified | not verified | **Not supported**: widen after testing |

`GET /x/headless/health` reports `transport`, `dshVersion`, `supportedDsh` and `compatible`
(`compatible: null` means the version is unknown).

Node `>=20`. The only npm dependency the plugin itself needs is `@deepseek-ai/schemastery`;
`@deepseek-ai/dsh` is a host-provided peer marked `optional`, so pnpm does not drag the whole dsh
dependency tree in during install.
The plugin hard-codes neither generation: on the first call it probes outward
(endpoint spelling, `args` envelope, `request` envelope) and caches whatever
worked, so both harness generations keep working.

## Install

Two separate things — do not conflate them: the **plugin** (required, provides the HTTP endpoints)
and the optional **shim** (makes `dsh headless` use those endpoints). `dsh plugin` installs the
plugin only: it does not — and cannot — register anything as a `dsh` command. (`dsh plugin` just
forwards its arguments to pnpm inside the profile directory; there is no postinstall hook to hang
that on, and it should not rewrite your PATH.)

### 1. Install the plugin (required)

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

Verify:

```bash
curl -s http://127.0.0.1:3080/x/headless/health
# {"ok":true,"plugin":"dsh-web-submit","routePrefix":"/x","port":3080,"credential":"session-cookie"}
```

### 2. Optional: install the shim (so `dsh headless "task"` goes through the plugin)

With the plugin alone, `dsh headless "task"` still starts a separate process: invisible in the UI,
no sidebar entry, no completion signal. If the caller (a human, or an AI/script) wants the in-process
behaviour while keeping the command line unchanged, install the shim:

```bash
install -m 0755 examples/headless-shim.sh ~/.local/bin/dsh
```

The shim must sit on PATH **ahead of** the real dsh (`~/.local/bin` usually qualifies; check the
order when `~/.npm-global/bin` is also on PATH):

```bash
type -a dsh
# dsh is /home/you/.local/bin/dsh       <- the shim, must come first
# dsh is /home/you/.npm-global/bin/dsh  <- the real CLI
```

`dsh headless "task"` then means: submit to the web process on 3080 → wait for `turn/end` → print the
final answer to stdout, with `sessionId` on stderr (for troubleshooting and for finding it in the UI).

| Input | Shim behaviour |
|---|---|
| `dsh headless "task"` / `dsh --profile headless "task"` | `POST /x/headless`, wait for `turn/end` |
| Task from stdin (`… \| dsh headless -`, or no arguments + a pipe) | Same, task text comes from stdin |
| `dsh headless --json` / `--session-id` / `-h` / `--help` | Passed through to the real CLI (no equivalent here) |
| Unknown option (e.g. `--foo`) | Passed through to the real CLI (never guesses) |
| Non-headless subcommand (`dsh web`, `dsh plugin …`) | Passed through to the real CLI |
| Plugin unavailable (health not 200 / submit failed) | Warns on stderr, then falls back to the real CLI (separate process) |

Extra task-level options the shim consumes (never forwarded to the real dsh):

| Option | Meaning |
|---|---|
| `-C, --cwd <dir>` | Working directory (also the sandbox write boundary); default `$PWD` |
| `--preset <name>` | Agent preset name; defaults to the profile default |
| `--permission <name>` | Permission preset; use `danger-full-access` for unattended runs |
| `--provider <id>` `--model <id>` | Select the model (both required together) |
| `--effort <level>` | `reasoningEffort` (`off`/`low`/`medium`/`high`/`max`; needs provider+model) |
| `--timeout <seconds>` | Upper bound for waiting on `turn/end`; default 3600 |

```bash
dsh headless --permission danger-full-access -C /path/to/repo "run the tests and report back"
echo "just reply OK" | dsh headless --permission danger-full-access   # task from stdin
```

Notes:

- Environment variables mirror the CLI: `DSH_WEB_SUBMIT_URL` (default `http://127.0.0.1:3080`),
  `DSH_HEADLESS_CWD`, `DSH_HEADLESS_TIMEOUT`, `DSH_HEADLESS_CLI` (path to the real dsh; set it when
  auto-detection fails or when it would resolve back to the shim itself).
- **Interactive/automation shells only.** systemd units launch `dsh` by absolute path and therefore
  bypass the shim — deliberately.
- Install under `~/.local/bin` only; do not shadow `/usr/local/bin/dsh` (that affects every user and
  every other caller).
- Uninstall: `rm ~/.local/bin/dsh`. The plugin is unaffected and the HTTP endpoints keep working.
- When the plugin is unavailable and the run falls back to the real CLI, shim-only options (`--cwd`,
  `--permission`, …) are forwarded verbatim and rejected there — deliberate: the shim never guesses.

## Real usage (end to end)

Pick the shape that matches whether you need to watch progress. Examples use `BASE=http://127.0.0.1:3080`.

With the shim installed, every HTTP shape below collapses into one command — handy for scripts and AI callers:

```bash
dsh headless --permission danger-full-access -C /path/to/repo "summarize the README and suggest improvements"
```

### A. Interactive: watch it run

```bash
BASE=http://127.0.0.1:3080

# 1) submit, capture the session id
SID=$(curl -s -X POST $BASE/x/headless \
  -H 'content-type: application/json' \
  -d '{"task":"summarize the README and suggest improvements","cwd":"/path/to/repo","preset":"coding"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionId"])')

# 2) follow it live (SSE; ends after turn/end)
curl -sN "$BASE/x/headless/events?sessionId=$SID"

# 3) or poll the latest events
curl -s "$BASE/x/headless/status?sessionId=$SID"
```

You can also follow nothing at all: once the task is submitted, **open the Web UI** —
the session shows up in the sidebar under its workspace, with the same live stream and
thinking timer as a task you typed by hand.
`preset` is a preset name configured in *your* profile (omit to use the profile default);
`cwd` is the task's working directory (and its sandbox write boundary).

### Choosing the model (optional)

A submission may carry `provider` / `model` / `reasoningEffort`, and the task then runs on that model:

| Field | Type | Meaning |
|---|---|---|
| `provider` | string | provider id |
| `model` | string | model id |
| `reasoningEffort` | string | optional, e.g. `off` / `low` / `medium` / `high` / `max`; when omitted the harness resolves the model's own default effort |

Validation is type-only (non-empty strings) and no model allow-list is kept: an unknown name is
rejected by the harness and its message is handed back unchanged. When **any** of the three fields is
present, `provider` and `model` must both be given (a lone `reasoningEffort` answers `400`).

```bash
# run this task on a specific model
curl -s -X POST http://127.0.0.1:3080/x/headless \
  -H 'content-type: application/json' \
  -d '{"task":"summarize the README and suggest improvements","cwd":"/path/to/repo","permission":"danger-full-access",
       "provider":"your-provider","model":"your/model-id","reasoningEffort":"high"}'
# -> {"ok":true,"sessionId":"session-...","agentPreset":null,"permission":"danger-full-access",
#     "model":{"provider":"your-provider","model":"your/model-id","reasoningEffort":"high"}}
```

The response's `model` is the selection that actually took effect (taken from the harness return
value, falling back to the requested values when that value is not shaped as expected); it is
**`null` when nothing was specified**. A failed model selection answers `500` with an `error`
body carrying the harness message, plus `sessionId` and `cleanup`; the session exists but **no task
was sent**, and this harness exposes no session delete/remove RPC, so the session stays in the Web UI
until it is removed by hand.

> **Side effect (pre-existing harness behaviour)**: specifying a model also **updates the default
> model selection** — the harness's `session.selectModel` persists the choice as the global default,
> so later submissions that carry no model fields will use the model you picked here.
> **Sending none of the three fields calls nothing and has no side effect**: existing callers behave
> exactly as before, apart from the new `model: null` in the response.

### B. Unattended: scripts / CI

**The key point**: pass `permission` at submit time (or set `defaultPermission` in the
plugin config — see below). Otherwise any step that needs approval will stall waiting for
a human, instead of being allowed.

```bash
#!/usr/bin/env bash
# Unattended submit -> wait -> exit status. 0 = completed, 1 = failed/aborted.
set -euo pipefail
BASE=${DSH_WEB_SUBMIT_URL:-http://127.0.0.1:3080}
TASK=${1:?usage: run-task.sh "task text" [cwd]}
CWD=${2:-$PWD}

BODY=$(python3 -c 'import json,sys; print(json.dumps({"task":sys.argv[1],"cwd":sys.argv[2],"permission":"danger-full-access"}))' "$TASK" "$CWD")
SID=$(curl -s -X POST "$BASE/x/headless" -H 'content-type: application/json' -d "$BODY" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("sessionId","") if d.get("ok") else "")')
[ -n "$SID" ] || { echo "submit rejected" >&2; exit 1; }
echo "sessionId=$SID" >&2

while :; do
  REASON=$(curl -s "$BASE/x/headless/status?sessionId=$SID" | python3 -c '
import json,sys
ev=(json.load(sys.stdin).get("events") or [])
for e in reversed(ev):
    if e.get("type")=="turn/end":
        print(((e.get("data") or {}).get("reason") or {}).get("kind","")); break
')
  case "$REASON" in
    "") sleep 2 ;;
    completed) echo "completed"; break ;;
    *) echo "ended: $REASON" >&2; exit 1 ;;
  esac
done
```

### Reading the result

The task's **final text** lives in the `assistant/message` events (take the last one):

```bash
curl -s "$BASE/x/headless/status?sessionId=$SID" | python3 -c '
import json,sys
ev=(json.load(sys.stdin).get("events") or [])
texts=[]
for e in ev:
    if e.get("type")!="assistant/message": continue
    m=(e.get("data") or {}).get("message") or {}
    t="".join(p.get("text","") for p in (m.get("content") or []) if p.get("type")=="text")
    if t.strip(): texts.append(t.strip())
print(texts[-1] if texts else "")'
```

Decide success from the `turn/end` event's `reason.kind` (`completed` is normal;
`aborted` / `failed` are not) — not from the HTTP 200 you got at submit time,
which only means the task was accepted.

The shim does this for you: it prints the last `assistant/message` text to stdout and exits
0 on `completed`, 1 otherwise.

### Troubleshooting checklist

| Want to confirm | How |
|---|---|
| The task really went through the plugin? | The session should appear in the Web UI sidebar under its workspace; landing in "ungrouped" means it ran via the bare `dsh headless` CLI (separate process) |
| Plugin loaded, credential mode | `GET /x/headless/health` -> `credential: session-cookie` (after the first successful call) |
| Any approval prompt / stall | `approval` occurrences in the session event stream should be 0 (when `permission` is set) |
| Anything running right now | `GET /x/headless/active` -> `{ok,count,active[]}` (check count=0 before restarting `dsh web`) |
| `dsh headless` ran but nothing appears in the sidebar | `type -a dsh`: the first entry must be `~/.local/bin/dsh`; `falling back to dsh headless CLI` on stderr means the plugin was unavailable and the run used a separate process |
| Shim says `real dsh not found` | Set `DSH_HEADLESS_CLI=/path/to/dsh`; it must not point at the shim itself (the script detects self-reference and refuses) |

## Permissions and unattended runs (`permission`)

`permission` names the permission preset a new session receives before `session/prompt`,
so the task runs under it from its first step:

| `permission` | Sandbox | Approval | Effect |
|---|---|---|---|
| omitted | profile default (`workspace-write` + `ask`) | prompts the Web UI | unattended runs stall; with no browser connected they fail closed as `unavailable` |
| `workspace-write` | `workspace-write` | `ask` | same as omitted, explicit |
| `danger-full-access` | `danger-full-access` | `never` | no approval request is ever sent: writes outside the workspace just succeed instead of asking for escalation |

```bash
# unattended: no approval request ever reaches the Web UI
curl -s -X POST http://127.0.0.1:3080/x/headless \
  -H 'content-type: application/json' \
  -d '{"task":"run the test suite and report the result","cwd":"/path/to/repo","permission":"danger-full-access"}'
```

Verify (the first events of the new session):

```bash
zstdcat ~/.dsh/sessions/<workspace>/<sessionId>/session.v4.jsonl*.zstd |
  grep -E '"type":"(permission/preset|sandbox/mode|approval/policy)"' | head -6
# permission/preset {"preset":"danger-full-access"}
# sandbox/mode      {"mode":"danger-full-access"}
# approval/policy   {"policy":"never"}
```

The name must be a preset key from the profile's `@deepseek-ai/dsh-permission-presets` config.
An unknown name makes the endpoint answer `500 cannot apply permission preset '<name>'`,
and the task is never submitted.

**Note**: `danger-full-access` also drops the file-sandbox boundary for that session and the
subagents it delegates to. When you only need "no approval card" and want to keep the sandbox,
move the task's output inside the session workspace instead of using this preset.

## Config

| Key | Default | Meaning |
|---|---|---|
| `routePrefix` | `/x` | Route prefix for all endpoints |
| `maxBodyBytes` | `1048576` | Max request body size |
| `pollIntervalMs` | `1500` | Poll interval behind the SSE stream |
| `defaultPermission` | `""` (off) | Permission preset applied to submitted sessions that carry no body override; the body's `permission` wins |
| `allowUnsupportedDsh` | `false` | Submit anyway when the host dsh is outside the supported range (default: refuse with `409`); `DSH_WEB_SUBMIT_ALLOW_UNSUPPORTED=1` is equivalent |
| `transport` | `"auto"` | `auto` (probe, gateway first) / `gateway` / `api`; switchable in **Settings → General → Headless transport** (volatile, read on write); the `DSH_WEB_SUBMIT_TRANSPORT` environment variable wins over the config |

## Changelog

See **[CHANGELOG.en.md](CHANGELOG.en.md)** for per-version changes.

## License

MIT