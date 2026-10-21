/**
 * dsh-web-submit — DeepSeek Harness plugin.
 *
 * Lets an external command line (or any HTTP client) run a task through the
 * LIVE dsh web process instead of a separate headless process:
 *
 *   POST /x/headless            { task, cwd?, preset?, mode?, permission?,
 *                                 provider?, model?, reasoningEffort? } -> { sessionId, model }
 *   GET  /x/headless/status     ?sessionId=...  -> latest session events
 *   GET  /x/headless/events     ?sessionId=...  -> SSE live event stream
 *   GET  /x/headless/health                     -> plugin and credential state
 *
 * Because the session is created inside the web process itself, the Web UI
 * shows it in real time (same session store, same event stream), and
 * permission / approval questions appear in the Web UI for the user.
 *
 * Authentication. Since dsh 0.2.1-alpha.4 the /api RPC surface is fenced by
 * Connection.admit(), which requires the signed cookie minted from the
 * process launch token, and that token is process-local and never written to
 * disk. A plugin living inside the process therefore asks the connection
 * service for the tokenized URL (HostConnectionService.authenticatedUrl),
 * exchanges it once at /connect, and replays the resulting cookie on every
 * /api request. On harnesses whose /api is open on loopback the exchange is
 * skipped and requests go out bare, so the plugin keeps working there too.
 *
 * Loopback requests only (127.0.0.1 / localhost).
 */
import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export const name = "dsh-web-submit";

export const inject = ["webServer"];

/**
 * Verified dsh range. dsh's own plugin loader evaluates the same constraint
 * from this package's `dsh.engines.dsh` and refuses an incompatible install,
 * so this constant is the single source for both the manifest range and the
 * runtime check below (which catches a host that changed under an installed
 * plugin).
 */
export const SUPPORTED_DSH_RANGE = ">=0.2.1-alpha.4 <0.3.0";

export const Config = z.object({
  routePrefix: z.string().default("/x"),
  maxBodyBytes: z.number().default(1_048_576),
  pollIntervalMs: z.number().default(1500),
  /** Permission preset applied to submitted sessions without a body override. */
  defaultPermission: z.string().default(""),
  /** Submit anyway when the host dsh is outside SUPPORTED_DSH_RANGE. */
  allowUnsupportedDsh: z.boolean().default(false),
});

/** Parse `1.2.3` / `v1.2.3-rc.4`; undefined when the text is not a version. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(text ?? "").trim());
  if (match === null) return void 0;
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === void 0 ? [] : match[4].split("."),
  };
}

/** Semver ordering (numeric parts, then prerelease; a release outranks its prereleases). */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === void 0 || right === void 0) return void 0;
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] < right.nums[i] ? -1 : 1;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i += 1) {
    const p = left.pre[i];
    const q = right.pre[i];
    if (p === void 0) return -1;
    if (q === void 0) return 1;
    const pNumeric = /^\d+$/.test(p);
    const qNumeric = /^\d+$/.test(q);
    if (pNumeric && qNumeric) {
      const delta = Number(p) - Number(q);
      if (delta !== 0) return delta < 0 ? -1 : 1;
      continue;
    }
    if (pNumeric) return -1;
    if (qNumeric) return 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** Whether a dsh version falls inside SUPPORTED_DSH_RANGE. */
export function satisfiesDsh(version) {
  const low = compareVersions(version, "0.2.1-alpha.4");
  const high = compareVersions(version, "0.3.0");
  return low !== void 0 && high !== void 0 && low >= 0 && high < 0;
}

function readManifest(file) {
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    return typeof manifest.version === "string" ? manifest : void 0;
  } catch {
    return void 0;
  }
}

/**
 * Best-effort host dsh version. `DSH_VERSION` wins (containers, Desktop);
 * otherwise walk up from the launching entry point (the npm/pnpm `dsh` shim
 * resolves into `<...>/@deepseek-ai/dsh/lib/bin.js`), then try package
 * resolution. undefined means unknown — callers must not block on it.
 */
export function detectDshVersion() {
  const fromEnv = process.env.DSH_VERSION;
  if (typeof fromEnv === "string" && parseVersion(fromEnv) !== void 0) return fromEnv.trim();

  const starts = [];
  const entry = process.argv[1];
  if (typeof entry === "string" && entry !== "") {
    try {
      starts.push(realpathSync(entry));
    } catch {
      starts.push(entry);
    }
  }
  for (const start of starts) {
    let dir = dirname(start);
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = readManifest(join(dir, "package.json"));
      if (manifest !== void 0 && manifest.name === "@deepseek-ai/dsh") return manifest.version;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  try {
    const resolved = import.meta.resolve?.("@deepseek-ai/dsh/package.json");
    if (typeof resolved === "string" && resolved.startsWith("file:")) {
      const manifest = readManifest(decodeURIComponent(new URL(resolved).pathname));
      if (manifest !== void 0 && manifest.name === "@deepseek-ai/dsh") return manifest.version;
    }
  } catch {
    // not resolvable from a profile install — version stays unknown
  }
  return void 0;
}


function isLoopbackHost(host) {
  if (!host) return false;
  try {
    const u = new URL("http://" + host);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Type-only check for an optional body string: present means a non-empty
 * string (surrounding blanks stripped). Anything else is a caller mistake.
 */
function optionalString(value) {
  if (value === void 0 || value === null) return { present: false, ok: true, value: "" };
  if (typeof value !== "string") return { present: true, ok: false, value: "" };
  const trimmed = value.trim();
  return { present: true, ok: trimmed !== "", value: trimmed };
}

/** Every Set-Cookie the response carries, across Node versions. */
function readSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single === null ? [] : [single];
}

export async function apply(ctx, config) {
  const prefix = config.routePrefix.replace(/\/+$/, "");
  const HEADLESS = prefix + "/headless";
  const STATUS = prefix + "/headless/status";
  const EVENTS = prefix + "/headless/events";
  const HEALTH = prefix + "/headless/health";
  const ACTIVE = prefix + "/headless/active";
  const ADOPT = prefix + "/headless/adopt";

  // Host version gate: dsh's loader already refuses an install outside
  // `dsh.engines.dsh`; this catches a host swapped underneath a working
  // install. Unknown versions are reported, never blocked.
  const dshVersion = detectDshVersion();
  const dshCompatible = dshVersion === void 0 ? void 0 : satisfiesDsh(dshVersion);
  if (dshCompatible === false) {
    console.warn(
      "dsh-web-submit: host dsh " + dshVersion + " is outside the supported range " +
        SUPPORTED_DSH_RANGE + "; submissions are refused unless allowUnsupportedDsh is enabled",
    );
  }

  /** Signed browser/API credential for this process's /api surface, once minted. */
  let credential;
  let credentialExchange;

  function baseUrl() {
    const protocol = ctx.webServer.protocol ?? "http:";
    return protocol + "//127.0.0.1:" + ctx.webServer.port;
  }

  /**
   * Mint the /api credential from this process's own launch token: ask the
   * in-process connection service for the tokenized /connect URL, then keep
   * the cookie it sets. Returns false when the harness does not need one
   * (older 0.2.x, where /api is open on loopback).
   */
  async function exchangeCredential() {
    const connection = ctx.get("connection") ?? ctx.root?.get?.("connection");
    if (connection === void 0 || typeof connection.authenticatedUrl !== "function") return false;
    const connect = new URL("/connect", baseUrl());
    connect.searchParams.set("interactions", "answer");
    const res = await fetch(connection.authenticatedUrl(connect.href), {
      method: "GET",
      redirect: "manual",
    });
    if (res.status < 300 || res.status >= 400) {
      throw new Error("credential exchange failed: HTTP " + res.status);
    }
    const cookies = readSetCookies(res.headers)
      .map((value) => value.split(";")[0].trim())
      .filter(Boolean);
    if (cookies.length === 0) throw new Error("credential exchange returned no session cookie");
    credential = cookies.join("; ");
    return true;
  }

  function credentialReady() {
    if (credentialExchange === void 0) {
      credentialExchange = exchangeCredential().catch((error) => {
        credentialExchange = void 0;
        throw error;
      });
    }
    return credentialExchange;
  }

  /** One call to the harness's own /api surface, re-authenticating at most once. */
  async function apiFetch(path, init, retried = false) {
    const headers = { ...(init && init.headers) };
    if (credential !== void 0) headers.cookie = credential;
    const res = await fetch(baseUrl() + path, { ...init, headers });
    if (res.status === 401 && !retried) {
      credential = void 0;
      credentialExchange = void 0;
      await credentialReady();
      return apiFetch(path, init, true);
    }
    return res;
  }

  /**
   * Endpoint spelling each logical method is served under on this harness.
   * Old builds register "session.create"; current builds register the typert
   * spelling "session/create". The first successful call wins and is reused.
   */
  const wireEndpoints = new Map();

  /** Payload envelope: current builds wrap method arguments in { args }. */
  let wrapArgs = true;

  /**
   * Parameter name per method: the typert descriptor is stable per method but
   * has changed between releases ("request" up to 0.2.1-alpha.4, "_request"
   * from alpha.5), so it is negotiated once on the first descriptor error.
   */
  const wireParams = new Map();

  /** One RPC attempt against one exact endpoint spelling and envelope. */
  async function rpcOnce(method, endpoint, payload) {
    const used = wireParams.has(method) ? wireParams.get(method) : "request";
    const wrapped = used === null ? payload : { [used]: payload };
    const res = await apiFetch("/api/" + endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: randomUUID(),
        method: endpoint,
        payload: wrapArgs === true ? { args: wrapped } : wrapped,
      }),
    });
    const text = await res.text();
    if (res.status === 404) return { missing: true };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        "/api/" + endpoint + " returned HTTP " + res.status + ": " +
          (text.trim().slice(0, 200) || "(empty body)"),
      );
    }
    const result = body && body.result;
    if (!result || !result.ok) {
      const error = result && result.error;
      const message = error && error.message;
      if (typeof message === "string") {
        // Envelope rejected: the harness wants the bare payload, not {args}.
        if (message.includes("plain-object args field")) return { envelope: "bare" };
        // Param name rejected: "missing \"request\"" / "missing \"_request\"".
        const miss = message.match(/missing\s+"([\w$]+)"/);
        if (miss !== null) return { param: miss[1] };
      }
      throw new Error(
        message ? message : JSON.stringify(error || body || "rpc failed"),
      );
    }
    return { value: result.value, used };
  }

  /**
   * Two transports into the harness:
   * - "gateway": in-process typert gateway (dsh >= 0.2.1-rc.2) — no HTTP hop and
   *   no /api credential, but it needs the Host's owner Peer;
   * - "api": the process's own /api surface with the signed cookie minted from
   *   the launch token (older harnesses, or a gateway that is not ready).
   * The choice is made lazily, once, and then fixed: replaying create/prompt on
   * the other transport could run one task twice.
   */
  let transport;

  const connectionService = () => ctx.get("connection") ?? ctx.root?.get?.("connection");
  const gatewayService = () => ctx.get("typertGateway") ?? ctx.root?.get?.("typertGateway");

  function pickTransport() {
    if (transport !== void 0) return transport;
    const gateway = gatewayService();
    const connection = connectionService();
    transport =
      gateway !== void 0 && typeof gateway.invoke === "function" && connection?.browserPeer !== void 0
        ? "gateway"
        : "api";
    return transport;
  }

  /** "session.page" -> { namespace: "session", method: "page" }. */
  function splitRemote(method) {
    const separator = method.includes("/") ? "/" : ".";
    const at = method.indexOf(separator);
    if (at <= 0) throw new Error("unsupported remote method: " + method);
    return { namespace: method.slice(0, at), method: method.slice(at + 1) };
  }

  /**
   * One Remote call through the in-process gateway. The owner Peer comes from
   * the Host connection service: invoke() asserts `peer.signal` and reads
   * `peer.principal`, and only an owner principal skips remote-access checks.
   */
  async function gatewayCall(method, payload) {
    const gateway = gatewayService();
    const peer = connectionService()?.browserPeer;
    if (gateway === void 0 || peer === void 0) {
      throw new Error("typert gateway is unavailable in this process");
    }
    const remote = splitRemote(method);
    const invoke = (field) =>
      gateway.invoke({
        peer,
        namespace: remote.namespace,
        method: remote.method,
        args: { [field]: payload },
      });
    try {
      return await invoke("request");
    } catch (error) {
      // The descriptor's request field was renamed once already (`_request`).
      if (String((error && error.message) || error).includes('missing "_request"')) return invoke("_request");
      throw error;
    }
  }

  /** One harness RPC over the selected transport. */
  async function rpc(method, payload) {
    if (pickTransport() === "gateway") return gatewayCall(method, payload);
    const known = wireEndpoints.get(method);
    const candidates =
      known !== void 0
        ? [known]
        : method.includes(".")
          ? [method, method.replaceAll(".", "/")]
          : [method];
    for (const endpoint of candidates) {
      // A descriptor complaint is corrected in place and retried immediately;
      // the per-endpoint cap (envelope flip + param fix + one spare) guarantees
      // the loop terminates even if the harness keeps rejecting.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const outcome = await rpcOnce(method, endpoint, payload);
        if (outcome.missing === true) break;
        if (outcome.envelope !== void 0) {
          wrapArgs = !wrapArgs;
          continue;
        }
        if (outcome.param !== void 0) {
          wireParams.set(method, outcome.param);
          continue;
        }
        wireEndpoints.set(method, endpoint);
        if (!wireParams.has(method)) wireParams.set(method, outcome.used);
        return outcome.value;
      }
    }
    throw new Error(
      "/api/" + candidates.join(" and ") + ": not found or unsupported payload envelope",
    );
  }

  /** Inclusive log cut: a value at or beyond the newest sequence returns the tail. */
  const MAX_SEQ = 9007199254740991;

  /**
   * The Web UI groups sessions per workspace, so a session created with a bare
   * cwd never appears in its sidebar. Ask the workspace registry for the
   * workspace owning this path (creating it when absent) and cache its id;
   * harnesses without the workspace RPC return undefined and keep cwd creation.
   */
  const workspaceByPath = new Map();

  async function ensureWorkspace(path) {
    if (workspaceByPath.has(path)) return workspaceByPath.get(path);
    try {
      const created = await rpc("workspace.create", { path });
      const workspaceId = created && created.workspace ? created.workspace.workspaceId : void 0;
      if (workspaceId !== void 0) workspaceByPath.set(path, workspaceId);
      return workspaceId;
    } catch {
      return void 0;
    }
  }

  /**
   * Place an already-accounted session in the workspace order. The harness only
   * reorders existing members, so a session that was never accounted returns
   * false and the caller reports it instead of pretending success.
   */
  async function attachSession(sessionId, workspaceId) {
    try {
      await rpc("workspace.insertSessionBefore", { workspaceId, sessionId });
      return true;
    } catch {
      return false;
    }
  }

  /** The live Session instance for an id, through the in-process sessions service. */
  function liveSession(sessionId) {
    const sessions = ctx.get("sessions") ?? ctx.root?.get?.("sessions");
    return sessions !== void 0 && typeof sessions.get === "function"
      ? sessions.get(sessionId)
      : void 0;
  }

  /**
   * Apply one permission preset to a single live session. `danger-full-access`
   * carries approval=never, so unattended automation can run without sending
   * approval prompts to the Web UI.
   */
  function setSessionPermission(sessionId, preset) {
    const presets = ctx.get("permissionPresets") ?? ctx.root?.get?.("permissionPresets");
    const session = liveSession(sessionId);
    if (presets === void 0 || typeof presets.set !== "function" || session === void 0) return false;
    try {
      presets.set(session, preset);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a session event page. Current harnesses page a durable address
   * ("session.page"); older ones returned "session.history" directly.
   */
  async function readHistory(sessionId, maxMessages) {
    const request = {
      address: { kind: "session", sessionId },
      throughSeq: MAX_SEQ,
      maxMessages,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const page = await rpc("session.page", request);
        return { events: page.records || [], hasMore: !!page.hasMore };
      } catch (error) {
        const message = String((error && error.message) || error);
        // The log cut may not sit past the live cursor; the Host reports the cursor.
        const cursor = message.match(/past cursor (\d+)/);
        if (cursor !== null) {
          request.throughSeq = Number(cursor[1]);
          continue;
        }
        if (!message.includes("HTTP 404")) throw error;
        const history = await rpc("session.history", { sessionId, maxMessages });
        return { events: history.events || [], hasMore: !!history.hasMore };
      }
    }
    throw new Error("session.page rejected every log cut");
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: "prefix",
      path: prefix,
      handler: async (req, res) => {
        if (!isLoopbackHost(req.headers.host)) {
          sendJson(res, 403, { ok: false, error: "forbidden" });
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const path = url.pathname;

        // GET /x/headless/health : plugin and credential state.
        if (req.method === "GET" && path === HEALTH) {
          sendJson(res, 200, {
            ok: true,
            plugin: name,
            routePrefix: prefix,
            port: ctx.webServer.port ?? null,
            transport: pickTransport(),
            credential: credential === void 0 ? "pending" : "session-cookie",
            dshVersion: dshVersion ?? null,
            supportedDsh: SUPPORTED_DSH_RANGE,
            compatible: dshCompatible ?? null,
          });
          return;
        }

        // GET /x/headless/active : top-level sessions whose turn is still running.
        if (req.method === "GET" && path === ACTIVE) {
          try {
            const list = await rpc("session.list", {});
            const active = ((list && list.items) || [])
              .filter((item) => item.running === true && item.parentSessionId === void 0)
              .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
              .map((item) => ({
                sessionId: item.sessionId,
                cwd: item.cwd ?? null,
                updatedAt: item.updatedAt ?? null,
              }));
            sendJson(res, 200, { ok: true, count: active.length, active });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
          }
          return;
        }

        // POST /x/headless/adopt : register an existing session in its workspace.
        if (req.method === "POST" && path === ADOPT) {
          try {
            const body = await readBody(req, config.maxBodyBytes);
            const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
            if (!sessionId) {
              sendJson(res, 400, { ok: false, error: "missing 'sessionId'" });
              return;
            }
            const list = await rpc("session.list", {});
            const summary = ((list && list.items) || []).find((item) => item.sessionId === sessionId);
            const cwd = summary && summary.cwd;
            if (typeof cwd !== "string" || cwd === "") {
              sendJson(res, 404, { ok: false, error: "session not found or has no cwd" });
              return;
            }
            const workspaceId = await ensureWorkspace(cwd);
            if (workspaceId === void 0) {
              sendJson(res, 500, { ok: false, error: "cannot resolve a workspace for " + cwd });
              return;
            }
            const attached = await attachSession(sessionId, workspaceId);
            if (!attached) {
              sendJson(res, 409, {
                ok: false,
                sessionId,
                workspaceId,
                cwd,
                error: "session is not accounted in that workspace; the workspace API only reorders existing members",
              });
              return;
            }
            sendJson(res, 200, { ok: true, sessionId, workspaceId, cwd });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
          }
          return;
        }

        // POST /x/headless : create a session in the web process and prompt it.
        if (req.method === "POST" && path === HEADLESS) {
          if (dshCompatible === false && config.allowUnsupportedDsh !== true) {
            sendJson(res, 409, {
              ok: false,
              dshVersion,
              supportedDsh: SUPPORTED_DSH_RANGE,
              error:
                "host dsh " + dshVersion + " is outside the supported range " + SUPPORTED_DSH_RANGE +
                "; upgrade/downgrade dsh, install a matching plugin version, or set allowUnsupportedDsh=true to override",
            });
            return;
          }
          try {
            const body = await readBody(req, config.maxBodyBytes);
            const task = typeof body.task === "string" ? body.task.trim() : "";
            if (!task) {
              sendJson(res, 400, { ok: false, error: "missing 'task'" });
              return;
            }
            const providerField = optionalString(body.provider);
            const modelField = optionalString(body.model);
            const effortField = optionalString(body.reasoningEffort);
            const asked = providerField.present || modelField.present || effortField.present;
            if (asked && !(providerField.ok && modelField.ok && effortField.ok)) {
              sendJson(res, 400, {
                ok: false,
                error: "'provider', 'model' and 'reasoningEffort' must be non-empty strings",
              });
              return;
            }
            if (asked && (providerField.value === "" || modelField.value === "")) {
              sendJson(res, 400, {
                ok: false,
                error: "'provider' and 'model' are required once any of the three model fields is sent",
              });
              return;
            }
            const cwd = body.cwd || process.cwd();
            const workspaceId = await ensureWorkspace(cwd);
            const createReq = workspaceId === void 0 ? { cwd } : { workspaceId };
            if (body.preset) createReq.agentPreset = body.preset;
            const created = await rpc("session.create", createReq);
            if (workspaceId !== void 0) await attachSession(created.sessionId, workspaceId);
            // Model selection is session-scoped and applies from the next request
            // on, so it must land between create and prompt. All three fields
            // absent means no call at all, and no side effect either.
            let model = null;
            if (asked) {
              const selection = { provider: providerField.value, model: modelField.value };
              // Absent reasoningEffort stays absent: the harness resolves its own
              // default per model instead of being handed a made-up value.
              if (effortField.value !== "") selection.reasoningEffort = effortField.value;
              let picked;
              try {
                picked = await rpc("session.selectModel", {
                  sessionId: created.sessionId,
                  ...selection,
                });
              } catch (selectError) {
                const message = String((selectError && selectError.message) || selectError);
                // The harness exposes no session remove/delete RPC (its session
                // controller offers list/search/create/selectModel/modelCatalog/
                // rename/fork/prompt/updateQueue/cancel/attachment/page/
                // projections/openWorkspacePath only), so an orphan session is
                // returned to the caller instead of being cleaned up silently.
                sendJson(res, 500, {
                  ok: false,
                  sessionId: created.sessionId,
                  model: null,
                  cleanup: "unavailable",
                  error:
                    "model selection failed for the new session; session was created in the Web UI " +
                    "but no task was sent and it was not cleaned up automatically (the harness " +
                    "offers no session delete/remove RPC): " + message,
                });
                return;
              }
              // rpc() hands back the remote value unwrapped; use the harness's
              // normalized selection when it has the shape we expect, and the
              // requested values otherwise.
              const selected = picked && picked.selected;
              model = selected && typeof selected.provider === "string" && typeof selected.model === "string"
                ? {
                    provider: selected.provider,
                    model: selected.model,
                    reasoningEffort: selected.reasoningEffort ?? null,
                  }
                : {
                    provider: selection.provider,
                    model: selection.model,
                    reasoningEffort: selection.reasoningEffort ?? null,
                  };
            }
            const requestedPermission = typeof body.permission === "string"
              ? body.permission
              : config.defaultPermission;
            let permission = null;
            if (requestedPermission.trim() !== "") {
              permission = requestedPermission.trim();
              if (!setSessionPermission(created.sessionId, permission)) {
                sendJson(res, 500, {
                  ok: false,
                  sessionId: created.sessionId,
                  cleanup: "unavailable",
                  error:
                    "cannot apply permission preset '" + permission + "' to the new session; " +
                    "session was created in the Web UI but no task was sent and it was not " +
                    "cleaned up automatically (the harness offers no session delete/remove RPC)",
                });
                return;
              }
            }
            await rpc("session.prompt", {
              requestId: randomUUID(),
              sessionId: created.sessionId,
              mode: body.mode === "steer" ? "steer" : "queue",
              content: [{ type: "text", text: task }],
              clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
            sendJson(res, 200, {
              ok: true,
              sessionId: created.sessionId,
              agentPreset: created.agentPreset || null,
              permission,
              model,
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
          }
          return;
        }

        // GET /x/headless/status?sessionId=...
        if (req.method === "GET" && path === STATUS) {
          const sid = url.searchParams.get("sessionId");
          if (!sid) {
            sendJson(res, 400, { ok: false, error: "missing sessionId" });
            return;
          }
          try {
            const history = await readHistory(sid, 60);
            const events = (history.events || []).map((e) => {
              const ev = e.event || e;
              return { type: ev.type, seq: ev.seq, time: ev.time, data: ev.data };
            });
            sendJson(res, 200, {
              ok: true,
              sessionId: sid,
              events,
              hasMore: !!history.hasMore,
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
          }
          return;
        }

        // GET /x/headless/events?sessionId=...  (SSE live stream, poll-based)
        if (req.method === "GET" && path === EVENTS) {
          const sid = url.searchParams.get("sessionId");
          if (!sid) {
            sendJson(res, 400, { ok: false, error: "missing sessionId" });
            return;
          }
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write("retry: 2000\n\n");
          const seen = new Set();
          let sawEnd = false;
          let drain = 0;
          try {
            while (!res.writableEnded) {
              const history = await readHistory(sid, 40);
              for (const e of history.events || []) {
                const ev = e.event || e;
                if (seen.has(ev.seq)) continue;
                seen.add(ev.seq);
                const frame = { type: ev.type, seq: ev.seq, time: ev.time, data: ev.data };
                res.write("data: " + JSON.stringify(frame) + "\n\n");
                if (ev.type === "turn/end") {
                  sawEnd = true;
                  drain = 0;
                }
              }
              if (sawEnd) {
                drain += 1;
                if (drain >= 3) {
                  res.write("data: " + JSON.stringify({ type: "stream/end", sessionId: sid }) + "\n\n");
                  break;
                }
              }
              await new Promise((r) => setTimeout(r, config.pollIntervalMs));
            }
          } catch {
            // stream ends on error; client can fall back to /status
          } finally {
            res.end();
          }
          return;
        }

        sendJson(res, 404, { ok: false, error: "not found" });
      },
    }),
    "dsh-web-submit routes",
  );
}
