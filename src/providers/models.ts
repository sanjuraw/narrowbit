import type { AgentConfig } from "../config.js";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sh } from "../util.js";
import { spawnSync } from "node:child_process";
import { getKey } from "../keys.js";

/**
 * Model selection for `narrowbit agent`, shared by every provider: which provider drives the
 * loop, and which model handles each phase (explore = before any edit, execute = editing and
 * verifying, escalate = stuck). Precedence: CLI flags > .narrowbit/config.json `agent` > the
 * built-in defaults below.
 *
 * Three kinds of provider: the two subscription CLIs (claude, codex), hosted APIs that bill per
 * token or have a free tier, and local model servers. Every API and local provider speaks the
 * OpenAI-compatible chat API, so one adapter (providers/openai-compat.ts) serves all of them.
 */
export const PROVIDERS = [
  "claude", "codex", "antigravity",
  "openrouter", "nvidia", "cloudflare", "groq", "gemini", "cerebras", "mistral", "github", "huggingface", "sambanova",
  "openai", "deepseek", "together", "fireworks", "xai",
  "ollama", "ollamacloud", "lmstudio", "freellmapi", "custom",
] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export const PHASES = ["explore", "execute", "escalate"] as const;
export type Phase = (typeof PHASES)[number];
export type ModelTiers = Record<Phase, string>;

export type ProviderKind = "subscription" | "api" | "local";

export interface ProviderInfo {
  label: string;
  kind: ProviderKind;
  /** Shown next to the name so free options are easy to find. */
  pricing: string;
  /** API providers with a usable free tier are grouped separately from paid-only ones. */
  free?: boolean;
  /** OpenAI-compatible base URL (api/local only); `custom` has none until configured. `{VAR}` is
   * filled from the environment (Cloudflare's URL contains the account id). */
  baseUrl?: string;
  /** Environment variable checked for the API key before ~/.narrowbit/keys.json. */
  keyEnv?: string;
  keyUrl?: string;
  hint?: string;
}

export const PROVIDER_INFO: Record<ProviderName, ProviderInfo> = {
  claude: { label: "Claude", kind: "subscription", pricing: "your Claude plan" },
  codex: { label: "Codex (GPT)", kind: "subscription", pricing: "your ChatGPT plan" },
  antigravity: { label: "Antigravity (Gemini, Claude)", kind: "subscription", pricing: "your Antigravity plan" },
  openrouter: {
    label: "OpenRouter",
    kind: "api",
    pricing: "free & paid models",
    free: true,
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys",
    hint: "Hundreds of models behind one key; ids ending in :free cost nothing (rate-limited).",
  },
  nvidia: {
    label: "NVIDIA NIM",
    kind: "api",
    pricing: "free for development",
    free: true,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    keyUrl: "https://build.nvidia.com",
    hint: "Hosted open models (Llama, Qwen, DeepSeek, Nemotron…); a free build.nvidia.com key is rate-limited.",
  },
  cloudflare: {
    label: "Cloudflare Workers AI",
    kind: "api",
    pricing: "free daily allowance",
    free: true,
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    keyEnv: "CLOUDFLARE_API_TOKEN",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    hint: "Needs your account id (dash.cloudflare.com → Workers AI): enter it below, or set CLOUDFLARE_ACCOUNT_ID. Model ids look like @cf/meta/llama-3.3-70b-instruct-fp8-fast.",
  },
  cerebras: { label: "Cerebras", kind: "api", pricing: "free tier", free: true, baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY", keyUrl: "https://cloud.cerebras.ai" },
  mistral: { label: "Mistral", kind: "api", pricing: "free tier", free: true, baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", keyUrl: "https://console.mistral.ai/api-keys" },
  github: {
    label: "GitHub Models",
    kind: "api",
    pricing: "free, rate-limited",
    free: true,
    baseUrl: "https://models.github.ai/inference",
    keyEnv: "GITHUB_TOKEN",
    keyUrl: "https://github.com/settings/tokens",
    hint: "Uses a GitHub token with the models:read permission. Model ids look like openai/gpt-4.1 or meta/llama-4-scout.",
  },
  huggingface: { label: "Hugging Face", kind: "api", pricing: "free monthly credits", free: true, baseUrl: "https://router.huggingface.co/v1", keyEnv: "HF_TOKEN", keyUrl: "https://huggingface.co/settings/tokens" },
  sambanova: { label: "SambaNova", kind: "api", pricing: "free tier", free: true, baseUrl: "https://api.sambanova.ai/v1", keyEnv: "SAMBANOVA_API_KEY", keyUrl: "https://cloud.sambanova.ai/apis" },
  groq: { label: "Groq", kind: "api", pricing: "free tier", free: true, baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", keyUrl: "https://console.groq.com/keys" },
  gemini: {
    label: "Google Gemini",
    kind: "api",
    pricing: "free tier",
    free: true,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  openai: { label: "OpenAI API", kind: "api", pricing: "paid", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", keyUrl: "https://platform.openai.com/api-keys" },
  deepseek: { label: "DeepSeek", kind: "api", pricing: "paid (low cost)", baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY", keyUrl: "https://platform.deepseek.com/api_keys" },
  together: { label: "Together AI", kind: "api", pricing: "paid", baseUrl: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY", keyUrl: "https://api.together.ai/settings/api-keys" },
  fireworks: { label: "Fireworks AI", kind: "api", pricing: "paid", baseUrl: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY", keyUrl: "https://fireworks.ai/account/api-keys" },
  xai: { label: "xAI (Grok)", kind: "api", pricing: "paid", baseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY", keyUrl: "https://console.x.ai" },
  ollama: {
    label: "Ollama",
    kind: "local",
    pricing: "free, on this Mac",
    baseUrl: "http://127.0.0.1:11434/v1",
    hint: "Start Ollama and pull a coding model first. Its default context window is small; set OLLAMA_CONTEXT_LENGTH=32768 before `ollama serve`, or long reads get cut off silently.",
  },
  lmstudio: { label: "LM Studio", kind: "local", pricing: "free, on this Mac", baseUrl: "http://127.0.0.1:1234/v1", hint: "Load a model in LM Studio and start its local server (Developer tab)." },
  ollamacloud: {
    label: "Ollama Cloud",
    kind: "api",
    pricing: "free starter credits, then paid",
    free: true,
    baseUrl: "https://ollama.com/v1",
    keyEnv: "OLLAMA_API_KEY",
    keyUrl: "https://ollama.com/settings/keys",
    hint: "Large open models (DeepSeek, Kimi, GLM, GPT-OSS…) hosted by Ollama; nothing to install. Create a free key at ollama.com. The free tier allows one request at a time.",
  },
  freellmapi: {
    label: "FreeLLMAPI (your own gateway)",
    kind: "api",
    pricing: "free tiers pooled behind one key",
    free: true,
    baseUrl: "http://localhost:3001/v1",
    keyEnv: "FREELLMAPI_API_KEY",
    keyUrl: "https://github.com/tashfeenahmed/freellmapi",
    hint: "A gateway you run yourself (github.com/tashfeenahmed/freellmapi, port 3001). Paste the freellmapi-… key from its dashboard. Model \"auto\" lets it pick per request; a fixed model name is more predictable for an agent.",
  },
  custom: { label: "Custom endpoint", kind: "api", pricing: "any OpenAI-compatible server", hint: "Set its base URL (and a key, if it needs one)." },
};

// Codex tiers follow its own catalog descriptions: Luna "fast and affordable", Terra "balanced
// for everyday work", Sol "latest frontier" — the same shape as Haiku / Sonnet / Opus. API and
// local providers have no default: model catalogs there change constantly, so the user picks.
export const DEFAULT_TIERS: Record<ProviderName, ModelTiers> = {
  // Sonnet for everything but the lead/escalation slot. Measured on the Hono tasks (27 finished): Sonnet alone passed 26/27 with
  // 62k mean input and $0.12/task; Haiku 4.5 alone 23/27 at 181k; routing Haiku -> Sonnet -> Opus in one conversation cost
  // more than Sonnet alone ($0.25) because each model switch rewrites the prompt cache and Haiku needed more turns.
  claude: { explore: "sonnet", execute: "sonnet", escalate: "opus" },
  // gpt-6-sol for everything. Measured on the full 40 Hono tasks: sol alone 40/40, 63k mean total input, 5.3 turns —
  // clearly better than routing gpt-6-luna (explore) -> gpt-6-sol (execute/escalate), also 40/40 but 148k mean input,
  // 10.4 turns. Luna alone passed only 4/10 on a harder subset (one action per turn, never batches); the routed
  // default was built around that weakness, but sol alone turned out cheaper and faster than the routing meant to
  // work around it, the same pattern seen with Claude's Haiku/Sonnet/Opus routing losing to Sonnet alone.
  codex: { explore: "gpt-6-sol", execute: "gpt-6-sol", escalate: "gpt-6-sol" },
  antigravity: { explore: "gemini-3.8-flash-low", execute: "gemini-3.8-flash-high", escalate: "gemini-3.1-pro-high" },
  freellmapi: { explore: "auto", execute: "auto", escalate: "auto" },
  ...(Object.fromEntries(PROVIDERS.filter((p) => p !== "claude" && p !== "codex" && p !== "antigravity" && p !== "freellmapi").map((p) => [p, { explore: "", execute: "", escalate: "" }])) as Record<
    Exclude<ProviderName, "claude" | "codex" | "antigravity" | "freellmapi">,
    ModelTiers
  >),
};
export const DEFAULT_EFFORT = "medium";
/** Effort levels both CLIs accept (Codex's Sol/Terra also take "ultra"; not offered here since Luna and Claude don't). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export function isProvider(x: string): x is ProviderName {
  return (PROVIDERS as readonly string[]).includes(x);
}

export interface SelectionFlags {
  provider?: string;
  /** One model for every phase. */
  model?: string;
  explore?: string;
  execute?: string;
  escalate?: string;
  effort?: string;
}

export interface Selection {
  provider: ProviderName;
  tiers: ModelTiers;
  effort: string;
}

/** "codex:gpt-6-sol" -> { provider, model }. The provider is everything before the first colon (model ids can contain colons). */
export function parseScout(spec: string | undefined | null): { provider: ProviderName; model: string } | null {
  const i = (spec ?? "").indexOf(":");
  if (i < 1) return null;
  const provider = spec!.slice(0, i);
  const model = spec!.slice(i + 1).trim();
  return isProvider(provider) && model ? { provider, model } : null;
}

export function resolveSelection(agent: AgentConfig | undefined, flags: SelectionFlags = {}): Selection {
  const provider = flags.provider ?? agent?.provider ?? "claude";
  if (!isProvider(provider)) throw new Error(`unknown provider "${provider}" (expected one of ${PROVIDERS.join(", ")})`);
  const saved = agent?.models?.[provider] ?? {};
  const tiers = { ...DEFAULT_TIERS[provider] };
  for (const phase of PHASES) tiers[phase] = flags[phase] ?? flags.model ?? saved[phase] ?? tiers[phase];
  return { provider, tiers, effort: flags.effort ?? agent?.effort ?? DEFAULT_EFFORT };
}

export interface Endpoint {
  provider: ProviderName;
  baseUrl: string;
  /** Undefined when the provider needs none (local) or none is set (see `needsKey`). */
  apiKey?: string;
  needsKey: boolean;
}

/** Where an API/local provider lives, with per-repo overrides from `agent.endpoints`. */
export function resolveEndpoint(provider: ProviderName, agent?: AgentConfig): Endpoint | null {
  const info = PROVIDER_INFO[provider];
  if (info.kind === "subscription") return null;
  const override = agent?.endpoints?.[provider] ?? {};
  const baseUrl = (override.baseUrl ?? info.baseUrl ?? "").replace(/\/+$/, "").replace(/\{(\w+)\}/g, (m, v) => process.env[v]?.trim() || getKey(v) || m);
  // Local servers take no key; a custom endpoint may or may not, so a key is used if one is set.
  const needsKey = info.kind === "api" && provider !== "custom";
  return { provider, baseUrl, apiKey: getKey(provider, override.keyEnv ?? info.keyEnv), needsKey };
}

/** Why `provider` can't run tasks right now, or null if it can. */
export function unavailableReason(sel: Selection, agent?: AgentConfig): string | null {
  const ep = resolveEndpoint(sel.provider, agent);
  if (ep) {
    const info = PROVIDER_INFO[sel.provider];
    if (!ep.baseUrl) return `${info.label} has no base URL yet — set one (narrowbit models endpoint ${sel.provider} <url>).`;
    const placeholder = /\{(\w+)\}/.exec(ep.baseUrl);
    if (placeholder) return `${info.label}'s base URL needs ${placeholder[1]} — set that environment variable, or set the full URL (narrowbit models endpoint ${sel.provider} <url>).`;
    if (ep.needsKey && !ep.apiKey)
      return `${info.label} needs an API key — run \`narrowbit keys set ${sel.provider}\`${info.keyEnv ? ` or set ${info.keyEnv}` : ""}${info.keyUrl ? ` (get one at ${info.keyUrl})` : ""}.`;
  }
  const missing = PHASES.filter((ph) => !sel.tiers[ph]);
  if (missing.length) return `choose ${PROVIDER_INFO[sel.provider].label} models for ${missing.join(", ")} first (narrowbit models choose).`;
  return null;
}

export interface ModelList {
  models: string[];
  /** Subset of `models` that cost nothing to call (OpenRouter's pricing data). */
  free: string[];
  /** Display name (and one-line description where the catalog gives one), by model id. */
  labels: Record<string, string>;
  note: string;
}

/**
 * Claude models Narrowbit knows about, as a floor: shown even if the installed Claude Code is too old to list them
 * (a newer model still works when pinned — the CLI just warns it doesn't recognise the name). Everything the
 * installed Claude Code knows is added automatically on top (claudeCliModels), so this list only needs touching for a
 * model newer than the user's CLI.
 */
const CLAUDE_KNOWN: [string, string][] = [
  ["claude-fable-5-1", "Fable 5.1"],
  ["claude-opus-5-5", "Opus 5.5 — strongest for hard problems"],
  ["claude-sonnet-5-5", "Sonnet 5.5 — balanced everyday coding"],
  ["claude-sonnet-5", "Sonnet 5 — previous version"],
  ["claude-haiku-4-5", "Haiku 4.5 — fast, lowest cost"],
];
const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
const FAMILY_NAME: Record<string, string> = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

interface ClaudeId { id: string; family: string; major: number; minor: number }

function parseClaudeId(id: string): ClaudeId | null {
  const m = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?$/.exec(id);
  return m ? { id, family: m[1]!, major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 } : null;
}
const versionOf = (c: ClaudeId) => `${c.major}${c.minor ? "." + c.minor : ""}`;

function claudeBinPath(): string | null {
  const named = process.env.NARROWBIT_CLAUDE ?? "claude";
  const found = named.includes("/") ? named : sh("sh", ["-c", `command -v ${named}`], process.cwd()).stdout.trim();
  if (!found || !existsSync(found)) return null;
  try {
    return realpathSync(found);
  } catch {
    return found;
  }
}

/**
 * The Claude model ids the installed Claude Code knows. It has no list command, but its own program contains every id
 * it accepts, so they're read from there — a new model shows up in Narrowbit as soon as Claude Code is updated, with no
 * Narrowbit release. Dated snapshots and cloud-vendor variants are folded away, and very old families are skipped.
 * Cached against the binary's path, size and modification time, so the ~1s scan only reruns after an update.
 */
export function claudeCliModels(bin: string | null = claudeBinPath()): string[] {
  if (!bin) return [];
  let st;
  try {
    st = statSync(bin);
  } catch {
    return [];
  }
  const cacheFile = join(homedir(), ".narrowbit", "cache", "claude-models.json");
  const key = `${bin}|${st.size}|${st.mtimeMs}`;
  try {
    const c = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (c.key === key && Array.isArray(c.ids)) return c.ids;
  } catch {
    /* no cache yet */
  }
  const text = readFileSync(bin).toString("latin1");
  const seen = new Set<string>();
  for (const m of text.matchAll(/claude-(fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?:-(\d{8}))?(?![\w-])/g)) {
    const c = parseClaudeId(`claude-${m[1]}-${m[2]}${m[3] ? "-" + m[3] : ""}`);
    if (!c || c.major < 4 || (c.major === 4 && c.minor < 5)) continue;
    seen.add(c.id);
  }
  const ids = [...seen];
  try {
    mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
    writeFileSync(cacheFile, JSON.stringify({ key, ids }), { mode: 0o600 });
  } catch {
    /* cache is optional */
  }
  return ids;
}

/** Newest published version of an npm package, cached for 12 hours (checked with a 5s limit; null when offline). */
export function latestNpmVersion(pkg: string, nowMs = Date.now()): string | null {
  const cacheFile = join(homedir(), ".narrowbit", "cache", "npm-latest.json");
  let cache: Record<string, { v: string | null; at: number }> = {};
  try {
    cache = JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch {
    /* none yet */
  }
  const hit = cache[pkg];
  if (hit && nowMs - hit.at < 12 * 3600_000) return hit.v;
  const r = spawnSync("npm", ["view", pkg, "version"], { encoding: "utf8", timeout: 5000 });
  const v = r.status === 0 && /^\d+\.\d+\.\d+/.test(r.stdout.trim()) ? r.stdout.trim() : null;
  cache[pkg] = { v, at: nowMs };
  try {
    mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
    writeFileSync(cacheFile, JSON.stringify(cache), { mode: 0o600 });
  } catch {
    /* cache is optional */
  }
  return v;
}

/** True when `latest` is a newer x.y.z than `installed`. */
export function isNewerVersion(installed: string, latest: string): boolean {
  const a = installed.match(/\d+/g)?.map(Number) ?? [];
  const b = latest.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < 3; i++) if ((b[i] ?? 0) !== (a[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0);
  return false;
}

/** " — 1.2.3 is available: <how>" when the installed CLI is behind its npm release, else "". */
function updateHint(pkg: string, installed: string, how: string): string {
  const latest = installed ? latestNpmVersion(pkg) : null;
  return latest && isNewerVersion(installed, latest) ? ` — ${latest} is available: ${how}` : "";
}

/** The installed Claude Code's version, read from its npm package.json next to the binary — without running the CLI.
 * "" when that isn't how it was installed (no update hint is shown then). */
function claudeVersion(bin: string): string {
  for (let d = dirname(bin), i = 0; i < 4; i++, d = dirname(d)) {
    try {
      const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
      if (pkg?.name === "@anthropic-ai/claude-code" && typeof pkg.version === "string") return pkg.version;
    } catch {
      /* keep walking up */
    }
  }
  return "";
}

/** The Claude menu: aliases first (they follow whatever the installed CLI treats as newest), then exact ids, newest
 * first within each family. `cliIds` is claudeCliModels(); injectable for tests. */
export function claudeModelList(cliIds: string[]): { models: string[]; labels: Record<string, string>; outdated: string[] } {
  const known = new Map(CLAUDE_KNOWN);
  const cli = new Set(cliIds);
  const all = new Map<string, ClaudeId>();
  for (const id of [...cliIds, ...known.keys()]) {
    const c = parseClaudeId(id);
    if (c) all.set(id, c);
  }
  const sorted = [...all.values()].sort((a, b) => FAMILIES.indexOf(a.family as any) - FAMILIES.indexOf(b.family as any) || b.major - a.major || b.minor - a.minor);
  const labels: Record<string, string> = {};
  const models: string[] = [];
  const outdated: string[] = [];
  for (const fam of ["haiku", "sonnet", "opus", "fable"]) {
    const newestCli = sorted.find((c) => c.family === fam && cli.has(c.id));
    const newestAny = sorted.find((c) => c.family === fam);
    if (!newestAny) continue;
    models.push(fam);
    labels[fam] = newestCli
      ? `${FAMILY_NAME[fam]} (latest your Claude Code knows — currently ${FAMILY_NAME[fam]} ${versionOf(newestCli)})`
      : `${FAMILY_NAME[fam]} (latest)`;
  }
  for (const c of sorted) {
    models.push(c.id);
    const base = known.get(c.id) ?? `${FAMILY_NAME[c.family]} ${versionOf(c)}`;
    const newer = cliIds.length > 0 && !cli.has(c.id);
    if (newer) outdated.push(c.id);
    labels[c.id] = newer ? `${base} — newer than your Claude Code (works; update Claude Code for full support)` : base;
  }
  return { models, labels, outdated };
}

/**
 * Models a provider can use. Claude Code has no catalog command, so these are the aliases its
 * `--model` accepts (full model names like claude-opus-5 also work); Codex publishes its catalog
 * locally (`codex debug models`, no login needed); API and local servers list theirs at /models.
 */
export async function availableModels(provider: ProviderName, agent?: AgentConfig): Promise<ModelList> {
  if (provider === "claude") {
    const bin = claudeBinPath();
    const cliIds = claudeCliModels(bin);
    const list = claudeModelList(cliIds);
    const version = bin ? claudeVersion(bin) : "";
    const hint = updateHint("@anthropic-ai/claude-code", version, "run `claude update` so its newest models appear here and the sonnet/opus defaults move to them");
    const note = !cliIds.length
      ? "Claude Code's model list couldn't be read; showing the models Narrowbit knows about"
      : `from your Claude Code (${version || "installed"})${list.outdated.length ? `, plus newer models it doesn't know yet (${list.outdated.join(", ")})` : ""}${hint || " — new models appear here when Claude Code is updated"}`;
    return { models: list.models, free: [], labels: list.labels, note };
  }
  if (provider === "codex") {
    const r = sh(process.env.NARROWBIT_CODEX ?? "codex", ["debug", "models"], process.cwd());
    try {
      const d = JSON.parse(r.stdout);
      const list: any[] = Array.isArray(d) ? d : (d.models ?? []);
      const shown = list.filter((m) => m?.visibility !== "hide" && typeof m?.slug === "string");
      const labels = Object.fromEntries(shown.map((m) => [m.slug, [m.display_name, m.description].filter(Boolean).join(" — ")]));
      const version = sh(process.env.NARROWBIT_CODEX ?? "codex", ["--version"], process.cwd()).stdout.trim();
      // The catalog ships with the CLI, so an old CLI lists old models.
      const v = version.match(/\d+\.\d+\.\d+/)?.[0] ?? "";
      const hint = updateHint("@openai/codex", v, "run `npm install -g @openai/codex` to see its newest models");
      return { models: shown.map((m) => m.slug as string), free: [], labels, note: `from the installed Codex CLI (${version || "unknown version"})${hint || " — new models appear here when the CLI is updated"}` };
    } catch {
      return { models: [], free: [], labels: {}, note: "`codex debug models` unavailable — is the Codex CLI installed?" };
    }
  }
  if (provider === "antigravity") {
    const bin = process.env.NARROWBIT_AGY ?? `${process.env.HOME ?? ""}/.local/bin/agy`;
    const r = sh(bin, ["models"], process.cwd());
    const rows = r.stdout.split("\n").map((l) => l.split("\t")).filter((c) => c.length >= 2 && /^[\w.-]+$/.test(c[0]!));
    if (!rows.length) return { models: [], free: [], labels: {}, note: "`agy models` gave no list — is the Antigravity CLI installed and signed in?" };
    return { models: rows.map((c) => c[0]!), free: [], labels: Object.fromEntries(rows.map((c) => [c[0]!, c[1]!.trim()])), note: "from `agy models` (your Antigravity plan)" };
  }
  const ep = resolveEndpoint(provider, agent)!;
  const label = PROVIDER_INFO[provider].label;
  if (!ep.baseUrl) return { models: [], free: [], labels: {}, note: `no base URL set for ${label}` };
  if (provider === "cloudflare") {
    // Workers AI has no OpenAI-style /models (it answers 405); its own catalog is the model search API.
    const m = /\/accounts\/([^/]+)\/ai\//.exec(ep.baseUrl);
    if (!m) return { models: [], free: [], labels: {}, note: "Cloudflare needs your account id first" };
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${m[1]}/ai/models/search?task=Text%20Generation&per_page=100`, { headers: ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { models: [], free: [], labels: {}, note: `Cloudflare model list answered ${res.status}${res.status === 401 || res.status === 403 ? " — check the API token and account id" : ""}` };
      const d: any = await res.json();
      const models = ((d.result ?? []) as any[]).map((x) => x?.name).filter((x): x is string => typeof x === "string").sort((a, b) => a.localeCompare(b));
      return { models, free: [], labels: {}, note: "from Cloudflare Workers AI" };
    } catch (e: any) {
      return { models: [], free: [], labels: {}, note: `couldn't reach Cloudflare: ${e.message}` };
    }
  }
  try {
    const res = await fetch(`${ep.baseUrl}/models`, { headers: ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { models: [], free: [], labels: {}, note: `${label} /models answered ${res.status}${res.status === 401 ? " — check the API key" : ""}` };
    const d: any = await res.json();
    const list: any[] = Array.isArray(d) ? d : (d.data ?? d.models ?? []);
    const ids = list.map((m) => (typeof m === "string" ? m : (m?.id ?? m?.name))).filter((x): x is string => typeof x === "string");
    const free = list
      .filter((m) => m?.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)
      // Free image/music generators exist too; the agent needs text out.
      .filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes("text"))
      .map((m) => m.id as string)
      .filter((id) => !id.startsWith("openrouter/")); // routers, not models
    const models = [...new Set(ids.map((id) => id.replace(/^models\//, "")))].sort((a, b) => a.localeCompare(b));
    const labels: Record<string, string> = {};
    for (const m of list) if (m?.id && m?.name && m.name !== m.id) labels[String(m.id).replace(/^models\//, "")] = String(m.name);
    return { models, free: free.sort((a, b) => a.localeCompare(b)), labels, note: `from ${label}` };
  } catch (e: any) {
    const down = PROVIDER_INFO[provider].kind === "local" ? ` — is ${label} running?` : "";
    return { models: [], free: [], labels: {}, note: `couldn't reach ${ep.baseUrl}${down} (${e?.cause?.code ?? e?.name ?? "error"})` };
  }
}
