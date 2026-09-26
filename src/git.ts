import { spawnSync } from "node:child_process";
import { sh } from "./util.js";

export interface GitState {
  isRepo: boolean;
  head: string | null;
  branch: string | null;
  dirty: string[];
  staged: string[];
  untracked: string[];
}

export interface CommitInfo {
  hash: string;
  date: string;
  subject: string;
  files: string[];
}

export function gitState(root: string): GitState {
  const head = sh("git", ["rev-parse", "HEAD"], root);
  if (head.code !== 0) {
    const inside = sh("git", ["rev-parse", "--is-inside-work-tree"], root).code === 0;
    return { isRepo: inside, head: null, branch: null, dirty: [], staged: [], untracked: [] };
  }
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], root).stdout.trim();
  const st = sh("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], root).stdout.split("\0").filter(Boolean);
  const dirty: string[] = [];
  const staged: string[] = [];
  const untracked: string[] = [];
  for (let i = 0; i < st.length; i++) {
    const e = st[i];
    const x = e[0];
    const y = e[1];
    const path = e.slice(3);
    if (x === "R" || x === "C") i++; // rename source follows
    if (x === "?") untracked.push(path);
    else {
      if (x !== " ") staged.push(path);
      if (y !== " ") dirty.push(path);
    }
  }
  return { isRepo: true, head: head.stdout.trim(), branch, dirty, staged, untracked };
}

export function recentCommits(root: string, n = 30, ref = "HEAD"): CommitInfo[] {
  const r = sh("git", ["log", ref, `-n${n}`, "--no-merges", "--name-only", "--format=%x1e%H%x1f%cI%x1f%s"], root);
  if (r.code !== 0) return [];
  const out: CommitInfo[] = [];
  for (const block of r.stdout.split("\x1e")) {
    if (!block.trim()) continue;
    const [header, ...rest] = block.split("\n");
    const [hash, date, subject] = header.split("\x1f");
    out.push({ hash, date, subject, files: rest.map((l) => l.trim()).filter(Boolean) });
  }
  return out;
}

/** Per-file recency rank: 0 = touched by most recent commit. Uses last `n` commits. */
export function fileRecency(commits: CommitInfo[]): Map<string, { index: number; date: string; subject: string; hash: string; spread: number }> {
  const m = new Map<string, { index: number; date: string; subject: string; hash: string; spread: number }>();
  commits.forEach((c, index) => {
    for (const f of c.files) if (!m.has(f)) m.set(f, { index, date: c.date, subject: c.subject, hash: c.hash, spread: c.files.length });
  });
  return m;
}

/** Files changed between a base commit and the working tree (tracked + untracked). */
export function changedSince(root: string, base: string): string[] {
  const tracked = sh("git", ["diff", "--name-only", base], root).stdout.split("\n").filter(Boolean);
  const untracked = sh("git", ["ls-files", "--others", "--exclude-standard"], root).stdout.split("\n").filter(Boolean);
  return [...new Set([...tracked, ...untracked])];
}

/** Changed line ranges (new side) per file relative to base, for mapping diffs to symbols. */
export function changedHunks(root: string, base: string, files?: string[]): Map<string, [number, number][]> {
  const r = sh("git", ["diff", "-U0", base, "--", ...(files ?? [])], root);
  const m = new Map<string, [number, number][]>();
  let cur: string | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("+++ ")) {
      cur = line.startsWith("+++ b/") ? line.slice(6) : null;
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && cur) {
      const start = Number(h[1]);
      const len = h[2] === undefined ? 1 : Number(h[2]);
      const list = m.get(cur) ?? [];
      list.push([start, start + Math.max(len, 1) - 1]);
      m.set(cur, list);
    }
  }
  return m;
}

export function diffStat(root: string, base: string): string {
  return sh("git", ["diff", "--stat", base], root).stdout.trim();
}

export interface RemoteInfo {
  /** https://github.com/owner/repo when the first remote is on GitHub (so the app can link to it). */
  webUrl?: string;
  repoName?: string;
  hasRemote: boolean;
  upstream: string | null;
  /** Commits on this branch that aren't on the remote yet (or on any remote, when there's no upstream). */
  ahead: number;
}

export function remoteInfo(root: string): RemoteInfo {
  const hasRemote = sh("git", ["remote"], root).stdout.trim().length > 0;
  if (!hasRemote) return { hasRemote: false, upstream: null, ahead: 0 };
  const web = githubWebUrl(sh("git", ["remote", "get-url", sh("git", ["remote"], root).stdout.trim().split("\n")[0]!], root).stdout.trim());
  const up = sh("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root);
  if (up.code === 0) {
    const n = sh("git", ["rev-list", "--count", "@{u}..HEAD"], root);
    return { hasRemote, upstream: up.stdout.trim(), ahead: Number(n.stdout.trim()) || 0, ...web };
  }
  const n = sh("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], root);
  return { hasRemote, upstream: null, ahead: Number(n.stdout.trim()) || 0, ...web };
}

/** Browser link for a GitHub remote (https or ssh form); nothing for other hosts. */
export function githubWebUrl(remote: string): { webUrl: string; repoName: string } | {} {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? { webUrl: `https://github.com/${m[1]}/${m[2]}`, repoName: `${m[1]}/${m[2]}` } : {};
}

/**
 * Push the current branch. Never forces, and never waits for a password: with no stored credentials git
 * fails at once and we say how to fix it, instead of hanging on a prompt nobody can see.
 */
export function pushBranch(root: string): { ok: boolean; message: string } {
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], root).stdout.trim();
  if (!branch || branch === "HEAD") return { ok: false, message: "You're not on a branch (detached HEAD), so there's nothing to push to." };
  const info = remoteInfo(root);
  if (!info.hasRemote) return { ok: false, message: "This repository has no remote. Add one with: git remote add origin <url>" };
  const args = info.upstream ? ["push"] : ["push", "-u", "origin", branch];
  const r = spawnSync("git", args, {
    cwd: root, encoding: "utf8", timeout: 90_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_INTERACTIVE: "never" },
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  if (r.status === 0) return { ok: true, message: info.upstream ? `Pushed to ${info.upstream}.` : `Pushed and now tracking origin/${branch}.` };
  if (/non-fast-forward|fetch first|rejected/i.test(out)) return { ok: false, message: "The remote has commits you don't have, so the push was refused. Narrowbit never force-pushes: pull or rebase in a terminal first." };
  if (/could not read Username|Authentication failed|Permission denied|403|terminal prompts disabled|invalid credentials/i.test(out))
    return { ok: false, message: "GitHub didn't accept this Mac's credentials. Sign in once in a terminal (for example `gh auth login`, or a stored token/SSH key), then try again." };
  if (r.error && (r.error as any).code === "ETIMEDOUT") return { ok: false, message: "The push timed out (no answer from the remote in 90 seconds)." };
  return { ok: false, message: out.split("\n").slice(-4).join("\n") || "The push failed." };
}

export interface GithubIdentity {
  remoteUrl: string | null;
  /** owner/name when the remote is a GitHub URL. */
  repo: string | null;
  author: { name: string; email: string };
  /** The account the GitHub CLI is signed in as, if it is installed and signed in. */
  ghAccount: string | null;
  ghInstalled: boolean;
  helper: string;
}

/** Who pushes from here will be: commits carry the git author; the push itself uses whatever credentials git finds. */
export function githubIdentity(root: string): GithubIdentity {
  const cfg = (k: string) => sh("git", ["config", k], root).stdout.trim();
  const url = sh("git", ["remote", "get-url", "origin"], root);
  const remoteUrl = url.code === 0 ? url.stdout.trim().replace(/\/\/[^@/]+@/, "//") : null; // never show a token embedded in a URL
  const m = remoteUrl ? /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl) : null;
  const gh = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], { cwd: root, encoding: "utf8", timeout: 6000 });
  const ghInstalled = !(gh.error && (gh.error as any).code === "ENOENT");
  const acct = /Logged in to github\.com (?:account|as) (\S+)/.exec(`${gh.stdout ?? ""}${gh.stderr ?? ""}`);
  return { remoteUrl, repo: m ? m[1] : null, author: { name: cfg("user.name"), email: cfg("user.email") }, ghAccount: acct ? acct[1] : null, ghInstalled, helper: cfg("credential.helper") };
}
