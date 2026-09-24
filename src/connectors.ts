import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const FILE = join(homedir(), ".narrowbit", "connectors.json");

function load(): Record<string, Connector> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(all: Record<string, Connector>): void {
  mkdirSync(join(homedir(), ".narrowbit"), { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
}

/** What the app page may see: names only, never the environment values (they are often tokens). */
export function publicConnector(c: Connector): { name: string; command: string; args: string[]; envKeys: string[] } {
  return { name: c.name, command: c.command, args: c.args, envKeys: Object.keys(c.env ?? {}) };
}

export function listConnectors(): Connector[] {
  return Object.values(load()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getConnector(name: string): Connector | null {
  return load()[name] ?? null;
}

export function saveConnector(name: string, command: string, args: string[], env?: Record<string, string>): Connector {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("a connector needs a name");
  if (!command.trim()) throw new Error("a connector needs a command to run");
  const c: Connector = { name: trimmedName, command: command.trim(), args, env: env && Object.keys(env).length ? env : undefined };
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
