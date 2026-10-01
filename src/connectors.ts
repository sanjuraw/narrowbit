import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSignedIn } from "./oauth.js";

/**
 * Connectors: arbitrary MCP servers the owned runtime (runtime.ts) can call out to — GitHub, Slack,
 * Linear, anything that ships an MCP server — the same idea as Claude Desktop's connector model, not
 * limited to Narrowbit's own nb_* tools. Global, not per-repo (one GitHub connection is reused across
 * every repository you work in, same scope as keys.ts's API keys), stored in
 * ~/.narrowbit/connectors.json (0600 — env commonly carries a token, e.g. GITHUB_TOKEN).
 *
 * Stdio transport only for now (spawn command+args, NDJSON-over-stdio, the same framing mcp.ts
 * already speaks as a server) — covers the common case (official servers are npm/uvx packages you
 * run locally) without also building an HTTP/SSE client; that's the natural next transport to add,
 * not a redesign, if a connector that needs it comes up.
 */
export interface Connector {
  name: string;
  /** Local (stdio) connectors run this command; remote ones have `url` instead and an empty command. */
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Remote MCP server (streamable HTTP). */
  url?: string;
  /** Static request headers for a remote server — typically `Authorization: Bearer <token>`. Secret. */
  headers?: Record<string, string>;
}

const file = () => join(homedir(), ".narrowbit", "connectors.json");

function load(): Record<string, Connector> {
  try {
    return JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

function save(all: Record<string, Connector>): void {
  mkdirSync(join(homedir(), ".narrowbit"), { recursive: true, mode: 0o700 });
  writeFileSync(file(), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
}

/** What the app page may see: names only, never the environment values (they are often tokens). */
export function publicConnector(c: Connector): { name: string; command: string; args: string[]; envKeys: string[]; url: string | null; headerKeys: string[]; signedIn: boolean } {
  return { name: c.name, command: c.command, args: c.args, envKeys: [...Object.keys(c.env ?? {})], url: c.url ?? null, headerKeys: Object.keys(c.headers ?? {}), signedIn: !!c.url && isSignedIn(c.name, c.url) };
}

export function listConnectors(): Connector[] {
  return Object.values(load()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getConnector(name: string): Connector | null {
  return load()[name] ?? null;
}

export function saveConnector(name: string, command: string, args: string[], env?: Record<string, string>, remote?: { url?: string; headers?: Record<string, string> }): Connector {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("a connector needs a name");
  const url = remote?.url?.trim();
  if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw new Error("the URL must start with https:// (or http:// for a local server)");
  if (!url && !command.trim()) throw new Error("a connector needs a command to run, or a URL for a remote server");
  const headers = remote?.headers && Object.keys(remote.headers).length ? remote.headers : undefined;
  const c: Connector = { name: trimmedName, command: url ? "" : command.trim(), args: url ? [] : args, env: env && Object.keys(env).length ? env : undefined, ...(url ? { url, headers } : {}) };
  const all = load();
  all[trimmedName] = c;
  save(all);
  return c;
}

export function removeConnector(name: string): boolean {
  const all = load();
  if (!(name in all)) return false;
  delete all[name];
  save(all);
  return true;
}
