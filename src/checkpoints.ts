import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Paths } from "./config.js";
import { appendEvent, readEvents } from "./events.js";

/**
 * Rewind: a snapshot of the working tree (tracked + untracked, respecting .gitignore) taken after every
 * edit the agent applies, so a task's changes can be undone back to any earlier point without touching
 * the repository's real history or HEAD. Built on plain git plumbing, the same primitives isolate.ts uses
 * for its worktree snapshot, but here the target is a floating commit object, not a checked-out copy:
 * - a throwaway index (`GIT_INDEX_FILE`) means `git add -A` never touches the user's own staged changes;
 * - `git write-tree` + `git commit-tree` makes a commit object without moving HEAD or any branch;
 * - `git update-ref refs/narrowbit/checkpoints/<taskId>/<n>` keeps that commit reachable so `git gc`
 *   never collects it (an unreferenced commit-tree object is otherwise eligible for pruning).
 * Nothing here needs the checkpoint's commit to have any ancestry relationship to the repo's real
 * history — restoring only ever reads its tree, never rebases or resets onto it.
 */
function git(root: string, args: string[], env?: Record<string, string>): { code: number; out: string } {
  // See util.ts's sh() for why every git invocation here needs this: ownership mismatches (a shared Mac, a
  // folder that predates Narrowbit) otherwise make every checkpoint silently fail — snapshotTree() below
  // would just see "not a usable git repo" and quietly skip rewind entirely, no error surfaced anywhere.
  const r = spawnSync("git", ["-c", `safe.directory=${root}`, ...args], { cwd: root, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: (r.stdout ?? r.stderr ?? "").trim() };
}

/** A tree-only commit of the working tree right now (no parent, floating), or null if this isn't a usable git repo. */
function snapshotTree(root: string): string | null {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]).out !== "true") return null;
  const dir = mkdtempSync(join(tmpdir(), "nb-ckpt-"));
  const idx = join(dir, "index");
  try {
    const env = { GIT_INDEX_FILE: idx };
    if (git(root, ["add", "-A"], env).code !== 0) return null;
    const tree = git(root, ["write-tree"], env).out;
    if (!tree) return null;
    const commit = git(root, ["commit-tree", tree, "-m", "narrowbit checkpoint"], { ...env, GIT_AUTHOR_NAME: "narrowbit", GIT_AUTHOR_EMAIL: "narrowbit@localhost", GIT_COMMITTER_NAME: "narrowbit", GIT_COMMITTER_EMAIL: "narrowbit@localhost" }).out;
    return commit || null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Checkpoint {
  /** The event's own id, used to pick a checkpoint (see events.ts's Event.id). */
  id: string;
  step: number;
  summary: string;
  at: string;
  commit: string;
}

/** Snapshots the working tree and records it as a "checkpoint" event. Silently does nothing if this
 * isn't a git repo — rewind is a convenience, its absence shouldn't fail a task. */
export function checkpointNow(p: Paths, taskId: string, step: number, summary: string): void {
  const commit = snapshotTree(p.root);
  if (!commit) return;
  git(p.root, ["update-ref", `refs/narrowbit/checkpoints/${taskId}/${step}`, commit]);
  appendEvent(p, taskId, { actor: "system", type: "checkpoint", summary: `checkpoint after step ${step}: ${summary.slice(0, 120)}`, meta: { step, commit } });
}

/** Every checkpoint recorded for a task, in order taken. */
export function listCheckpoints(p: Paths, taskId: string): Checkpoint[] {
  return readEvents(p, taskId)
    .filter((e) => e.type === "checkpoint" && typeof e.meta?.commit === "string")
    .map((e) => ({ id: e.id, step: Number(e.meta?.step ?? 0), summary: String(e.summary ?? ""), at: e.at, commit: String(e.meta?.commit) }));
}

/**
 * Restores the working tree to exactly what it looked like at `commit`: every file the checkpoint had is
 * written back, and every file that exists now but didn't at the checkpoint (created by a later step) is
 * removed. Never touches HEAD, the index, or any branch — this only ever changes files on disk, the same
 * as an edit action would, so the ordinary diff/commit/discard flow sees it as normal uncommitted changes.
 */
export function restoreCheckpoint(root: string, commit: string): { ok: boolean; message: string } {
  if (git(root, ["cat-file", "-e", `${commit}^{commit}`]).code !== 0) return { ok: false, message: "that checkpoint no longer exists (the repository may have been garbage-collected)" };
  const now = snapshotTree(root);
  const before = new Set(git(root, ["ls-tree", "-r", "--name-only", commit]).out.split("\n").filter(Boolean));
  const after = now ? new Set(git(root, ["ls-tree", "-r", "--name-only", now]).out.split("\n").filter(Boolean)) : new Set<string>();
  for (const f of after) {
    if (before.has(f)) continue;
    try {
      unlinkSync(join(root, f));
    } catch {
      /* already gone, or a race with the filesystem — either way the goal (it's not there) is met */
    }
  }
  const co = git(root, ["checkout", commit, "--", "."]);
  if (co.code !== 0) return { ok: false, message: co.out.split("\n").pop() || "the restore failed" };
  git(root, ["reset"]); // leave the changes unstaged, like an ordinary edit — checkout stages what it touches
  return { ok: true, message: `restored ${before.size} file(s)` };
}
