import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./config.js";
import { now, shortId } from "./util.js";

/**
 * Owned-runtime append-only ledger (CLAUDE.md "Handoff"): every model call, tool call, edit,
 * command and verification is one Event, written once, never rewritten. State shown to the
 * model (context.ts's project()) is always a fold of this log, never the log itself.
 */
export type Actor = "model" | "system" | "user";
export type EventType = "plan" | "tool_call" | "tool_result" | "edit" | "command" | "verify" | "model_call" | "blocker" | "decision" | "handoff";

export interface TokenUsage {
  model: string;
  /** Attribution bucket for the usage ledger, e.g. "planning" | "retrieval" | "execution" | "verification". */
  role: string;
  promptTokens: number;
  completionTokens: number;
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

export function taskDir(p: Paths, taskId: string): string {
  return join(p.runtime, taskId);
}

function eventsFile(p: Paths, taskId: string): string {
  return join(taskDir(p, taskId), "events.jsonl");
}

export function ensureTaskDir(p: Paths, taskId: string): string {
  const dir = taskDir(p, taskId);
  mkdirSync(join(dir, "evidence"), { recursive: true, mode: 0o700 });
  return dir;
}

export function appendEvent(p: Paths, taskId: string, e: Omit<Event, "id" | "taskId" | "at"> & Partial<Pick<Event, "id" | "at">>): Event {
  ensureTaskDir(p, taskId);
  const full: Event = { actor: e.actor, type: e.type, summary: e.summary, evidenceRef: e.evidenceRef, tokens: e.tokens, meta: e.meta, id: e.id ?? shortId(), taskId, at: e.at ?? now() };
  appendFileSync(eventsFile(p, taskId), JSON.stringify(full) + "\n", { mode: 0o600 });
  return full;
}

export function readEvents(p: Paths, taskId: string): Event[] {
  const f = eventsFile(p, taskId);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Event);
}

export interface FoldedState {
  taskId: string;
  goal: string | null;
  plan: PlanStep[];
  lastVerify: { ok: boolean; summary: string } | null;
  blocker: string | null;
  filesTouched: string[];
  /** Non-model-call events, oldest first, capped to `recentLimit`. */
  recent: Event[];
  /** Token/cost totals per `tokens.role`, for the per-task usage ledger. */
  ledgerByRole: Record<string, { promptTokens: number; completionTokens: number; costUsd: number; calls: number }>;
}

/**
 * Pure fold: same event log always produces the same state, no model call required.
 * This is what makes the projection in context.ts testable and reproducible.
 */
export function fold(taskId: string, events: Event[], recentLimit = 8): FoldedState {
  const state: FoldedState = { taskId, goal: null, plan: [], lastVerify: null, blocker: null, filesTouched: [], recent: [], ledgerByRole: {} };
  const touched = new Set<string>();
  const recent: Event[] = [];
  for (const e of events) {
    if (e.type === "decision" && typeof e.meta?.goal === "string") state.goal = e.meta.goal;
    if (e.type === "plan" && Array.isArray(e.meta?.steps)) state.plan = e.meta.steps as PlanStep[];
    if (e.type === "verify") state.lastVerify = { ok: !!e.meta?.ok, summary: e.summary };
    if (e.type === "blocker") state.blocker = e.summary;
    if (e.type === "decision" && e.meta?.resolvesBlocker) state.blocker = null;
    if (e.type === "edit" && typeof e.meta?.path === "string") touched.add(e.meta.path);
    if (e.tokens) {
      const bucket = (state.ledgerByRole[e.tokens.role] ??= { promptTokens: 0, completionTokens: 0, costUsd: 0, calls: 0 });
      bucket.promptTokens += e.tokens.promptTokens;
      bucket.completionTokens += e.tokens.completionTokens;
      bucket.costUsd += e.tokens.costUsd;
      bucket.calls += 1;
    }
    if (e.type !== "model_call") {
      recent.push(e);
      if (recent.length > recentLimit) recent.shift();
    }
  }
  state.filesTouched = [...touched];
  state.recent = recent;
  return state;
}
