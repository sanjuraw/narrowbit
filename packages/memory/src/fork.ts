import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, ensureTaskDir, readEvents, taskDir } from "./events.js";
import type { MemoryPaths } from "./paths.js";
import { shortId } from "./util.js";

/**
 * Branch a conversation from an earlier message: a new task holding everything that happened *before* that message,
 * so it can be asked something else (or the same thing differently) without touching the original. The log only ever
 * grows, so a branch is a copy of a prefix.
 *
 * What is deliberately not carried over: the provider session ids (two tasks resuming one provider conversation would
 * corrupt both — the branch starts from the written summary instead) and the token/cost figures (they were spent by the
 * original and would be counted twice). Files in the folder are not rewound; the checkpoint events stay, so Rewind works.
 */
export function forkTask(p: MemoryPaths, taskId: string, eventId: string): { taskId: string; copied: number } | { error: string } {
  const events = readEvents(p, taskId);
  const idx = events.findIndex((e) => e.id === eventId);
  if (idx < 0) return { error: "that message isn't in this conversation" };
  const at = events[idx]!;
  const isUserMessage = at.type === "decision" && at.actor === "user" && (typeof at.meta?.goal === "string" || typeof at.meta?.followUp === "string");
  if (!isUserMessage) return { error: "a conversation can only be branched from one of your messages" };
  if (idx === 0 || at.meta?.goal !== undefined) return { error: "that is the first message — there is nothing before it to branch from" };
  const newId = `rt-${shortId()}`;
  ensureTaskDir(p, newId);
  const src = join(taskDir(p, taskId), "evidence");
  if (existsSync(src)) cpSync(src, join(taskDir(p, newId), "evidence"), { recursive: true });
  let copied = 0;
  for (const e of events.slice(0, idx)) {
    const meta = e.meta ? { ...e.meta } : undefined;
    if (meta) {
      delete meta.sessionId;
      delete meta.sessionCost;
      delete meta.contextTokens;
    }
    appendEvent(p, newId, { id: e.id, at: e.at, actor: e.actor, type: e.type, summary: e.summary, evidenceRef: e.evidenceRef, meta });
    copied++;
  }
  appendEvent(p, newId, { actor: "system", type: "decision", summary: `branched from an earlier conversation, before: ${String(at.meta?.followUp ?? "").slice(0, 100)}`, meta: { forkOf: taskId, forkBefore: eventId } });
  return { taskId: newId, copied };
}
