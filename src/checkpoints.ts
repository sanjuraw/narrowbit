import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Paths } from "./config.js";
import { appendEvent, readEvents } from "./events.js";
import { untrustedReason } from "./trust.js";
import { gitArgs } from "./util.js";

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
  // Hooks off: update-ref runs the repo's reference-transaction hook, so an automatic checkpoint would otherwise run
  // the repository's program with no approval. Checkpoints are Narrowbit's bookkeeping, not the user's git action.
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...gitArgs(root, args)], { cwd: root, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: (r.stdout ?? r.stderr ?? "").trim() };
}

/** A tree-only commit of the working tree right now (no parent, floating), or null if this isn't a usable git repo. */
function snapshotTree(root: string): string | null {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]).out !== "true") return null;
  // `git add` runs the repository's clean filters. Re-check the config now rather than trusting the check made when the
  // folder was opened: it can have changed since (a task that edited an included config file, say).
  if (untrustedReason(root)) return null;
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
/** Recovery folders are for undoing a mistaken rewind, not an archive: drop ones older than two weeks.
 * Only folders named like the timestamps restoreCheckpoint itself creates are ever removed. */
export function pruneRewindTrash(root: string, maxAgeDays = 14, nowMs = Date.now()): string[] {
  const base = join(root, ".narrowbit", "rewind-trash");
  if (!existsSync(base)) return [];
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return []; // not a readable folder: nothing to prune (the caller finds out when it tries to write there)
  }
  for (const name of names) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name);
    if (!m) continue;
    const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
    if (!Number.isFinite(at) || nowMs - at < maxAgeDays * 86_400_000) continue;
    rmSync(join(base, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** Names from git as NUL-separated output: with git's default quoting a name like café.txt comes back as "caf\303\251.txt". */
const nameList = (out: string): string[] => out.split("\0").filter(Boolean);

/** A copy that keeps a symlink a symlink: copyFileSync follows it, which would turn a link to an outside file into a
 * regular file holding that file's contents (readable by the model). Throws ENOENT if `from` doesn't exist. */
function copyKeepingLinks(from: string, to: string): void {
  if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else copyFileSync(from, to);
}

export function restoreCheckpoint(root: string, commit: string): { ok: boolean; message: string; movedTo?: string; kept?: string[]; unsaved?: string[] } {
  if (git(root, ["cat-file", "-e", `${commit}^{commit}`]).code !== 0) return { ok: false, message: "that checkpoint no longer exists (the repository may have been garbage-collected)" };
  // Everything below overwrites files, so it only starts once we know exactly what is there now: if the snapshot of the
  // current state (or any listing) fails — e.g. a git filter that errors — stop with nothing changed, never carry on
  // with empty "files to back up" lists.
  const refuse = (why: string) => ({ ok: false, message: `nothing was changed: ${why}` });
  const now = snapshotTree(root);
  if (!now) return refuse("couldn't take a snapshot of the folder as it is now (so there would be no way to keep what the rewind overwrites).");
  const lsBefore = git(root, ["ls-tree", "-r", "--name-only", "-z", commit]);
  const lsAfter = git(root, ["ls-tree", "-r", "--name-only", "-z", now]);
  const lsStaged = git(root, ["diff", "--cached", "--name-only", "-z"]);
  if (lsBefore.code !== 0 || lsAfter.code !== 0 || lsStaged.code !== 0) return refuse("git couldn't list the files involved.");
  const before = new Set(nameList(lsBefore.out));
  const after = new Set(nameList(lsAfter.out));
  const staged = new Set(nameList(lsStaged.out));
  pruneRewindTrash(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trash = join(root, ".narrowbit", "rewind-trash", stamp);
  const moved: string[] = [];
  const overwrittenSaved: string[] = [];
  const kept: string[] = [];
  // Files the checkout below will overwrite (changed since the checkpoint, by the task or by the user): keep a copy.
  const dt = git(root, ["diff-tree", "-r", "--name-only", "-z", "--no-renames", "--diff-filter=MT", commit, now]);
  if (dt.code !== 0) return refuse("git couldn't compare the checkpoint with the folder.");
  const overwritten: string[] = dt.out.split("\0").filter((f) => f && before.has(f) && after.has(f));
  const unsaved: string[] = [];
  for (const f of overwritten) {
    const to = join(trash, f);
    try {
      mkdirSync(dirname(to), { recursive: true });
      copyKeepingLinks(join(root, f), to);
      if (!moved.includes(f)) overwrittenSaved.push(f);
    } catch (e: any) {
      // A file that is already gone has nothing to keep; anything else means it is about to be overwritten uncopied.
      if (e?.code !== "ENOENT") unsaved.push(f);
    }
  }
  // Nothing is overwritten or moved unless every file about to be replaced has a recovery copy: stop here instead.
  if (unsaved.length) return { ok: false, message: `nothing was changed: couldn't save a recovery copy of ${unsaved.length} file(s) first (${unsaved.slice(0, 5).join(", ")}). Check that .narrowbit/rewind-trash is writable.`, unsaved };

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
        copyKeepingLinks(from, to); // e.g. a different filesystem; only remove the original once the copy exists
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
  if (moved.length) notes.push(`moved ${moved.length} newer file(s) to ${join(".narrowbit", "rewind-trash", stamp)} instead of deleting them (kept there for 14 days)`);
  if (kept.length) notes.push(`left ${kept.length} newer file(s) in place (staged, or could not be moved): ${kept.slice(0, 5).join(", ")}`);
  if (overwrittenSaved.length) notes.push(`kept a copy of ${overwrittenSaved.length} file(s) it overwrote in ${join(".narrowbit", "rewind-trash", stamp)}`);
  return { ok: true, message: notes.join("; "), movedTo: moved.length || overwrittenSaved.length ? trash : undefined, kept: kept.length ? kept : undefined };
}

export interface DiscardPlan {
  /** Files the agent edited, still exactly as the task left them: put back to how they were when it started. */
  restore: string[];
  /** Files the agent created with an edit, still exactly as the task left them: moved to the recovery folder. */
  remove: string[];
  /** Files the agent edited that have changed again since (by you, or anything else): left alone. */
  skipped: string[];
  /** Changed during the task, but not by one of the agent's edits — a command's output, or you working at the same
   * time. Narrowbit can't tell which, so they're left alone unless you choose to include them. */
  review: string[];
}

export interface DiscardOptions {
  /** Repo-relative paths the agent's own edit actions changed (from the task's event log). Without it, every changed
   * file counts as the agent's. */
  agentPaths?: Set<string>;
  /** Also undo the `review` files. */
  includeReview?: boolean;
}

function blobAt(root: string, commit: string, file: string): string | null {
  const r = git(root, ["rev-parse", "--verify", "--quiet", `${commit}:${file}`]);
  return r.code === 0 && r.out ? r.out : null;
}

function blobNow(root: string, file: string): string | null {
  let link: string | null = null;
  try {
    const st = lstatSync(join(root, file));
    if (st.isSymbolicLink()) link = readlinkSync(join(root, file));
  } catch {
    return null; // not there at all
  }
  // git stores a symlink as a blob of its target text; `git hash-object` on the path would hash the target's contents.
  if (link !== null) return createHash("sha1").update(`blob ${Buffer.byteLength(link)}\0`).update(link).digest("hex");
  const r = git(root, ["hash-object", "--", file]);
  return r.code === 0 && r.out ? r.out : null;
}

/**
 * What undoing one task would touch, worked out only from that task's own checkpoints and edit log: files that differ
 * between its first checkpoint (before it changed anything) and its last one (as it left the folder) AND were changed
 * by one of the agent's own edits. A file is only touched if it is still exactly as the task left it. Files that
 * changed during the task some other way (a command's output, or your own work done at the same time) are reported,
 * not reverted — attributing them to the agent would be a guess, and a wrong guess destroys your work.
 */
export function planDiscard(root: string, start: string, end: string, opts: DiscardOptions = {}): DiscardPlan {
  const names = nameList(git(root, ["diff-tree", "-r", "--name-only", "-z", "--no-renames", start, end]).out);
  const plan: DiscardPlan = { restore: [], remove: [], skipped: [], review: [] };
  for (const f of names) {
    if (f.startsWith(".narrowbit/") || f === ".narrowbitignore") continue;
    const before = blobAt(root, start, f);
    const after = blobAt(root, end, f);
    const agents = !opts.agentPaths || opts.agentPaths.has(f);
    if (blobNow(root, f) !== after) plan.skipped.push(f);
    else if (!agents && !opts.includeReview) plan.review.push(f);
    else if (before) plan.restore.push(f);
    else plan.remove.push(f);
  }
  return plan;
}

export function discardTask(root: string, start: string, end: string, opts: DiscardOptions = {}): DiscardPlan & { ok: boolean; message: string; movedTo?: string } {
  const plan = planDiscard(root, start, end, opts);
  let movedTo: string | undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trash = join(root, ".narrowbit", "rewind-trash", stamp);
  if (plan.remove.length || plan.restore.length) pruneRewindTrash(root);
  const keepCopy = (f: string, move: boolean) => {
    // A file that is already gone has nothing to copy (a deleted file being put back); only an existing one needs saving.
    try {
      lstatSync(join(root, f));
    } catch (e: any) {
      if (e?.code === "ENOENT") return;
      throw e;
    }
    const to = join(trash, f);
    mkdirSync(dirname(to), { recursive: true });
    if (move) {
      try {
        renameSync(join(root, f), to);
      } catch {
        copyKeepingLinks(join(root, f), to);
        unlinkSync(join(root, f));
      }
    } else copyKeepingLinks(join(root, f), to);
    movedTo = trash;
  };
  const removed: string[] = [];
  for (const f of plan.remove) {
    try {
      keepCopy(f, true);
      removed.push(f);
    } catch {
      /* couldn't move it: leaving it in place is the safe failure */
      plan.skipped.push(f);
    }
  }
  plan.remove = removed;
  // Nothing is overwritten without a copy: the version being replaced (the task's, or — if you chose to include
  // changes that weren't the agent's edits — whatever was there) goes to the recovery folder first.
  const restorable: string[] = [];
  for (const f of plan.restore) {
    try {
      keepCopy(f, false);
      restorable.push(f);
    } catch {
      /* can't keep a copy of it, so don't overwrite it */
      plan.skipped.push(f);
    }
  }
  plan.restore = restorable;
  if (plan.restore.length) {
    const dir = mkdtempSync(join(tmpdir(), "nb-discard-"));
    try {
      const env = { GIT_INDEX_FILE: join(dir, "index") };
      if (git(root, ["read-tree", start], env).code !== 0) return { ...plan, ok: false, message: "couldn't read the task's starting checkpoint" };
      const co = git(root, ["checkout-index", "-f", "--", ...plan.restore], env);
      if (co.code !== 0) return { ...plan, ok: false, message: co.out.split("\n").pop() || "the restore failed" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const parts = [`put back ${plan.restore.length} file(s) the agent edited`];
  if (plan.remove.length) parts.push(`moved ${plan.remove.length} file(s) it created aside`);
  if (movedTo) parts.push(`copies of everything it replaced are in ${join(".narrowbit", "rewind-trash")} (kept there for 14 days)`);
  if (plan.skipped.length) parts.push(`left ${plan.skipped.length} file(s) alone (they changed again after the task, or a copy of them couldn't be saved first)`);
  if (plan.review.length) parts.push(`left ${plan.review.length} file(s) alone that changed during the task but not through the agent's edits`);
  return { ...plan, ok: true, message: parts.join("; "), movedTo };
}
