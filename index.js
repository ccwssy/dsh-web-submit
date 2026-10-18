/**
 * dsh-web-submit — DeepSeek Harness plugin.
 *
 * Lets an external command line (or any HTTP client) run a task through the
 * LIVE dsh web process instead of a separate headless process:
 *
 *   POST /x/headless            { task, cwd?, preset?, mode? } -> { sessionId }
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

export const name = "dsh-web-submit";

export const inject = ["webServer"];

export const Config = z.object({
  routePrefix: z.string().default("/x"),
  maxBodyBytes: z.number().default(1_048_576),
  pollIntervalMs: z.number().default(1500),
});

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
  /**
   * Endpoint spelling each logical method is served under on this harness.
   * Old builds register "session.create"; current builds register the typert
   * spelling "session/create". The first successful call wins and is reused.
   */
  const wireEndpoints = new Map();

  /** Payload envelope: current builds wrap method arguments in { args }. */
  let wrapArgs = true;

  /** Parameter envelope: current typert methods take one named "request". */
  let requestEnvelope = true;

  /** One RPC attempt against one exact endpoint spelling and envelope. */
  async function rpcOnce(endpoint, payload) {
    const res = await apiFetch("/api/" + endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: randomUUID(),
        method: endpoint,
        payload: wrapArgs === true
          ? { args: requestEnvelope === true ? { request: payload } : payload }
          : requestEnvelope === true
            ? { request: payload }
            : payload,
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
      if (typeof message === "string" && message.includes("plain-object args field")) {
        return { envelope: "args" };
      }
      if (typeof message === "string" && message.includes('missing "request"')) {
        return { envelope: "request" };
      }
      throw new Error(
        message ? message : JSON.stringify(error || body || "rpc failed"),
      );
    }
    return { value: result.value };
  }

  /** In-process RPC against the harness's own /api surface. */
  async function rpc(method, payload, retried = false) {
    const known = wireEndpoints.get(method);
    const candidates =
      known !== void 0
        ? [known]
        : method.includes(".")
          ? [method, method.replaceAll(".", "/")]
          : [method];
    for (const endpoint of candidates) {
      const outcome = await rpcOnce(endpoint, payload);
      if (outcome.missing === true) continue;
      if (outcome.envelope !== void 0) {
        if (retried) throw new Error("unsupported RPC payload envelope");
        if (outcome.envelope === "args") wrapArgs = !wrapArgs;
        else requestEnvelope = !requestEnvelope;
        return rpc(method, payload, true);
      }
      wireEndpoints.set(method, endpoint);
      return outcome.value;
    }
    throw new Error("/api/" + candidates.join(" and ") + " returned HTTP 404: not found");
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

  /** Best-effort registration so the session appears in that workspace's list. */
  async function attachSession(sessionId, workspaceId) {
    try {
      await rpc("workspace.insertSessionBefore", { workspaceId, sessionId });
    } catch {
      // Already listed, or a harness without the RPC: nothing else to do.
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
            credential: credential === void 0 ? "pending" : "session-cookie",
          });
          return;
        }

        // POST /x/headless : create a session in the web process and prompt it.
        if (req.method === "POST" && path === HEADLESS) {
          try {
            const body = await readBody(req, config.maxBodyBytes);
            const task = typeof body.task === "string" ? body.task.trim() : "";
            if (!task) {
              sendJson(res, 400, { ok: false, error: "missing 'task'" });
              return;
            }
            const cwd = body.cwd || process.cwd();
            const workspaceId = await ensureWorkspace(cwd);
            const createReq = workspaceId === void 0 ? { cwd } : { workspaceId };
            if (body.preset) createReq.agentPreset = body.preset;
            const created = await rpc("session.create", createReq);
            if (workspaceId !== void 0) await attachSession(created.sessionId, workspaceId);
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
