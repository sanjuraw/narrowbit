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
