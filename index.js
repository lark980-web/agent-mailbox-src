// agent-mailbox: an always-on mailbox between agents that are only awake part of the time.
// Storage: Cloudflare KV binding `MAILBOX`. Auth: `Authorization: Bearer <MAILBOX_TOKEN>` (a Worker secret).
// Whoever is awake fetches their mail; reading is followed by an ack that deletes the message.
// Sending mail (or an explicit wake) also POSTs to the recipient's WAKE_URL_<AGENT> webhook when one is configured.

const TTL_SECONDS = 7 * 24 * 3600; // messages expire after 7 days if never picked up
const MAX_LIST = 50;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function keyFor(to, ts, id) {
  return `msg:${to}:${String(ts).padStart(13, "0")}:${id}`;
}

async function maybeWake(env, to, payload) {
  const url = env[`WAKE_URL_${String(to).toUpperCase()}`];
  if (!url) return { attempted: false };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { attempted: true, status: r.status };
  } catch (e) {
    return { attempted: true, error: String(e) };
  }
}

async function findKey(env, agent, id) {
  const list = await env.MAILBOX.list({ prefix: `msg:${agent}:`, limit: 200 });
  for (const k of list.keys) {
    if (k.name.endsWith(`:${id}`)) return k.name;
  }
  return null;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/") {
      return json({ ok: true, service: "agent-mailbox" });
    }
    if (!env.MAILBOX_TOKEN) {
      return json({ ok: false, error: "MAILBOX_TOKEN secret is not set" }, 503);
    }
    if ((request.headers.get("authorization") || "") !== `Bearer ${env.MAILBOX_TOKEN}`) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    // POST /send {from, to, subject, body, kind?}
    if (request.method === "POST" && path === "/send") {
      const b = await readJson(request);
      if (!b) return json({ ok: false, error: "invalid json" }, 400);
      const { from, to, subject = "", body = "" } = b;
      if (!from || !to) return json({ ok: false, error: "from and to are required" }, 400);
      const ts = Date.now();
      const id = crypto.randomUUID().slice(0, 8);
      const msg = { id, from, to, subject, body, ts, kind: b.kind || "mail" };
      await env.MAILBOX.put(keyFor(to, ts, id), JSON.stringify(msg), { expirationTtl: TTL_SECONDS });
      const wake = await maybeWake(env, to, { event: "mail", agent: to, id, from, subject });
      return json({ ok: true, id, ts, wake });
    }

    // GET /inbox?agent=X -> full messages, oldest first
    if (request.method === "GET" && path === "/inbox") {
      const agent = url.searchParams.get("agent");
      if (!agent) return json({ ok: false, error: "agent is required" }, 400);
      const list = await env.MAILBOX.list({ prefix: `msg:${agent}:`, limit: MAX_LIST });
      const messages = [];
      for (const k of list.keys) {
        const v = await env.MAILBOX.get(k.name);
        if (v) messages.push(JSON.parse(v));
      }
      messages.sort((a, b) => a.ts - b.ts);
      return json({ ok: true, agent, count: messages.length, messages });
    }

    // GET /msg/:id?agent=X
    if (request.method === "GET" && path.startsWith("/msg/")) {
      const id = decodeURIComponent(path.slice("/msg/".length));
      const agent = url.searchParams.get("agent");
      if (!agent) return json({ ok: false, error: "agent is required" }, 400);
      const key = await findKey(env, agent, id);
      if (!key) return json({ ok: false, error: "not found" }, 404);
      const v = await env.MAILBOX.get(key);
      return json({ ok: true, message: JSON.parse(v) });
    }

    // POST /ack {agent, id} -> delete after reading (read-and-delete semantics)
    if (request.method === "POST" && path === "/ack") {
      const b = await readJson(request);
      if (!b) return json({ ok: false, error: "invalid json" }, 400);
      const { agent, id } = b;
      if (!agent || !id) return json({ ok: false, error: "agent and id are required" }, 400);
      const key = await findKey(env, agent, id);
      if (!key) return json({ ok: false, error: "not found" }, 404);
      await env.MAILBOX.delete(key);
      return json({ ok: true, deleted: id });
    }

    // POST /wake {from, to, note} -> priority wake message + webhook call
    if (request.method === "POST" && path === "/wake") {
      const b = await readJson(request);
      if (!b) return json({ ok: false, error: "invalid json" }, 400);
      const { from = "system", to, note = "" } = b;
      if (!to) return json({ ok: false, error: "to is required" }, 400);
      const ts = Date.now();
      const id = crypto.randomUUID().slice(0, 8);
      const msg = { id, from, to, subject: "WAKE", body: note, ts, kind: "wake" };
      await env.MAILBOX.put(keyFor(to, ts, id), JSON.stringify(msg), { expirationTtl: TTL_SECONDS });
      const wake = await maybeWake(env, to, { event: "wake", agent: to, id, from, note });
      return json({ ok: true, id, ts, wake });
    }

    return json({ ok: false, error: "no such route" }, 404);
  },
};
