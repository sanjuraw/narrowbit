import type { AgentConfig } from "../config.js";
import { sh } from "../util.js";
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
  "claude", "codex",
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
  claude: { explore: "haiku", execute: "sonnet", escalate: "opus" },
  // gpt-6-luna is the "fast, easier tasks" model: fine for reading, but it passed only 4/10 Hono tasks alone (one action
  // per turn, never batches). gpt-6-sol ("workhorse for coding") batches and passed 2 of luna's 4 hardest failures.
  codex: { explore: "gpt-6-luna", execute: "gpt-6-sol", escalate: "gpt-6-sol" },
  freellmapi: { explore: "auto", execute: "auto", escalate: "auto" },
  ...(Object.fromEntries(PROVIDERS.filter((p) => p !== "claude" && p !== "codex" && p !== "freellmapi").map((p) => [p, { explore: "", execute: "", escalate: "" }])) as Record<
    Exclude<ProviderName, "claude" | "codex" | "freellmapi">,
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
 * Claude Code has no command that lists models, so the current lineup is kept here. The aliases
 * always resolve to the newest model of that family, so they stay correct when this list goes
 * stale; the full ids pin an exact version. Update this when Anthropic ships a new model.
 */
const CLAUDE_MODELS: [string, string][] = [
  ["haiku", "Haiku (latest — currently Haiku 4.5)"],
  ["sonnet", "Sonnet (latest — currently Sonnet 5)"],
  ["opus", "Opus (latest — currently Opus 5.5)"],
  ["fable", "Fable (latest — currently Fable 5.1)"],
  ["claude-haiku-4-5-20251001", "Haiku 4.5 — fast, lowest cost"],
  ["claude-sonnet-5", "Sonnet 5 — balanced everyday coding"],
  ["claude-opus-5-5", "Opus 5.5 — strongest for hard problems"],
  ["claude-fable-5-1", "Fable 5.1"],
];

/**
 * Models a provider can use. Claude Code has no catalog command, so these are the aliases its
 * `--model` accepts (full model names like claude-opus-5 also work); Codex publishes its catalog
 * locally (`codex debug models`, no login needed); API and local servers list theirs at /models.
 */
export async function availableModels(provider: ProviderName, agent?: AgentConfig): Promise<ModelList> {
  if (provider === "claude")
    return { models: CLAUDE_MODELS.map(([id]) => id), free: [], labels: Object.fromEntries(CLAUDE_MODELS), note: "Claude Code aliases (always the newest of each family) and exact model ids" };
  if (provider === "codex") {
    const r = sh(process.env.NARROWBIT_CODEX ?? "codex", ["debug", "models"], process.cwd());
    try {
      const d = JSON.parse(r.stdout);
      const list: any[] = Array.isArray(d) ? d : (d.models ?? []);
      const shown = list.filter((m) => m?.visibility !== "hide" && typeof m?.slug === "string");
      const labels = Object.fromEntries(shown.map((m) => [m.slug, [m.display_name, m.description].filter(Boolean).join(" — ")]));
      const version = sh(process.env.NARROWBIT_CODEX ?? "codex", ["--version"], process.cwd()).stdout.trim();
      // The catalog ships with the CLI, so an old CLI lists old models.
      return { models: shown.map((m) => m.slug as string), free: [], labels, note: `from the installed Codex CLI (${version || "unknown version"}) — update the CLI to see newer models` };
    } catch {
      return { models: [], free: [], labels: {}, note: "`codex debug models` unavailable — is the Codex CLI installed?" };
    }
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
