import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, copyFileSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Paths } from "./config.js";
import { sh } from "./util.js";

/**
 * Isolated runs: the agent works in a throwaway git worktree instead of the user's folder, so a bad
 * command or a half-finished edit can't touch their working tree. The worktree starts as an exact copy
 * of what the folder looks like now (HEAD plus uncommitted and untracked work, committed there as a
 * "snapshot"), so `git diff <snapshot>` is precisely what the agent did. Nothing reaches the real folder
 * until the user presses Apply, which applies that diff as ordinary uncommitted changes.
 */
interface Marker {
  dir: string;
  snapshot: string;
}

const markerFile = (p: Paths, taskId: string) => join(p.runtime, taskId, "isolated.json");

const worktreeDir = (p: Paths, taskId: string) => join(p.nb, "worktrees", taskId);

/**
 * The marker is a file on disk, so it's only believed where it points at the one place Narrowbit itself puts a
 * task's copy (`.narrowbit/worktrees/<taskId>`). Discard deletes that folder recursively: a marker edited to point
 * anywhere else (by anything that can write to .narrowbit) must not be able to aim that deletion.
 */
export function readIsolated(p: Paths, taskId: string): Marker | null {
  if (!/^rt-[\w-]+$/.test(taskId)) return null;
  try {
    const m = JSON.parse(readFileSync(markerFile(p, taskId), "utf8")) as Marker;
    if (typeof m?.dir !== "string" || typeof m?.snapshot !== "string" || !/^[0-9a-f]{40}$/.test(m.snapshot)) return null;
    const expected = worktreeDir(p, taskId);
    if (resolve(m.dir) !== resolve(expected) || !existsSync(m.dir)) return null;
    if (realpathSync(m.dir) !== join(realpathSync(p.nb), "worktrees", taskId)) return null; // no symlinked worktrees dir either
    return { dir: expected, snapshot: m.snapshot };
  } catch {
    return null;
  }
}

const GIT = ["-c", "user.name=narrowbit", "-c", "user.email=narrowbit@localhost", "-c", "commit.gpgsign=false"];

/** Creates the worktree for a task (or returns the existing one, for follow-ups). Throws with a plain message if it can't. */
export function ensureIsolated(p: Paths, taskId: string): Marker {
  const existing = readIsolated(p, taskId);
  if (existing) return existing;
  const root = p.root;
  if (sh("git", ["rev-parse", "HEAD"], root).code !== 0) throw new Error("Isolated mode needs a git repository with at least one commit.");
  if (!/^rt-[\w-]+$/.test(taskId)) throw new Error("bad task id");
  const dir = worktreeDir(p, taskId);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  const add = sh("git", ["worktree", "add", "--detach", dir, "HEAD"], root);
  if (add.code !== 0) throw new Error(`Couldn't create the separate copy: ${add.stderr.trim().split("\n").pop()}`);

  // Bring across everything uncommitted so the agent sees the folder as it is right now.
  const tracked = sh("git", ["diff", "HEAD", "--binary"], root).stdout;
  if (tracked.trim()) sh("git", ["apply", "--binary", "--whitespace=nowarn"], dir, tracked.endsWith("\n") ? tracked : tracked + "\n");
  const untracked = sh("git", ["ls-files", "--others", "--exclude-standard", "-z"], root).stdout.split("\0").filter(Boolean);
  for (const f of untracked) {
    if (f.startsWith(".narrowbit/") || f === ".narrowbitignore") continue;
    try {
      const src = join(root, f);
      const st = lstatSync(src);
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      // A symlink stays a symlink. Copying through it (what copyFileSync does) would turn, say, a link to
      // ~/.ssh/id_ed25519 into a plain file holding the key, which the agent's symlink guard could no longer see.
      if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), join(dir, f));
      else if (st.isFile()) copyFileSync(src, join(dir, f));
    } catch {
      /* unreadable file: skip it */
    }
  }
  // Dependencies are ignored by git, so link them rather than copy: tests and builds still run in the copy.
  const nm = join(root, "node_modules");
  if (existsSync(nm) && !existsSync(join(dir, "node_modules"))) {
    try {
      symlinkSync(nm, join(dir, "node_modules"), "dir");
    } catch {
      /* not fatal */
    }
  }
  sh("git", ["add", "-A", "--", ".", ":(exclude)node_modules"], dir);
  sh("git", [...GIT, "commit", "-q", "--allow-empty", "-m", "narrowbit snapshot"], dir);
  const snapshot = sh("git", ["rev-parse", "HEAD"], dir).stdout.trim();
  const marker: Marker = { dir, snapshot };
  mkdirSync(join(p.runtime, taskId), { recursive: true, mode: 0o700 });
  writeFileSync(markerFile(p, taskId), JSON.stringify(marker), { mode: 0o600 });
  return marker;
}

/** Everything the agent changed in the copy, as a patch against its snapshot. */
export function isolatedPatch(m: Marker): string {
  sh("git", ["add", "-A", "--", ".", ":(exclude)node_modules"], m.dir);
  return sh("git", ["diff", "--cached", "--binary", m.snapshot], m.dir).stdout;
}

export function applyIsolated(p: Paths, taskId: string): { ok: boolean; message: string; files: number } {
  const m = readIsolated(p, taskId);
  if (!m) return { ok: false, message: "That separate copy no longer exists.", files: 0 };
  const patch = isolatedPatch(m);
  if (!patch.trim()) return { ok: true, message: "The agent made no changes.", files: 0 };
  const stat = sh("git", ["apply", "--numstat"], p.root, patch);
  const check = sh("git", ["apply", "--check", "--binary"], p.root, patch);
  if (check.code !== 0) return { ok: false, message: `The patch doesn't apply cleanly — the folder changed in the same places since this task began. ${check.stderr.trim().split("\n")[0]}`, files: 0 };
  const r = sh("git", ["apply", "--binary", "--whitespace=nowarn"], p.root, patch);
  if (r.code !== 0) return { ok: false, message: r.stderr.trim().split("\n")[0] || "git apply failed", files: 0 };
  return { ok: true, message: "Applied to your folder as uncommitted changes.", files: stat.stdout.split("\n").filter(Boolean).length };
}

export function discardIsolated(p: Paths, taskId: string): void {
  const m = readIsolated(p, taskId);
  if (!m) return;
  sh("git", ["worktree", "remove", "--force", m.dir], p.root);
  if (existsSync(m.dir)) rmSync(m.dir, { recursive: true, force: true });
  sh("git", ["worktree", "prune"], p.root);
  rmSync(markerFile(p, taskId), { force: true });
}
