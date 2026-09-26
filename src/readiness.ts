import { spawn } from "node:child_process";
import { keySource } from "./keys.js";
import { PROVIDER_INFO, PROVIDERS, type ProviderName } from "./providers/models.js";

/**
 * "What can I actually use right now?" — checked without spending any model usage, so a first-time
 * user (or `narrowbit doctor`) can be told exactly what to do instead of hitting "not logged in" on
 * their first task. Subscription CLIs are asked for their own login status; local servers are
 * probed on their default ports; API providers only report whether a key is present.
 */
export interface Readiness {
  claude: { installed: boolean; loggedIn: boolean; detail?: string };
  codex: { installed: boolean; loggedIn: boolean; detail?: string };
  antigravity: { installed: boolean; loggedIn: boolean; detail?: string };
  local: { ollama: { running: boolean; models: number }; lmstudio: { running: boolean; models: number } };
  keys: Partial<Record<ProviderName, boolean>>;
  /** Providers usable right now with no further setup beyond choosing models. */
  ready: ProviderName[];
  checkedAt: string;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; missing: boolean }> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (r: { code: number | null; out: string; missing: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const timer = setTimeout(() => {
      child.kill();
      done({ code: null, out, missing: false });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e: NodeJS.ErrnoException) => done({ code: null, out, missing: e.code === "ENOENT" }));
    child.on("close", (code) => done({ code, out, missing: false }));
  });
}

/** `claude auth status` prints JSON with `loggedIn`; anything unparseable counts as not logged in. */
export function parseClaudeAuth(text: string): boolean {
  try {
    return JSON.parse(text.slice(text.indexOf("{"))).loggedIn === true;
  } catch {
    return false;
  }
}

async function probe(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    const d: any = await res.json();
    return Array.isArray(d?.models) ? d.models.length : Array.isArray(d?.data) ? d.data.length : 0;
  } catch {
    return null;
  }
}

let cache: { at: number; value: Readiness } | null = null;

export async function checkReadiness(force = false): Promise<Readiness> {
  if (!force && cache && Date.now() - cache.at < 20_000) return cache.value;
  const claudeBin = process.env.NARROWBIT_CLAUDE ?? "claude";
  const codexBin = process.env.NARROWBIT_CODEX ?? "codex";
  const agyBin = process.env.NARROWBIT_AGY ?? `${process.env.HOME ?? ""}/.local/bin/agy`;
  const [c, x, g, ollama, lmstudio] = await Promise.all([
    run(claudeBin, ["auth", "status"], 8_000),
    run(codexBin, ["login", "status"], 8_000),
    run(agyBin, ["models"], 12_000),
    probe("http://127.0.0.1:11434/api/tags"),
    probe("http://127.0.0.1:1234/v1/models"),
  ]);
  const claude = c.missing
    ? { installed: false, loggedIn: false, detail: "Claude Code isn't installed — install it, then run `claude` and sign in." }
    : parseClaudeAuth(c.out)
      ? { installed: true, loggedIn: true }
      : { installed: true, loggedIn: false, detail: "Not logged in — run `claude auth login`." };
  const codex = x.missing
    ? { installed: false, loggedIn: false, detail: "Codex CLI isn't installed — install it, then run `codex login`." }
    : x.code === 0
      ? { installed: true, loggedIn: true }
      : { installed: true, loggedIn: false, detail: "Not logged in — run `codex login`." };
  // `agy models` lists the plan's models only when signed in; otherwise it asks to sign in.
  const antigravity = g.missing
    ? { installed: false, loggedIn: false, detail: "Antigravity CLI isn't installed — see antigravity.google/docs/getting-started (CLI tab), then run `agy` and sign in." }
    : g.code === 0 && /^[\w.-]+\t/m.test(g.out)
      ? { installed: true, loggedIn: true }
      : { installed: true, loggedIn: false, detail: "Not signed in — run `agy` in a terminal and sign in with Google." };
  const keys: Partial<Record<ProviderName, boolean>> = {};
  for (const prov of PROVIDERS) {
    const info = PROVIDER_INFO[prov];
    if (info.kind === "api") keys[prov] = !!keySource(prov, info.keyEnv);
  }
  const ready: ProviderName[] = [];
  if (claude.loggedIn) ready.push("claude");
  if (codex.loggedIn) ready.push("codex");
  if (antigravity.loggedIn) ready.push("antigravity");
  for (const [prov, has] of Object.entries(keys)) if (has) ready.push(prov as ProviderName);
  if (ollama !== null) ready.push("ollama");
  if (lmstudio !== null) ready.push("lmstudio");
  const value: Readiness = {
    claude,
    codex,
    antigravity,
    local: { ollama: { running: ollama !== null, models: ollama ?? 0 }, lmstudio: { running: lmstudio !== null, models: lmstudio ?? 0 } },
    keys,
    ready,
    checkedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), value };
  return value;
}

export function formatReadiness(r: Readiness): string {
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  const lines = [
    `${mark(r.claude.loggedIn)} Claude (subscription)   ${r.claude.loggedIn ? "ready" : r.claude.detail}`,
    `${mark(r.codex.loggedIn)} Codex (ChatGPT plan)     ${r.codex.loggedIn ? "ready" : r.codex.detail}`,
    `${mark(r.antigravity.loggedIn)} Antigravity (Google)    ${r.antigravity.loggedIn ? "ready" : r.antigravity.detail}`,
    `${mark(r.local.ollama.running)} Ollama (local)           ${r.local.ollama.running ? `running, ${r.local.ollama.models} model(s)` : "not running"}`,
    `${mark(r.local.lmstudio.running)} LM Studio (local)       ${r.local.lmstudio.running ? `running, ${r.local.lmstudio.models} model(s)` : "not running"}`,
  ];
  const withKeys = Object.entries(r.keys).filter(([, has]) => has).map(([p]) => p);
  lines.push(`${mark(withKeys.length > 0)} API keys                ${withKeys.length ? withKeys.join(", ") : "none set — free options: gemini, groq, openrouter (narrowbit keys set <provider>)"}`);
  lines.push("", r.ready.length ? `Ready to use: ${r.ready.join(", ")}` : "Nothing is ready yet — set up any one line above.");
  return lines.join("\n");
}
