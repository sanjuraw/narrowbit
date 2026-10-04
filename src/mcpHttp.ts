import type { Connector } from "./connectors.js";
import { accessToken } from "./oauth.js";

/**
 * MCP over HTTP ("streamable HTTP"): each JSON-RPC message is a POST to the server's URL; the reply is
 * either plain JSON or a short server-sent-event stream carrying it. A session id from `initialize` is
 * echoed back on later calls. Auth is a static header (an API token) and/or the OAuth token from
 * oauth.ts; a 401 triggers one refresh-and-retry, then a message saying to sign in.
 */
export interface HttpSession {
  request: (method: string, params?: unknown) => Promise<any>;
}

/** The most one connector reply may hold (the page of a tool result, a stream): more is refused rather than buffered. */
export const MAX_REPLY = 16 * 1024 * 1024;

export class SignInRequired extends Error {
  constructor(name: string) {
    super(`${name}: sign-in required — open Models & settings → Connectors and press Sign in`);
  }
}

export async function openHttpSession(c: Connector, timeoutMs: number, stop?: AbortSignal): Promise<HttpSession> {
  if (!c.url) throw new Error(`${c.name}: no URL`);
  const url = c.url;
  let sessionId: string | null = null;
  let nextId = 1;
  const deadline = Date.now() + timeoutMs;

  const post = async (body: object, retryAuth = true): Promise<Response> => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(c.headers ?? {}) };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const token = await accessToken(c.name, url);
    if (token && !headers.authorization && !headers.Authorization) headers.authorization = `Bearer ${token}`;
    const left = Math.max(1000, deadline - Date.now());
    // Redirects are followed by hand: a 307/308 to the same host is fine, anything else is refused — the headers (an API
    // key) and the request itself would otherwise go wherever the server points, and fetch only strips Authorization.
    let target = url;
    let r!: Response;
    for (let hop = 0; ; hop++) {
      r = await fetch(target, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: stop ? AbortSignal.any([AbortSignal.timeout(left), stop]) : AbortSignal.timeout(left) });
      if (r.status < 300 || r.status >= 400) break;
      const loc = r.headers.get("location");
      const next = loc ? new URL(loc, target) : null;
      if (!next || (r.status !== 307 && r.status !== 308) || hop >= 3) throw new Error(`${c.name}: the server answered ${r.status} with a redirect Narrowbit won't follow`);
      if (next.origin !== new URL(url).origin) throw new Error(`${c.name}: the server redirected to another host (${next.host}) — refusing to send the request and its credentials there`);
      target = next.href;
    }
    if (r.status === 401 && retryAuth && (await accessToken(c.name, url, true))) return post(body, false);
    if (r.status === 401) throw new SignInRequired(c.name);
    return r;
  };

  const readCapped = async (r: Response, name: string): Promise<string> => {
    if (!r.body) return "";
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) {
          total += value.length;
          if (total > MAX_REPLY) throw new Error(`${name}: the reply is too large (over ${MAX_REPLY / 1024 / 1024} MB) — refused`);
          chunks.push(value);
        }
        if (done) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  const readReply = async (r: Response, id: number): Promise<any> => {
    if (!r.ok) throw new Error(`${c.name}: server answered ${r.status}${r.status === 404 ? " (session expired?)" : ""}`);
    const type = r.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream") && r.body) {
      // Read the stream as it arrives and answer as soon as the matching response is in: a server may keep the
      // connection open after replying, and waiting for it to close would hang the call until the timeout.
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (value) total += value.length;
          if (total > MAX_REPLY) throw new Error(`${c.name}: the reply is too large (over ${MAX_REPLY / 1024 / 1024} MB) — refused`);
          if (value) buf += dec.decode(value, { stream: !done });
          const blocks = buf.split(/\r?\n\r?\n/);
          buf = done ? "" : (blocks.pop() ?? "");
          for (const block of blocks) {
            const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (!data) continue;
            try {
              const m = JSON.parse(data);
              if (m.id === id) return m;
            } catch {
              /* not a JSON event */
            }
          }
          if (done) break;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      throw new Error(`${c.name}: the server closed the stream without answering`);
    }
    const text = await readCapped(r, c.name);
    const m = JSON.parse(text);
    return Array.isArray(m) ? m.find((x: any) => x.id === id) : m;
  };

  const request = async (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    const r = await post({ jsonrpc: "2.0", id, method, params });
    const sid = r.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const m = await readReply(r, id);
    if (m?.error) throw new Error(String(m.error.message ?? `${method} failed`));
    return m?.result;
  };

  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "narrowbit", version: "0.1.0" } });
  // A notification has no reply (202); a failure here is harmless for servers that don't care.
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }).then((r) => r.text()).catch(() => "");
  return { request };
}
