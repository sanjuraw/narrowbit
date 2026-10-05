import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
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

/** Filter programs this repo's own config (repository and worktree level, and anything they include) would run.
 * Reading config runs nothing. The worktree level matters: with `extensions.worktreeConfig` git also reads
 * `.git/config.worktree`, which `git config --local` does not show. */
export function gitConfigRisks(root: string): GitRisk[] {
  const entries: string[] = [];
  const scoped = spawnSync("git", gitArgs(root, ["config", "--includes", "--list", "-z", "--show-scope"]), { cwd: root, encoding: "utf8" });
  if (scoped.status === 0) {
    // With -z and --show-scope the output alternates: scope, then "key\nvalue".
    const t = scoped.stdout.split("\0");
    for (let i = 0; i + 1 < t.length; i += 2) if (t[i] === "local" || t[i] === "worktree") entries.push(t[i + 1]);
  } else {
    // An older git without --show-scope: the repository level only.
    const old = spawnSync("git", gitArgs(root, ["config", "--local", "--includes", "--list", "-z"]), { cwd: root, encoding: "utf8" });
    if (old.status === 0) entries.push(...old.stdout.split("\0"));
  }
  const risks: GitRisk[] = [];
  for (const entry of entries) {
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
  // The folder itself as a symlink (git tracks that as a single entry, so it would otherwise count as "no files"): its
  // contents are wherever it points. Reported so the reason is visible; set-up refuses it regardless of the answer.
  try {
    if (lstatSync(dir).isSymbolicLink()) return [{ key: "shipped.narrowbit", value: `.narrowbit is a symlink to ${visible(readlinkSync(dir)).slice(0, 200)} — its contents would be read from, and state written to, that location` }];
  } catch {
    return [];
  }
  let files: string[] = [];
  if (existsSync(join(root, ".git"))) {
    // :(icase) because on a case-insensitive filesystem a committed ".NARROWBIT/" is read as ".narrowbit/".
    const r = spawnSync("git", gitArgs(root, ["ls-files", "-z", "--", ":(icase).narrowbit"]), { cwd: root, encoding: "utf8" });
    // Only what is really inside the folder: some git versions also match a sibling such as ".narrowbitignore" here.
    if (r.status === 0) files = r.stdout.split("\0").filter((f) => f.toLowerCase().startsWith(".narrowbit/"));
  } else {
    files = walkFiles(root, ".narrowbit");
  }
  if (!files.length) return [];
  files.sort();
  const shown = files.slice(0, 12).join(", ") + (files.length > 12 ? ` … and ${files.length - 12} more` : "");
  // What was accepted is the content, not only the names: a later pull that rewrites a skill or a task log asks again.
  return [{ key: "shipped.narrowbit", value: `${files.length} file(s) shipped with the repository: ${shown} [content id ${contentId(root, files)}]` }];
}

/** Every file under `rel` (links are listed by name, never followed), capped so a huge tree can't stall opening a folder. */
function walkFiles(root: string, rel: string, out: string[] = []): string[] {
  if (out.length >= 5000) return out;
  let names: string[] = [];
  try { names = readdirSync(join(root, rel), { withFileTypes: true }).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)); } catch { return out; }
  for (const n of names) {
    if (out.length >= 5000) break;
    if (n.endsWith("/")) walkFiles(root, `${rel}/${n.slice(0, -1)}`, out);
    else out.push(`${rel}/${n}`);
  }
  return out;
}

/** Streams a file through the hash in chunks, so a huge file is still judged by its content (an equal-size change must show). */
function hashFile(h: ReturnType<typeof createHash>, abs: string): void {
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

/** A short digest of the files' names and current contents (a link counts as its target text). */
function contentId(root: string, files: string[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort()) {
    h.update(f + "\0");
    try {
      const abs = join(root, f);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) h.update("link:" + readlinkSync(abs));
      else hashFile(h, abs);
    } catch {
      h.update("missing");
    }
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
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

/**
 * The check for entry points that run unattended (the MCP server, the prompt hook): nobody can be asked there, and their
 * command line may even come from the repository. Git filters and a shipped `.narrowbit/` block them; the config settings
 * don't need to, because `loadConfig` already drops those until the user has accepted them.
 */
export function untrustedForUnattended(root: string): { risks: GitRisk[]; message: string } | null {
  const risks = [...gitConfigRisks(root), ...shippedRisks(root)];
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
