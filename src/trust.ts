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
 *
 * The same goes for the repository's own `.narrowbit/config.json`, which a cloned repo can ship: an endpoint override
 * (with the name of any environment variable to send as the key, or `{VAR}` in the URL) would send your code and
 * secrets to an address the repo author picked, and `memoryDirs` would read notes from folders outside the repo into
 * what the model sees. Those settings only take effect once the user has accepted exactly those values (config.ts
 * loadConfig drops them until then); they are a separate decision from the git filters.
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

/** Settings in a repo's `.narrowbit/config.json` that send data to, or read data from, places the repo author chose. */
export function repoConfigRisks(raw: any): GitRisk[] {
  const risks: GitRisk[] = [];
  const eps = raw?.agent?.endpoints;
  if (eps && typeof eps === "object") {
    for (const [prov, ep] of Object.entries<any>(eps)) {
      for (const f of ["baseUrl", "keyEnv"]) if (typeof ep?.[f] === "string" && ep[f].trim()) risks.push({ key: `narrowbit.agent.endpoints.${prov}.${f}`, value: ep[f] });
    }
  }
  if (Array.isArray(raw?.memoryDirs)) for (const d of raw.memoryDirs) if (typeof d === "string" && d.trim()) risks.push({ key: "narrowbit.memoryDirs", value: d });
  return risks;
}

const isConfigRisk = (r: GitRisk) => r.key.startsWith("narrowbit.");

export function repoConfigRisksAt(root: string): GitRisk[] {
  try {
    return repoConfigRisks(JSON.parse(readFileSync(join(root, ".narrowbit", "config.json"), "utf8")));
  } catch {
    return [];
  }
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

/** Trusted means: the user accepted exactly these filter programs / config settings for this folder. If they change, ask again.
 * Git filters and config settings are separate decisions (the config entry lives under "<folder>#config"). */
export function isTrusted(root: string, risks: GitRisk[]): boolean {
  const saved = load();
  const ok = (list: GitRisk[], key: string) => !list.length || saved[key] === fingerprint(list);
  return ok(risks.filter((r) => !isConfigRisk(r)), canonical(root)) && ok(risks.filter(isConfigRisk), `${canonical(root)}#config`);
}

export function trustRepo(root: string, risks: GitRisk[]): void {
  const all = load();
  const git = risks.filter((r) => !isConfigRisk(r));
  const cfg = risks.filter(isConfigRisk);
  if (git.length) all[canonical(root)] = fingerprint(git);
  if (cfg.length) all[`${canonical(root)}#config`] = fingerprint(cfg);
  const f = storePath();
  if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
}

/** The user just set these config values themselves (`narrowbit models endpoint`, the app's endpoint field): accept what the file holds now. */
export function trustConfig(root: string): void {
  trustRepo(root, repoConfigRisksAt(root));
}

export function describeRisks(risks: GitRisk[]): string {
  return risks.map((r) => `  ${r.key} = ${r.value.length > 120 ? r.value.slice(0, 117) + "..." : r.value}`).join("\n");
}

/** The one check every entry point uses before running git in a folder: null if fine to open, else why not. */
export function untrustedReason(root: string): { risks: GitRisk[]; message: string } | null {
  const risks = [...gitConfigRisks(root), ...repoConfigRisksAt(root)];
  if (isTrusted(root, risks)) return null;
  const git = risks.filter((r) => !isConfigRisk(r));
  const cfg = risks.filter(isConfigRisk);
  const parts: string[] = [];
  if (git.length && !isTrusted(root, git)) parts.push(`This repository's git settings name programs that git runs by itself on ordinary commands (like status and add):\n${describeRisks(git)}`);
  if (cfg.length && !isTrusted(root, cfg)) parts.push(`This repository's .narrowbit/config.json sets things that decide where your code and keys go, or what notes are read (custom API addresses, the environment variable sent as the key, extra memory folders):\n${describeRisks(cfg)}`);
  return { risks, message: `${parts.join("\n\n")}\nOnly open it if you trust where it came from.` };
}
