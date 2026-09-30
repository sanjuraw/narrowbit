import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { paths, type Paths } from "./config.js";
import { appendEvent, fold, readEvents } from "./events.js";
import { initProject } from "./project.js";
import { gitArgs } from "./util.js";
import type { ModelCallOptions, ModelCallResult } from "./providers/claude-cli.js";

/**
 * A conversation before any project exists: no folder, no git, nothing to read or edit — Claude Code's
 * "discuss the idea first, create the repo once it's decided" workflow. runTask() can't be reused directly
 * (it opens the repo's index/store and shells out git in `p.root`, neither of which make sense yet), so this
 * is a deliberately small, separate path: no JSON actions, no read/edit/run — the model just replies in plain
 * text, the same shape a pure-answer task already produces (a "done: " summary), so the app's existing
 * message rendering and task-history listing work on drafts with no new UI code.
 */
const PLANNING_INSTRUCTIONS = `You are helping someone plan a brand-new software project before any code, folder or git repository exists yet. Discuss what they want to build: requirements, rough architecture, technology choices, naming. You cannot read or write any files and there is nothing to run — say so if asked to do either, don't pretend to.

Keep it conversational. When the discussion is far enough along to start building, say so plainly and mention they can use "Create project" (a button in this app) to turn it into a real folder — once that happens, whatever was decided here becomes the first real task.`;

/** All planning drafts live under one shared root in the user's home folder, not inside any project. */
export function draftsPaths(): Paths {
  return paths(join(homedir(), ".narrowbit", "drafts"));
}

export interface PlanningReply {
  taskId: string;
  text: string;
  isError: boolean;
  errorMessage?: string;
}

/** One turn of a planning conversation: appends the user's message, calls the model, appends and returns its reply. */
export async function planningReply(
  taskId: string | undefined,
  text: string,
  call: (o: ModelCallOptions) => Promise<ModelCallResult>,
  model: string,
  effort: string,
  claudeBin?: string,
): Promise<PlanningReply> {
  const p = draftsPaths();
  const id = taskId ?? `pl-${randomUUID().slice(0, 8)}`;
  const prior = readEvents(p, id);
  const continuing = prior.length > 0;
  appendEvent(p, id, { actor: "user", type: "decision", summary: text.slice(0, 300), meta: continuing ? { followUp: text } : { goal: text } });
  const last = [...prior].reverse().find((e) => e.type === "model_call" && typeof e.meta?.sessionId === "string");
  const sessionId = (last?.meta?.sessionId as string | undefined) ?? randomUUID();
  const resume = !!last;
  const res = await call({
    cwd: homedir(), // no project folder exists yet; the model is told not to touch files, so cwd is never used for real work
    systemPrompt: resume ? undefined : PLANNING_INSTRUCTIONS,
    prompt: text,
    model,
    effort,
    role: "planning-chat",
    sessionId,
    resume,
    claudeBin,
  });
  appendEvent(p, id, {
    actor: "model",
    type: "model_call",
    summary: res.isError ? `planning: model call failed${res.errorMessage ? ` — ${res.errorMessage.slice(0, 200)}` : ""}` : `done: ${res.text.slice(0, 300)}`,
    tokens: { model, role: "planning-chat", inputTokens: res.usage.input, cacheCreationTokens: res.usage.cacheCreate, cacheReadTokens: res.usage.cacheRead, outputTokens: res.usage.output, costUsd: res.costUsd ?? 0 },
    meta: { sessionId: res.sessionId ?? sessionId },
  });
  if (res.isError) return { taskId: id, text: "", isError: true, errorMessage: res.errorMessage };
  appendEvent(p, id, { actor: "system", type: "decision", summary: "outcome: done", meta: { outcome: "done", summary: res.text.slice(0, 300) } });
  return { taskId: id, text: res.text, isError: false };
}

/** A digest of a draft's whole conversation, to seed the first real task once the project is created. */
export function draftDigest(taskId: string): string {
  const p = draftsPaths();
  const events = readEvents(p, taskId);
  const turns = events
    .filter((e) => e.type === "decision" && (e.actor === "user" || (e.actor === "model" && e.summary.startsWith("done: "))))
    .map((e) => (e.actor === "user" ? `User: ${e.summary}` : `Assistant: ${e.summary.slice(6)}`));
  return turns.join("\n\n");
}

export function draftGoal(taskId: string): string | null {
  const state = fold(taskId, readEvents(draftsPaths(), taskId));
  return state.goal ?? null;
}

/**
 * Turns a folder — new, empty, or mid-discussion draft — into a real local project: `git init`, one commit,
 * nothing about GitHub here. Publishing is a separate, later decision (the existing Push flow). `taskId` is
 * optional: given one, the project is seeded with that draft's digest as its first task; omitted, it's just
 * an empty folder to open, the same "choose a folder" action whether or not you'd been discussing it first.
 */
/**
 * Folders too broad to turn into a project: making one git-inits it and commits *everything* inside, so
 * pointing the folder picker one level too high (the disk root, /Users, ~/Documents) would sweep up
 * unrelated files — including private ones — into a repository the agent then works in.
 */
export function tooBroadForProject(dir: string): string | null {
  const d = resolve(dir);
  const home = resolve(homedir());
  if (d === sep || /^[A-Za-z]:\\?$/.test(d)) return "that's the top of the disk";
  if (d === home || home.startsWith(d + sep)) return "that's your home folder or one of the folders that contains it";
  if (dirname(d) === sep) return "that's a system-level folder";
  const TOP = ["Desktop", "Documents", "Downloads", "Library", "Pictures", "Music", "Movies", "Public", "Applications", "Dropbox", "iCloud Drive", "OneDrive"];
  if (dirname(d) === home && TOP.some((n) => n.toLowerCase() === basename(d).toLowerCase())) return `that's your whole ${basename(d)} folder`;
  return null;
}

export function createProjectFromDraft(taskId: string | undefined, targetPath: string): { root: string; seedTask: string } {
  const root = resolve(targetPath);
  const broad = tooBroadForProject(root);
  if (broad) throw new Error(`Refusing to make ${root} a project — ${broad}, and it would commit everything inside it. Pick or create a folder just for this project.`);
  // An existing folder with files in it (a hand-made scaffold, a downloaded template, whatever) is just as
  // valid a starting point as an empty one — git-initing it and committing what's already there versions
  // it, it doesn't touch or discard anything, so there's no reason to refuse it the way an empty-only check
  // once did.
  const hadFiles = existsSync(root) && readdirSync(root).length > 0;
  mkdirSync(root, { recursive: true, mode: 0o755 });
  // See util.ts's sh() for why: a folder that predates Narrowbit (or a shared Mac with more than one
  // account) is very often owned by a different user than whichever one is running this, and git refuses
  // to touch a repository it doesn't own — silently, from here, since spawnSync doesn't throw on its own.
  const git = (...args: string[]) => spawnSync("git", gitArgs(root, args), { cwd: root, encoding: "utf8" });
  const init = git("init", "-q", "-b", "main");
  if (init.status !== 0) throw new Error(`git init failed: ${(init.stderr ?? "").trim() || "unknown error"}`);
  if (hadFiles) {
    const add = git("add", "-A");
    if (add.status !== 0) throw new Error(`git add failed: ${(add.stderr ?? "").trim() || "unknown error"}`);
  }
  // --allow-empty even when hadFiles: everything present might be gitignored (e.g. only a node_modules/),
  // leaving nothing staged — that's still a valid starting point, not an error.
  const commitArgs = ["commit", "-q", "--allow-empty", "-m", "Initial commit"];
  let commit = git(...commitArgs);
  if (commit.status !== 0 && /please tell me who you are|user\.name|user\.email/i.test((commit.stderr ?? "").trim())) {
    // This first commit isn't necessarily authored work (an empty one is pure scaffolding either way) — a
    // real project shouldn't need your git identity configured before you can even start talking to it,
    // any more than Claude Code would. Fall back to a placeholder identity for just this one bootstrap
    // commit, same as isolate.ts's own internal snapshots; real commits you make later still use whatever
    // identity git is actually configured with.
    commit = spawnSync("git", [...gitArgs(root, []), "-c", "user.name=narrowbit", "-c", "user.email=narrowbit@localhost", "-c", "commit.gpgsign=false", ...commitArgs], { cwd: root, encoding: "utf8" });
  }
  if (commit.status !== 0) throw new Error(`git commit failed: ${(commit.stderr ?? "").trim() || "unknown error"}`);
  initProject(paths(root), { index: false });
  const digest = taskId ? draftDigest(taskId) : "";
  const seedTask = digest ? `Based on our discussion:\n\n${digest}\n\nSet this project up accordingly.` : "";
  return { root, seedTask };
}
