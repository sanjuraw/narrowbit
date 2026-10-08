import { redact } from "./redact.js";
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { MemoryPaths } from "./paths.js";
import { now, shortId } from "./util.js";
import { dirname } from "node:path";
import { appendNoFollow, assertPlain, isLink, readPlain, TASK_ID } from "./safefs.js";

/**
 * Owned-runtime append-only ledger (CLAUDE.md "Handoff"): every model call, tool call, edit,
 * command and verification is one Event, written once, never rewritten. State shown to the
 * model (context.ts's project()) is always a fold of this log, never the log itself.
 */
export type Actor = "model" | "system" | "user";
export type EventType = "plan" | "tool_call" | "tool_result" | "edit" | "command" | "verify" | "model_call" | "blocker" | "decision" | "handoff" | "checkpoint";

export interface TokenUsage {
  model: string;
  /** Attribution bucket for the usage ledger, e.g. "planning" | "retrieval" | "execution" | "verification". */
  role: string;
  /** Kept separate, never collapsed into one "prompt tokens" number: fresh (input+cacheCreation) vs
   * cached (cacheRead) is the single most important distinction this whole project's benchmarks turn on. */
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface PlanStep {
  text: string;
  status: "pending" | "active" | "done" | "blocked";
}

export interface Event {
  id: string;
  taskId: string;
  at: string;
  actor: Actor;
  type: EventType;
  /** Always short and always safe to show a model; full content lives behind evidenceRef. */
  summary: string;
  evidenceRef?: string;
  tokens?: TokenUsage;
  meta?: Record<string, unknown>;
}

export function taskDir(p: MemoryPaths, taskId: string): string {
  // A task id becomes a folder name: only plain names (no "..", no "/"), whatever a shipped file or a request claims.
  if (!TASK_ID.test(taskId)) throw new Error(`invalid task id: ${JSON.stringify(taskId).slice(0, 60)}`);
  return join(p.runtime, taskId);
}

function eventsFile(p: MemoryPaths, taskId: string): string {
  return join(taskDir(p, taskId), "events.jsonl");
}

export function ensureTaskDir(p: MemoryPaths, taskId: string): string {
  const dir = taskDir(p, taskId);
  const chain = [dirname(p.runtime), p.runtime, dir, join(dir, "evidence")];
  assertPlain(...chain);
  mkdirSync(join(dir, "evidence"), { recursive: true, mode: 0o700 });
  assertPlain(...chain);
  return dir;
}

/** Every string inside event metadata, however deeply nested, passes through redact(); other values are kept as they are. */
function scrubMeta(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redact(v);
  if (v === null || typeof v !== "object") return v;
  // Too deep to check is too deep to keep: a subtree beyond the limit is dropped, never passed through unchecked.
  if (depth > 8) return "[metadata nested too deeply: removed]";
  if (Array.isArray(v)) return v.map((x) => scrubMeta(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [redact(k), scrubMeta(x, depth + 1)]));
}

function endsMidLine(file: string): boolean {
  try {
    if (isLink(file)) return false;
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      if (!size) return false;
      const b = Buffer.alloc(1);
      readSync(fd, b, 0, 1, size - 1);
      return b[0] !== 10;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function appendEvent(p: MemoryPaths, taskId: string, e: Omit<Event, "id" | "taskId" | "at"> & Partial<Pick<Event, "id" | "at">>): Event {
  ensureTaskDir(p, taskId);
  // Summaries carry model text and shell commands, either of which can contain a secret; so can any string in the metadata
  // (a model's note, a tool name, an error), which later reaches a hand-over prompt.
  const full: Event = { actor: e.actor, type: e.type, summary: redact(e.summary), evidenceRef: e.evidenceRef, tokens: e.tokens, meta: scrubMeta(e.meta) as Event["meta"], id: e.id ?? shortId(), taskId, at: e.at ?? now() };
  const file = eventsFile(p, taskId);
  // After an interrupted write the last line has no newline: start this one on a line of its own, or the two would fuse.
  appendNoFollow(file, (endsMidLine(file) ? "\n" : "") + JSON.stringify(full) + "\n");
  for (const fn of listeners.get(taskId) ?? []) fn(full);
  return full;
}

const listeners = new Map<string, Set<(e: Event) => void>>();

/** Live feed of a task's events as they're appended (the app renders these); returns an unsubscribe. */
export function subscribe(taskId: string, fn: (e: Event) => void): () => void {
  const set = listeners.get(taskId) ?? new Set();
  set.add(fn);
  listeners.set(taskId, set);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(taskId);
  };
}

export function readEvents(p: MemoryPaths, taskId: string): Event[] {
  const f = eventsFile(p, taskId);
  // A log reached through a link (a shipped one pointing at someone else's file) is not this task's history.
  if (isLink(dirname(p.runtime)) || isLink(p.runtime) || isLink(taskDir(p, taskId)) || isLink(f)) return [];
  let text: string;
  try {
    text = readPlain(f); // not through a link, and not a file that is also some other file (a hard link)
  } catch {
    return [];
  }
  const out: Event[] = [];
  for (const l of text.split("\n").filter(Boolean)) {
    // One damaged line (an append cut short) must not take the rest of the history with it.
    let ev: Event;
    try {
      ev = JSON.parse(l) as Event;
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object" || typeof ev.summary !== "string") continue;
    // A log written before metadata was scrubbed (or edited by hand) is cleaned on the way in, too.
    out.push({ ...ev, summary: redact(ev.summary), meta: scrubMeta(ev.meta) as Event["meta"] });
  }
  return out;
}

export interface FoldedState {
  taskId: string;
  goal: string | null;
  plan: PlanStep[];
  lastVerify: { ok: boolean; summary: string } | null;
  blocker: string | null;
  filesTouched: string[];
  /** Files the task has already read (paths, oldest first) — what a model taking over need not read again. */
  filesRead: string[];
  /** The model's own running commentary ("note" on its actions), most recent last: what it found and why it did things. */
  notes: string[];
  /** Final answers given so far (most recent last). */
  answers: string[];
  /** Notes this task saved to project memory with `remember` (id, type, text) — durable, so the summary always lists them. */
  remembered: { id: string; type: string; text: string }[];
  /** Non-model-call events, oldest first, capped to `recentLimit`. */
  recent: Event[];
  /** Token/cost totals per `tokens.role`, for the per-task usage ledger. */
  ledgerByRole: Record<string, { inputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; outputTokens: number; costUsd: number; calls: number }>;
}

/**
 * Pure fold: same event log always produces the same state, no model call required.
 * This is what makes the projection in context.ts testable and reproducible.
 */
export function fold(taskId: string, events: Event[], recentLimit = 8): FoldedState {
  const state: FoldedState = { taskId, goal: null, plan: [], lastVerify: null, blocker: null, filesTouched: [], filesRead: [], notes: [], answers: [], remembered: [], recent: [], ledgerByRole: {} };
  const touched = new Set<string>();
  const read = new Set<string>();
  const recent: Event[] = [];
  for (const e of events) {
    if (e.type === "decision" && typeof e.meta?.goal === "string") state.goal = e.meta.goal;
    if (e.type === "plan" && Array.isArray(e.meta?.steps)) state.plan = e.meta.steps as PlanStep[];
    if (e.type === "verify") state.lastVerify = { ok: !!e.meta?.ok, summary: e.summary };
    if (e.type === "blocker") state.blocker = e.summary;
    if (e.type === "decision" && e.meta?.resolvesBlocker) state.blocker = null;
    if (e.type === "edit" && typeof e.meta?.path === "string") touched.add(e.meta.path);
    if (e.type === "tool_call" && e.meta?.action === "read" && typeof e.meta?.path === "string") read.add(e.meta.path);
    if (e.type === "tool_call" && typeof e.meta?.note === "string" && e.meta.note.trim()) state.notes.push(e.meta.note.trim().slice(0, 240));
    if (e.type === "decision" && e.actor === "model" && e.summary.startsWith("done: ")) state.answers.push(e.summary.slice(6, 506));
    if (e.type === "decision" && typeof e.meta?.memoryId === "string") state.remembered.push({ id: e.meta.memoryId, type: String(e.meta.memoryType ?? "note"), text: e.summary.replace(/^remembered \[[^\]]*\] \([^)]*\):\s*/, "") });
    if (e.tokens) {
      const bucket = (state.ledgerByRole[e.tokens.role] ??= { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
      bucket.inputTokens += e.tokens.inputTokens;
      bucket.cacheCreationTokens += e.tokens.cacheCreationTokens;
      bucket.cacheReadTokens += e.tokens.cacheReadTokens;
      bucket.outputTokens += e.tokens.outputTokens;
      bucket.costUsd += e.tokens.costUsd;
      bucket.calls += 1;
    }
    if (e.type !== "model_call") {
      recent.push(e);
      if (recent.length > recentLimit) recent.shift();
    }
  }
  state.filesTouched = [...touched];
  state.filesRead = [...read];
  state.notes = state.notes.slice(-6);
  state.answers = state.answers.slice(-2);
  state.recent = recent;
  return state;
}
