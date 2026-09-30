import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gitArgs } from "./util.js";

/**
 * Some git settings in a repository's own config name a program git runs by itself on ordinary commands. Narrowbit
 * switches the switchable ones off for every git call it makes (util.ts gitArgs: fsmonitor, external diff,
 * textconv). Clean/smudge filters are the exception: git-lfs and git-crypt rely on them, and replacing a git-crypt
 * filter could even commit decrypted secrets. So a repo that defines its own filter program is only opened after
 * the user says they trust it — the same idea as VS Code's workspace trust, scoped to this one real risk.
 */
const GIT_LFS = /^git-lfs (clean -- %f|smudge( --skip)? -- %f|filter-process( --skip)?)$/;

export interface GitRisk {
  key: string;
  value: string;
}

/** Filter programs this repo's local config (and anything it includes) would run. Reading config runs nothing. */
export function gitConfigRisks(root: string): GitRisk[] {
  const r = spawnSync("git", gitArgs(root, ["config", "--local", "--includes", "--list", "-z"]), { cwd: root, encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return [];
  const risks: GitRisk[] = [];
  for (const entry of r.stdout.split("\0")) {
    if (!entry) continue;
    const nl = entry.indexOf("\n");
    const key = (nl < 0 ? entry : entry.slice(0, nl)).toLowerCase();
    const value = nl < 0 ? "" : entry.slice(nl + 1);
    if (!/^filter\..+\.(clean|smudge|process)$/.test(key)) continue;
    // git-lfs is ubiquitous and installed by the user themselves; flagging it would train everyone to click through.
    // Only the exact commands `git lfs install` writes are exempt — a prefix match let `git-lfs clean -- %f; <anything>`
    // through, and git runs the whole value through the shell.
    if (GIT_LFS.test(value.trim())) continue;
    if (!value.trim()) continue;
    risks.push({ key, value });
  }
  return risks;
}

function storePath(): string {
  return join(homedir(), ".narrowbit", "trusted-repos.json");
}

function fingerprint(risks: GitRisk[]): string {
  return createHash("sha256").update(JSON.stringify(risks.map((r) => [r.key, r.value]).sort())).digest("hex");
}

function canonical(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

function load(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(storePath(), "utf8"));
  } catch {
    return {};
  }
}

/** Trusted means: the user accepted exactly these filter programs for this folder. If they change, ask again. */
export function isTrusted(root: string, risks: GitRisk[]): boolean {
  if (!risks.length) return true;
  return load()[canonical(root)] === fingerprint(risks);
}

export function trustRepo(root: string, risks: GitRisk[]): void {
  const all = load();
  all[canonical(root)] = fingerprint(risks);
  const f = storePath();
  if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
}

export function describeRisks(risks: GitRisk[]): string {
  return risks.map((r) => `  ${r.key} = ${r.value.length > 120 ? r.value.slice(0, 117) + "..." : r.value}`).join("\n");
}

/** The one check every entry point uses before running git in a folder: null if fine to open, else why not. */
export function untrustedReason(root: string): { risks: GitRisk[]; message: string } | null {
  const risks = gitConfigRisks(root);
  if (isTrusted(root, risks)) return null;
  return {
    risks,
    message: `This repository's git settings name programs that git runs by itself on ordinary commands (like status and add):\n${describeRisks(risks)}\nOnly open it if you trust where it came from.`,
  };
}
