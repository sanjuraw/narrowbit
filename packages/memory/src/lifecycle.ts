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
    // What the next task can't cheaply re-derive: the exact change made, and a command that really passed afterwards.
    const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    const edits = evs.filter((e) => e.type === "edit" && typeof e.meta?.path === "string").slice(-3).map((e) => `${e.meta!.path}: \`${clip(e.meta!.old, 70)}\` -> \`${clip(e.meta!.new, 90)}\``);
    // Only the latest check after the last edit says anything about the final state: a failure after a pass is a failure.
    const lastEdit = evs.map((e) => e.type === "edit").lastIndexOf(true);
    const isCheck = (e: (typeof evs)[number]) => e.type === "verify" || (e.type === "command" && typeof e.meta?.command === "string" && /\b(test|tests|vitest|jest|mocha|pytest|tsc|typecheck|lint|eslint|ruff|mypy|build|check)\b/i.test(e.meta.command));
    const latest = [...evs.slice(lastEdit + 1)].reverse().find((e) => isCheck(e) && (e.type === "verify" ? typeof e.meta?.ok === "boolean" : typeof e.meta?.exit === "number"));
    const okNow = latest ? (latest.type === "verify" ? latest.meta!.ok === true : latest.meta!.exit === 0) : false;
    const what = latest?.type === "command" ? ` (${clip(latest.meta!.command, 100)})` : "";
    const check = !latest ? (changed.length ? " Not verified after the last edit." : "") : okNow ? (latest.type === "command" ? ` Passing check: ${clip(latest.meta!.command, 100)}.` : " Verified after the last edit.") : ` Last check failed after the last edit${what}.`;
    const text = `${goalText.slice(0, 160)} — ${answer.slice(0, 300) || "done"}${changed.length ? ` (changed: ${changed.slice(0, 6).join(", ")})` : ""}${edits.length ? ` Change: ${edits.join("; ")}.` : ""}${check}`;
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
