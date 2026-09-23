import type { AgentConfig } from "../config.js";
import { sh } from "../util.js";

/**
 * Model selection for `narrowbit agent`, shared by every provider: which provider drives the
 * loop, and which model handles each phase (explore = before any edit, execute = editing and
 * verifying, escalate = stuck). Precedence: CLI flags > .narrowbit/config.json `agent` > the
 * built-in defaults below.
 */
export const PROVIDERS = ["claude", "codex"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export const PHASES = ["explore", "execute", "escalate"] as const;
export type Phase = (typeof PHASES)[number];
export type ModelTiers = Record<Phase, string>;

// Codex tiers follow its own catalog descriptions: Luna "fast and affordable", Terra "balanced
// for everyday work", Sol "latest frontier" — the same shape as Haiku / Sonnet / Opus.
export const DEFAULT_TIERS: Record<ProviderName, ModelTiers> = {
  claude: { explore: "haiku", execute: "sonnet", escalate: "opus" },
  codex: { explore: "gpt-5.6-luna", execute: "gpt-5.6-terra", escalate: "gpt-5.6-sol" },
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
  if (!isProvider(provider)) throw new Error(`unknown provider "${provider}" (expected ${PROVIDERS.join(" or ")})`);
  const saved = agent?.models?.[provider] ?? {};
  const tiers = { ...DEFAULT_TIERS[provider] };
  for (const phase of PHASES) tiers[phase] = flags[phase] ?? flags.model ?? saved[phase] ?? tiers[phase];
  return { provider, tiers, effort: flags.effort ?? agent?.effort ?? DEFAULT_EFFORT };
}

/**
 * Models a provider can use, for `narrowbit models`. Codex publishes its catalog locally
 * (`codex debug models`, no login needed); Claude Code has no catalog command, so these are the
 * aliases its `--model` accepts (full model names like claude-opus-5 also work).
 */
export function availableModels(provider: ProviderName): { models: string[]; note: string } {
  if (provider === "claude") return { models: ["haiku", "sonnet", "opus", "fable"], note: "claude --model aliases; full model names also work" };
  const r = sh(process.env.NARROWBIT_CODEX ?? "codex", ["debug", "models"], process.cwd());
  try {
    const d = JSON.parse(r.stdout);
    const list: any[] = Array.isArray(d) ? d : (d.models ?? []);
    const models = list.filter((m) => m?.visibility !== "hide" && typeof m?.slug === "string").map((m) => m.slug as string);
    return { models, note: "from `codex debug models`" };
  } catch {
    return { models: [], note: "`codex debug models` unavailable — is the Codex CLI installed?" };
  }
}
