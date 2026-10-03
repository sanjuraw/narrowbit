import type { MemoryPaths } from "./paths.js";
import { appendEvent, readEvents } from "./events.js";
import { openMemory } from "./notes.js";
import { suggestNotes, type SuggestedNote } from "./suggest.js";

/**
 * What the memory system does when a task ends, kept apart from the agent loop so it can be used (and tested) on its own.
 *
 * One short note per finished task — what was asked, the answer, which files changed — so a different model, or you next
 * week, doesn't start from nothing. Stored automatically, fetched only on demand or when a model takes over a task; a
 * follow-up replaces the task's note rather than adding another. Returns the saved note (or null when there was nothing
 * worth keeping: no substantial answer and no edits). Never throws — a note is a convenience, not part of the task.
 */
export function recordTaskNote(p: MemoryPaths, taskId: string, fallbackGoal = ""): { id: string; text: string } | null {
  try {
    const evs = readEvents(p, taskId);
    const goalText = String(evs.find((e) => e.type === "decision" && typeof e.meta?.goal === "string")?.meta?.goal ?? fallbackGoal);
    const answer = [...evs].reverse().find((e) => e.type === "decision" && e.actor === "model" && e.summary.startsWith("done: "))?.summary.slice(6).trim() ?? "";
    const changed = [...new Set(evs.filter((e) => e.type === "edit" && typeof e.meta?.path === "string").map((e) => String(e.meta!.path)))];
    if (answer.length < 30 && !changed.length) return null;
    const mem = openMemory(p);
    const text = `${goalText.slice(0, 160)} — ${answer.slice(0, 420) || "done"}${changed.length ? ` (changed: ${changed.slice(0, 6).join(", ")})` : ""}`;
    const old = mem.load().filter((e) => !e.external && e.status === "active" && e.source === taskId && (e.tags ?? []).includes("auto-task"));
    const entry = mem.add({ type: "fact", text, reason: "saved automatically when the task finished", files: changed.slice(0, 6), source: taskId, tags: ["auto-task"], confidence: "medium" });
    for (const o of old) mem.setStatus(o.id, "superseded", entry.id);
    appendEvent(p, taskId, { actor: "system", type: "decision", summary: `remembered [${entry.id}] (fact): ${text.slice(0, 200)}`, meta: { memoryId: entry.id, memoryType: "fact", auto: true } });
    return { id: entry.id, text };
  } catch {
    return null;
  }
}

/** Notes worth keeping that a person should approve (a failed-then-fixed check, a command that kept working); logged, never saved. */
export function proposeNotes(p: MemoryPaths, taskId: string): SuggestedNote[] {
  try {
    const suggested = suggestNotes(readEvents(p, taskId), openMemory(p).load().filter((e) => e.status === "active"));
    if (suggested.length) appendEvent(p, taskId, { actor: "system", type: "decision", summary: `suggested ${suggested.length} note${suggested.length === 1 ? "" : "s"} for project memory (nothing saved until you approve)`, meta: { suggested } });
    return suggested;
  } catch {
    return [];
  }
}
