import type { Paths } from "../config.js";
import { termsOf } from "../terms.js";
import { project } from "./context.js";
import { fold, readEvents } from "./events.js";
import { openMemory } from "./notes.js";

/**
 * The summary a model starts from when it takes over a task (a different provider, a fresh session after compaction,
 * the backup after a usage limit): what the task has established — goal, plan, files touched and read, the earlier
 * model's findings and last answer — plus the few project notes most relevant to it. Everything else in project memory
 * stays behind `recall`. Notes whose files have changed since they were saved say so.
 */
export function digestWithMemory(p: Paths, taskId: string, budget: number): string {
  const state = fold(taskId, readEvents(p, taskId));
  const digest = project(state, { budget });
  let active = 0;
  let shown = "";
  try {
    const mem = openMemory(p);
    active = mem.load().filter((e) => e.status === "active").length;
    // A different model (or a fresh session) is taking over: this is exactly when what the project has already
    // learned pays for itself, so the few notes most relevant to this task go in; the rest stay behind `recall`.
    const rel = mem.relevant(termsOf([state.goal ?? "", ...state.filesTouched, ...state.filesRead].join(" ")), [...state.filesTouched, ...state.filesRead], 5);
    if (rel.length) shown = "\n\nPROJECT MEMORY (most relevant notes):\n" + rel.map((r) => { const st = mem.staleFilesOf(r.entry); return `  - (${r.entry.type}) ${r.entry.text.slice(0, 240)}${st.length ? ` [may be out of date: ${st.slice(0, 3).join(", ")} changed since]` : ""}`; }).join("\n");
  } catch {
    /* no memory store yet */
  }
  return active ? `${digest}${shown}\n\nPROJECT MEMORY: ${active} active note${active === 1 ? "" : "s"} exist for this repository${shown ? "; the most relevant are above" : ""}. Use the recall action with a topic to search the rest.` : digest;
}
