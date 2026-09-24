import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * API keys for hosted providers. An environment variable (e.g. OPENROUTER_API_KEY) wins; otherwise
 * ~/.narrowbit/keys.json (0600, outside every repo so it can never be committed). Keys are only
 * ever read here and sent to that provider's own endpoint — never logged, never sent to the app page.
 */
const KEYS_FILE = join(homedir(), ".narrowbit", "keys.json");

function load(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(KEYS_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function getKey(provider: string, env?: string): string | undefined {
  const fromEnv = env ? process.env[env]?.trim() : undefined;
  return fromEnv || load()[provider] || undefined;
}

/** Where a provider's key would come from, without revealing it. */
export function keySource(provider: string, env?: string): "env" | "file" | null {
  if (env && process.env[env]?.trim()) return "env";
  return load()[provider] ? "file" : null;
}

export function setKey(provider: string, key: string | null): void {
  const keys = load();
  // A key is one short token; a pasted paragraph (or anything with spaces/non-ASCII) is a paste mistake
  // that would otherwise fail later with an opaque header error.
  if (key && (/\s/.test(key.trim()) || /[^\x21-\x7e]/.test(key.trim()) || key.trim().length > 500))
    throw new Error("That doesn't look like an API key (it has spaces or is far too long). Paste only the key itself.");
  if (key) keys[provider] = key.trim();
  else delete keys[provider];
  mkdirSync(join(homedir(), ".narrowbit"), { recursive: true, mode: 0o700 });
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  if (existsSync(KEYS_FILE)) chmodSync(KEYS_FILE, 0o600);
}
