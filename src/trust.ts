import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gitArgs, visible } from "./util.js";

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

/** Three separate decisions, each remembered under its own key: git filters, the repo's config settings, and a shipped .narrowbit/. */
type Scope = "git" | "config" | "shipped";
const scopeOf = (r: GitRisk): Scope => (r.key.startsWith("narrowbit.") ? "config" : r.key.startsWith("shipped.") ? "shipped" : "git");
const isConfigRisk = (r: GitRisk) => scopeOf(r) === "config";
const storeKey = (root: string, scope: Scope) => (scope === "git" ? canonical(root) : `${canonical(root)}#${scope}`);
const SCOPES: Scope[] = ["git", "config", "shipped"];

/**
 * A repository can ship its own `.narrowbit/` folder (committed with `git add -f`, or inside a downloaded archive). It can
 * hold past task logs that a "continue" treats as what the earlier work already established, skills (instructions the model
 * follows, even ones named like a built-in), memory notes and settings. The user's own `.narrowbit/` is never committed
 * (it keeps itself out of git), so files git tracks under it — or a `.narrowbit/` in a folder that isn't a git repository
 * at all — came from someone else, and are accepted once, per set of files, before they are used.
 */
export function shippedRisks(root: string): GitRisk[] {
  const dir = join(root, ".narrowbit");
  if (!existsSync(dir)) return [];
  let files: string[] = [];
  if (existsSync(join(root, ".git"))) {
    const r = spawnSync("git", gitArgs(root, ["ls-files", "-z", "--", ".narrowbit"]), { cwd: root, encoding: "utf8" });
    if (r.status === 0) files = r.stdout.split("\0").filter(Boolean);
  } else {
    try { files = readdirSync(dir).map((n) => `.narrowbit/${n}`); } catch { /* unreadable: treated as empty */ }
  }
  if (!files.length) return [];
  files.sort();
  const shown = files.slice(0, 12).join(", ") + (files.length > 12 ? ` … and ${files.length - 12} more` : "");
  return [{ key: "shipped.narrowbit", value: `${files.length} file(s) shipped with the repository: ${shown}` }];
}

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

/** Trusted means: the user accepted exactly these filter programs / config settings / shipped files for this folder. If they
 * change, ask again. Each kind is a separate decision, remembered under its own key. */
export function isTrusted(root: string, risks: GitRisk[]): boolean {
  const saved = load();
  return SCOPES.every((sc) => {
    const list = risks.filter((r) => scopeOf(r) === sc);
    return !list.length || saved[storeKey(root, sc)] === fingerprint(list);
  });
}

export function trustRepo(root: string, risks: GitRisk[]): void {
  const all = load();
  for (const sc of SCOPES) {
    const list = risks.filter((r) => scopeOf(r) === sc);
    if (list.length) all[storeKey(root, sc)] = fingerprint(list);
  }
  const f = storePath();
  if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
}

/** The user just set these config values themselves (`narrowbit models endpoint`, the app's endpoint field): accept what the file holds now. */
export function trustConfig(root: string): void {
  trustRepo(root, repoConfigRisksAt(root));
}

export function describeRisks(risks: GitRisk[]): string {
  // What the user is asked to accept must be readable as written: control characters are spelled out (they could erase or
  // replace the warning in a terminal), and a value that is cut says how much is missing instead of hiding its tail.
  const MAX = 1000;
  return risks.map((r) => `  ${visible(r.key)} = ${visible(r.value.slice(0, MAX))}${r.value.length > MAX ? ` [+${r.value.length - MAX} more characters not shown]` : ""}`).join("\n");
}

/** The one check every entry point uses before running git in a folder: null if fine to open, else why not. */
export function untrustedReason(root: string): { risks: GitRisk[]; message: string } | null {
  const risks = [...gitConfigRisks(root), ...repoConfigRisksAt(root), ...shippedRisks(root)];
  if (isTrusted(root, risks)) return null;
  return { risks, message: untrustedMessage(root, risks) };
}

/** What the user is asked to accept: only the kinds they haven't accepted yet are described. */
export function untrustedMessage(root: string, risks: GitRisk[]): string {
  const open = (sc: Scope) => {
    const list = risks.filter((r) => scopeOf(r) === sc);
    return list.length && !isTrusted(root, list) ? list : [];
  };
  const git = open("git"), cfg = open("config"), shipped = open("shipped");
  const parts: string[] = [];
  if (git.length) parts.push(`This repository's git settings name programs that git runs by itself on ordinary commands (like status and add):\n${describeRisks(git)}`);
  if (cfg.length) parts.push(`This repository's .narrowbit/config.json sets things that decide where your code and keys go, or what notes are read (custom API addresses, the environment variable sent as the key, extra memory folders):\n${describeRisks(cfg)}`);
  if (shipped.length) parts.push(`This repository ships its own .narrowbit/ folder. It can hold settings, project memory notes, skills (instructions the model follows) and past task logs that a new task would treat as earlier work it can rely on:\n${describeRisks(shipped)}`);
  return `${parts.join("\n\n")}\nOnly open it if you trust where it came from.`;
}
