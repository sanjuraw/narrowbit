import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Subscription usage limits — the 5-hour and weekly windows — for Claude and Codex, from each
 * CLI's own supported output, never scraped from a web page:
 *   - Claude Code emits a `rate_limit_event` (utilization + reset time for both windows) in its
 *     stream-json output on every call; claude-cli.ts hands each one to recordClaudeLimits(), so
 *     the numbers stay current for free while Narrowbit works. `refreshClaude` makes one tiny
 *     Haiku call (a few tokens against the limit it reports) when there's nothing recent.
 *   - Codex answers `account/rateLimits/read` on `codex app-server` (JSON-RPC over stdio), which
 *     costs no model usage. It needs `codex login` first.
 * Latest readings are kept in ~/.narrowbit/limits.json so every repo and the app see them.
 */
export interface LimitWindow {
  /** 0–100. */
  usedPercent: number;
  /** Unix seconds, when the window resets; null if the provider didn't say. */
  resetsAt: number | null;
}

export interface ProviderLimits {
  fiveHour: LimitWindow | null;
  weekly: LimitWindow | null;
  /** Provider's own status word, e.g. "allowed", "allowed_warning", "rejected". */
  status?: string;
  plan?: string;
  checkedAt: string;
  error?: string;
}

export type LimitsFile = Partial<Record<"claude" | "codex", ProviderLimits>>;

const FILE = join(homedir(), ".narrowbit", "limits.json");

export function readLimits(): LimitsFile {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(provider: "claude" | "codex", l: ProviderLimits) {
  const all = readLimits();
  // Keep the last good numbers when a refresh fails, so a transient error doesn't blank them.
  all[provider] = l.error && all[provider] && !all[provider]!.error ? { ...all[provider]!, error: l.error, checkedAt: l.checkedAt } : l;
  try {
    mkdirSync(join(homedir(), ".narrowbit"), { recursive: true, mode: 0o700 });
    writeFileSync(FILE, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // Limits are informational; never fail a task over them.
  }
}

/** Parse Claude Code's stream-json `rate_limit_event`; returns null if the output has none. */
export function parseClaudeLimits(raw: string): ProviderLimits | null {
  let found: ProviderLimits | null = null;
  for (const line of raw.split("\n")) {
    if (!line.includes('"rate_limit_event"')) continue;
    try {
      const info = JSON.parse(line).rate_limit_info ?? {};
      const w = info.unifiedWindows ?? {};
      const win = (x: any): LimitWindow | null =>
        x && typeof x.utilization === "number" ? { usedPercent: Math.round(x.utilization * 1000) / 10, resetsAt: typeof x.resetsAt === "number" ? x.resetsAt : null } : null;
      // Older CLIs report only the window that's closest to its limit.
      const single = win(info);
      found = {
        fiveHour: win(w.five_hour) ?? (info.rateLimitType === "five_hour" ? single : null),
        weekly: win(w.seven_day) ?? (info.rateLimitType === "seven_day" ? single : null),
        status: info.status,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      // ignore a malformed line
    }
  }
  return found;
}

export function recordClaudeLimits(raw: string): void {
  const l = parseClaudeLimits(raw);
  if (l) save("claude", l);
}

/** One minimal call so Claude Code reports current limits. */
export async function refreshClaude(claudeBin?: string): Promise<ProviderLimits> {
  const { callModel } = await import("./providers/claude-cli.js");
  const before = readLimits().claude?.checkedAt;
  const r = await callModel({ cwd: homedir(), prompt: "Reply with: ok", systemPrompt: "Reply with: ok", model: "haiku", effort: "low", role: "limits", claudeBin, timeoutMs: 60_000 });
  const now = readLimits().claude;
  if (now && now.checkedAt !== before && !now.error) return now;
  const l: ProviderLimits = { fiveHour: null, weekly: null, checkedAt: new Date().toISOString(), error: r.isError ? (r.errorMessage ?? "claude call failed") : "Claude Code didn't report limits" };
  save("claude", l);
  return readLimits().claude ?? l;
}

/** Ask Codex's app-server for the account's rate limits (no model call). */
export function refreshCodex(codexBin = process.env.NARROWBIT_CODEX ?? "codex"): Promise<ProviderLimits> {
  return new Promise((resolve) => {
    const done = (l: ProviderLimits) => {
      clearTimeout(timer);
      child.kill();
      save("codex", l);
      resolve(readLimits().codex ?? l);
    };
    const fail = (error: string) => done({ fiveHour: null, weekly: null, checkedAt: new Date().toISOString(), error });
    const child = spawn(codexBin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => fail("Codex app-server didn't answer in time"), 15_000);
    child.on("error", () => fail("Codex CLI not found"));
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: null });
        } else if (m.id === 2) {
          if (m.error) return fail(/authentication/i.test(m.error.message ?? "") ? "not logged in — run `codex login`" : String(m.error.message ?? "error"));
          const snap = m.result?.rateLimitsByLimitId?.codex ?? m.result?.rateLimits ?? {};
          const windows = [snap.primary, snap.secondary].filter(Boolean);
          const win = (x: any): LimitWindow => ({ usedPercent: Number(x.usedPercent ?? 0), resetsAt: x.resetsAt ?? null });
          // Identify windows by length rather than position: 300 min = 5 hours, 10080 = a week.
          const five = windows.find((x) => x.windowDurationMins === 300) ?? (windows.length === 2 ? snap.primary : null);
          const week = windows.find((x) => x.windowDurationMins === 10080) ?? (windows.length === 2 ? snap.secondary : null);
          done({ fiveHour: five ? win(five) : null, weekly: week ? win(week) : null, plan: snap.planType ?? undefined, status: snap.rateLimitReachedType ?? "allowed", checkedAt: new Date().toISOString() });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "narrowbit", title: "Narrowbit", version: "0.1.0" } } });
  });
}

export function fmtLimits(name: string, l: ProviderLimits | undefined): string {
  if (!l) return `${name}: no reading yet`;
  const reset = (t: number | null) => {
    if (!t) return "";
    const mins = Math.round((t * 1000 - Date.now()) / 60000);
    return mins <= 0 ? " (resetting)" : mins < 90 ? ` (resets in ${mins}m)` : mins < 48 * 60 ? ` (resets in ${Math.round(mins / 60)}h)` : ` (resets ${new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short", hour: "numeric" })})`;
  };
  const w = (label: string, x: LimitWindow | null) => (x ? `${label} ${x.usedPercent}% used${reset(x.resetsAt)}` : `${label} —`);
  const age = Math.round((Date.now() - new Date(l.checkedAt).getTime()) / 60000);
  return `${name}: ${w("5-hour", l.fiveHour)} · ${w("weekly", l.weekly)}${l.plan ? ` · ${l.plan} plan` : ""}  [${age < 1 ? "just now" : `${age}m ago`}]${l.error ? `  (${l.error})` : ""}`;
}
