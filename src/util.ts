import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export function sha1(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

/**
 * Rough token estimate. Claude's tokenizer is not available locally, so this
 * is a character heuristic (~3.6 chars/token for source code). Every number
 * derived from it is labelled "est." in output; benchmarks use provider-reported usage.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function sh(cmd: string, args: string[], cwd: string, input?: string): { code: number; stdout: string; stderr: string } {
  // Git refuses to touch a repository it doesn't own (a real safety feature — protects against another
  // user planting a malicious repo you'd cd into) — but on a shared Mac, or a project folder that existed
  // before Narrowbit ever touched it, "doesn't own" often just means a different macOS account created the
  // folder. Without this, every git call fails silently from Narrowbit's own perspective: gitState() and
  // remoteInfo() see a plain error, not a special case, and simply report "not a repo" / "no remote" — no
  // banner, no clue anything is wrong, the whole git-aware half of the UI just vanishes. Narrowbit is only
  // ever asked to operate on a folder the user explicitly pointed it at, so it's reasonable to trust that
  // one folder for its own commands, scoped to this single invocation — not a persistent config change.
  const realArgs = cmd === "git" ? ["-c", `safe.directory=${cwd}`, ...args] : args;
  const r = spawnSync(cmd, realArgs, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, input });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function now(): string {
  return new Date().toISOString();
}

export function shortId(): string {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 10).replace(/-/g, "");
  return `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r(?!\n)/g, "");
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
