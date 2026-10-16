/*
 * dsh-web-submit usage example.
 *
 * Submits a task to the running dsh web instance and tails the live SSE
 * event stream for that session. Requires Node 20+ (global fetch).
 * Adjust the base URL, or set DSH_WEB_BASE, to match your web profile.
 */
const base = process.env.DSH_WEB_BASE ?? "http://127.0.0.1:3080";
const api = base + "/x/headless";

async function health() {
  const res = await fetch(api + "/health");
  return res.json();
}

async function submit(task, { cwd, preset, mode } = {}) {
  const res = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, cwd, preset, mode }),
  });
  return res.json();
}

async function tail(sessionId) {
  const res = await fetch(api + "/events?sessionId=" + encodeURIComponent(sessionId));
  if (!res.body) return;
  for await (const chunk of res.body) process.stdout.write(chunk.toString());
}

const info = await health();
if (!info.ok) {
  console.error("plugin not reachable:", info);
  process.exit(1);
}
console.log("plugin:", info.plugin, "| credential:", info.credential);

const { ok, sessionId, error } = await submit("Summarize the README", {
  cwd: process.cwd(),
  preset: "coding",
  mode: "queue",
});

if (!ok) {
  console.error("submission failed:", error);
  process.exit(1);
}
console.log("session created:", sessionId);
await tail(sessionId);
