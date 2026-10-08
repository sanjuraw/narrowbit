import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * OAuth 2.1 sign-in for remote MCP servers (Linear, Slack, Notion, Atlassian…): discovery of the
 * server's authorization endpoints, dynamic client registration, authorization-code + PKCE via the
 * user's own browser, and refresh. Tokens live in ~/.narrowbit/oauth.json (0600) and are never sent to
 * the page; the app only learns "signed in or not". No client secret is used (public client + PKCE).
 */
interface Stored {
  /** The MCP server URL this token was issued for. A token is only ever sent to that exact server. */
  resource?: string;
  clientId: string;
  tokenEndpoint: string;
  access: string;
  refresh?: string;
  /** ms since epoch; 0 = unknown (treated as valid until the server says otherwise). */
  expiresAt: number;
}

const file = () => join(homedir(), ".narrowbit", "oauth.json");

function load(): Record<string, Stored> {
  try {
    return JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}
function save(all: Record<string, Stored>): void {
  mkdirSync(join(homedir(), ".narrowbit"), { recursive: true, mode: 0o700 });
  writeFileSync(file(), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  if (existsSync(file())) chmodSync(file(), 0o600);
}

const sameResource = (stored: string | undefined, url: string | undefined): boolean => {
  if (!stored || !url) return false;
  try {
    return new URL(stored).href === new URL(url).href;
  } catch {
    return false;
  }
};

/** Signed in to *this* server: a token issued for a different URL (the connector was edited to point elsewhere, or an
 * older entry that recorded no server) doesn't count — it would go to a destination the user never signed in to. */
export const isSignedIn = (name: string, url?: string): boolean => {
  const s = load()[name];
  return !!s?.access && sameResource(s.resource, url);
};
export function signOut(name: string): void {
  const all = load();
  delete all[name];
  save(all);
}

/**
 * fetch that never carries a request somewhere else: a redirect is followed only within the same origin (max 3, and a POST only
 * on 307/308, which keep the method). A sign-in server that answers a token request with a redirect to another origin would
 * otherwise receive the refresh token and client secret in the body.
 */
async function sameOriginFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let target = url;
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(target, { ...init, redirect: "manual" });
    if (r.status < 300 || r.status >= 400) return r;
    const loc = r.headers.get("location");
    await r.body?.cancel();
    if (!loc) return r;
    const next = new URL(loc, target);
    if (next.origin !== new URL(url).origin) throw new Error(`${new URL(url).host} redirected to another site (${next.host}); not followed`);
    const method = String(init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && r.status !== 307 && r.status !== 308) throw new Error(`${new URL(url).host} redirected a ${method}; not followed`);
    target = next.toString();
  }
  throw new Error(`${new URL(url).host} redirected too many times`);
}

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const r = await sameOriginFetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

interface AsMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

/**
 * An address a server advertises (where to register, where to exchange the code, where the browser goes) is used by this
 * machine or opened in your browser, so it must be a plain web address and not point somewhere the server has no business
 * sending you: never a link-local/metadata address (169.254.x.x, fe80::), and a loopback/private one only when the MCP
 * server you configured is itself local or private. Anything over plain http must be local too.
 */
function hostKind(host: string): "link-local" | "local" | "public" {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^169\.254\./.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return "link-local";
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || h === "0.0.0.0") return "local";
  return "public";
}

class UnsafeEndpoint extends Error {}

function assertSafeEndpoint(value: unknown, what: string, mcpUrl: string): string {
  let u: URL;
  try {
    u = new URL(String(value));
  } catch {
    throw new UnsafeEndpoint(`${what} is not a safe address (not a URL)`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UnsafeEndpoint(`${what} is not a safe address (${u.protocol} is not a web address)`);
  const kind = hostKind(u.hostname);
  if (kind === "link-local") throw new UnsafeEndpoint(`${what} is not a safe address (${u.hostname} is a link-local address)`);
  const mcpLocal = hostKind(new URL(mcpUrl).hostname) !== "public";
  if (kind === "local" && !mcpLocal) throw new UnsafeEndpoint(`${what} is not a safe address (${u.hostname} is a local address, but the server you configured isn't)`);
  if (u.protocol === "http:" && kind === "public") throw new UnsafeEndpoint(`${what} is not a safe address (plain http to a public host)`);
  return u.href;
}

/** Finds the authorization server for an MCP server URL (RFC 9728 protected-resource metadata, then RFC 8414). */
export async function discover(mcpUrl: string): Promise<AsMeta> {
  const u = new URL(mcpUrl);
  let issuer = u.origin;
  try {
    const rm = await getJson(`${u.origin}/.well-known/oauth-protected-resource`);
    if (Array.isArray(rm.authorization_servers) && rm.authorization_servers[0]) issuer = assertSafeEndpoint(rm.authorization_servers[0], "the authorization server", mcpUrl).replace(/\/+$/, "");
  } catch (e) {
    if (e instanceof UnsafeEndpoint) throw e;
    /* the MCP server may be its own authorization server */
  }
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    try {
      const m = await getJson(issuer + path);
      if (m.authorization_endpoint && m.token_endpoint) {
        return {
          authorization_endpoint: assertSafeEndpoint(m.authorization_endpoint, "the sign-in page", mcpUrl),
          token_endpoint: assertSafeEndpoint(m.token_endpoint, "the token address", mcpUrl),
          ...(m.registration_endpoint ? { registration_endpoint: assertSafeEndpoint(m.registration_endpoint, "the registration address", mcpUrl) } : {}),
        };
      }
    } catch (e) {
      if (e instanceof UnsafeEndpoint) throw e;
      /* try the next well-known path */
    }
  }
  throw new Error("this server doesn't advertise a sign-in flow Narrowbit can use (it may need an API token instead: add it as an Authorization header)");
}

interface Pending {
  name: string;
  url: string;
  verifier: string;
  clientId: string;
  tokenEndpoint: string;
  redirectUri: string;
  at: number;
}
const pending = new Map<string, Pending>();

const b64url = (b: Buffer) => b.toString("base64url");

/** Step 1: returns the URL to open in the user's browser. */
export async function startSignIn(name: string, mcpUrl: string, redirectUri: string): Promise<string> {
  const meta = await discover(mcpUrl);
  if (!meta.registration_endpoint) throw new Error("this server requires a pre-registered app (no dynamic registration); use an API token as an Authorization header instead");
  const reg = await getJson(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Narrowbit", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  if (!reg.client_id) throw new Error("registration didn't return a client id");
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
  pending.set(state, { name, url: mcpUrl, verifier, clientId: String(reg.client_id), tokenEndpoint: meta.token_endpoint, redirectUri, at: Date.now() });
  const q = new URLSearchParams({
    response_type: "code",
    client_id: String(reg.client_id),
    redirect_uri: redirectUri,
    state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    resource: mcpUrl,
  });
  return `${meta.authorization_endpoint}${meta.authorization_endpoint.includes("?") ? "&" : "?"}${q}`;
}

/** Step 2: the browser came back to our redirect URI. The one-time `state` ties it to a sign-in we started. */
export async function completeSignIn(state: string, code: string): Promise<string> {
  const p = pending.get(state);
  if (!p) throw new Error("this sign-in link is unknown or expired — start again from Connectors");
  pending.delete(state);
  const tok = await tokenRequest(p.tokenEndpoint, { grant_type: "authorization_code", code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier, resource: p.url });
  const all = load();
  all[p.name] = { resource: p.url, clientId: p.clientId, tokenEndpoint: p.tokenEndpoint, access: tok.access_token, refresh: tok.refresh_token, expiresAt: tok.expires_in ? Date.now() + Number(tok.expires_in) * 1000 : 0 };
  save(all);
  return p.name;
}

async function tokenRequest(endpoint: string, form: Record<string, string>): Promise<any> {
  const r = await sameOriginFetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(15_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`sign-in was refused (${j.error_description ?? j.error ?? r.status})`);
  return j;
}

/** A usable access token for this connector, refreshed when it has (nearly) expired. Null = not signed in. */
export async function accessToken(name: string, url: string, forceRefresh = false): Promise<string | null> {
  const all = load();
  const s = all[name];
  if (!s?.access || !sameResource(s.resource, url)) return null;
  const stale = forceRefresh || (s.expiresAt && Date.now() > s.expiresAt - 30_000);
  if (!stale) return s.access;
  if (!s.refresh) return forceRefresh ? null : s.access;
  try {
    const tok = await tokenRequest(s.tokenEndpoint, { grant_type: "refresh_token", refresh_token: s.refresh, client_id: s.clientId });
    all[name] = { ...s, access: tok.access_token, refresh: tok.refresh_token ?? s.refresh, expiresAt: tok.expires_in ? Date.now() + Number(tok.expires_in) * 1000 : 0 };
    save(all);
    return all[name].access;
  } catch {
    return null;
  }
}
