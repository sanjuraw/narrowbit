import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { paths, type Paths } from "./config.js";
import { appendEvent, fold, readEvents } from "./events.js";
import { initProject } from "./project.js";
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
 * Turns a planning discussion into a real, local project: a new folder, `git init`, one commit — nothing
 * about GitHub here. Publishing is a separate, later decision (the existing Push flow), not part of this.
 */
export function createProjectFromDraft(taskId: string, targetPath: string): { root: string; seedTask: string } {
  const root = resolve(targetPath);
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error(`${root} already exists and isn't empty — pick an empty or new folder.`);
  mkdirSync(root, { recursive: true, mode: 0o755 });
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const init = git("init", "-q", "-b", "main");
  if (init.status !== 0) throw new Error(`git init failed: ${(init.stderr ?? "").trim() || "unknown error"}`);
  const commit = git("commit", "-q", "--allow-empty", "-m", "Initial commit");
  if (commit.status !== 0) {
    const err = (commit.stderr ?? "").trim();
    if (/please tell me who you are|user\.name|user\.email/i.test(err)) {
      throw new Error(`git needs your name and email before it can commit — run this once in a terminal, then try again:\n  git config --global user.name "Your Name"\n  git config --global user.email "you@example.com"`);
    }
    throw new Error(`git commit failed: ${err || "unknown error"}`);
  }
  initProject(paths(root), { index: false });
  const digest = draftDigest(taskId);
  const seedTask = digest ? `Based on our discussion:\n\n${digest}\n\nSet this project up accordingly.` : "";
  return { root, seedTask };
}
