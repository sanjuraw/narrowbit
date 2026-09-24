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

export class SignInRequired extends Error {
  constructor(name: string) {
    super(`${name}: sign-in required — open Models & settings → Connectors and press Sign in`);
  }
}

export async function openHttpSession(c: Connector, timeoutMs: number): Promise<HttpSession> {
  if (!c.url) throw new Error(`${c.name}: no URL`);
  const url = c.url;
  let sessionId: string | null = null;
  let nextId = 1;
  const deadline = Date.now() + timeoutMs;

  const post = async (body: object, retryAuth = true): Promise<Response> => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(c.headers ?? {}) };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const token = await accessToken(c.name);
    if (token && !headers.authorization && !headers.Authorization) headers.authorization = `Bearer ${token}`;
    const left = Math.max(1000, deadline - Date.now());
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(left) });
    if (r.status === 401 && retryAuth && (await accessToken(c.name, true))) return post(body, false);
    if (r.status === 401) throw new SignInRequired(c.name);
    return r;
  };

  const readReply = async (r: Response, id: number): Promise<any> => {
    if (!r.ok) throw new Error(`${c.name}: server answered ${r.status}${r.status === 404 ? " (session expired?)" : ""}`);
    const type = r.headers.get("content-type") ?? "";
    const text = await r.text();
    if (type.includes("text/event-stream")) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try {
          const m = JSON.parse(data);
          if (m.id === id) return m;
        } catch {
          /* not a JSON event */
        }
      }
      throw new Error(`${c.name}: the server closed the stream without answering`);
    }
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
