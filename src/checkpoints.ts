import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
 * Restores the working tree to what it looked like at `commit`: every file the checkpoint had is written
 * back, and files that exist now but didn't at the checkpoint (created by a later step) are moved out of
 * the way. Never touches HEAD, the index, or any branch — this only ever changes files on disk, the same
 * as an edit action would, so the ordinary diff/commit/discard flow sees it as normal uncommitted changes.
 *
 * The checkout itself goes through a throwaway index (`GIT_INDEX_FILE`), the same trick snapshotTree()
 * uses — `git checkout <commit> -- .` followed by `git reset` was tried first, but `reset` unstages the
 * *real* index wholesale, discarding anything the user had staged before restoring that had nothing to
 * do with this task. A throwaway index never touches the real one, so there's nothing to reset afterward.
 *
 * Removing "files created since" can't tell an agent-created file from one the user created themselves in
 * this folder while the task ran (an independent review confirmed rewind was deleting both, staged ones
 * included). So rewind never deletes on that guess: a file the user has *staged* is theirs by intent and is
 * left exactly where it is, and any other newer file is moved to `.narrowbit/rewind-trash/<stamp>/` (inside
 * the self-ignored state folder, so it isn't snapshotted or committed) — the undo still works, and a wrong
 * guess costs a `mv`, not the file.
 */
export function restoreCheckpoint(root: string, commit: string): { ok: boolean; message: string; movedTo?: string; kept?: string[] } {
  if (git(root, ["cat-file", "-e", `${commit}^{commit}`]).code !== 0) return { ok: false, message: "that checkpoint no longer exists (the repository may have been garbage-collected)" };
  const now = snapshotTree(root);
  const before = new Set(git(root, ["ls-tree", "-r", "--name-only", commit]).out.split("\n").filter(Boolean));
  const after = now ? new Set(git(root, ["ls-tree", "-r", "--name-only", now]).out.split("\n").filter(Boolean)) : new Set<string>();
  const staged = new Set(git(root, ["diff", "--cached", "--name-only"]).out.split("\n").filter(Boolean));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trash = join(root, ".narrowbit", "rewind-trash", stamp);
  const moved: string[] = [];
  const kept: string[] = [];
  for (const f of after) {
    if (before.has(f)) continue;
    if (staged.has(f)) {
      kept.push(f);
      continue;
    }
    const from = join(root, f);
    if (!existsSync(from)) continue;
    const to = join(trash, f);
    try {
      mkdirSync(dirname(to), { recursive: true });
      try {
        renameSync(from, to);
      } catch {
        copyFileSync(from, to); // e.g. a different filesystem; only remove the original once the copy exists
        unlinkSync(from);
      }
      moved.push(f);
    } catch {
      /* couldn't move it: leaving the file in place is the safe failure */
      kept.push(f);
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "nb-ckpt-restore-"));
  const idx = join(dir, "index");
  try {
    const env = { GIT_INDEX_FILE: idx };
    if (git(root, ["read-tree", commit], env).code !== 0) return { ok: false, message: "the restore failed (could not read the checkpoint's tree)" };
    const co = git(root, ["checkout-index", "-a", "-f"], env);
    if (co.code !== 0) return { ok: false, message: co.out.split("\n").pop() || "the restore failed" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const notes = [`restored ${before.size} file(s)`];
  if (moved.length) notes.push(`moved ${moved.length} newer file(s) to ${join(".narrowbit", "rewind-trash", stamp)} instead of deleting them`);
  if (kept.length) notes.push(`left ${kept.length} newer file(s) in place (staged, or could not be moved): ${kept.slice(0, 5).join(", ")}`);
  return { ok: true, message: notes.join("; "), movedTo: moved.length ? trash : undefined, kept: kept.length ? kept : undefined };
}
