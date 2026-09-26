import type { FoldedState } from "./events.js";
import { estimateTokens } from "./util.js";

export interface ProjectionOptions {
  /** Token budget for the rendered projection; recent-event lines are dropped oldest-first to fit. */
  budget: number;
}

function render(state: FoldedState): string {
  const lines: string[] = [];
  if (state.goal) lines.push(`GOAL: ${state.goal}`);
  if (state.plan.length) {
    lines.push("PLAN:");
    for (const s of state.plan) lines.push(`  [${s.status}] ${s.text}`);
  }
  if (state.blocker) lines.push(`BLOCKER: ${state.blocker}`);
  if (state.lastVerify) lines.push(`LAST VERIFY: ${state.lastVerify.ok ? "PASSED" : "FAILED"} — ${state.lastVerify.summary}`);
  if (state.filesTouched.length) lines.push(`FILES TOUCHED: ${state.filesTouched.join(", ")}`);
  if (state.remembered.length) {
    lines.push("SAVED TO PROJECT MEMORY IN THIS TASK (already stored; search with recall, don't re-save):");
    for (const n of state.remembered) lines.push(`  - [${n.id}] (${n.type}) ${n.text}`);
  }
  if (state.recent.length) {
    lines.push("RECENT:");
    for (const e of state.recent) lines.push(`  - ${e.type}: ${e.summary}`);
  }
  return lines.join("\n");
}

/**
 * The only state a model turn sees: a bounded, summary-first render of the folded event log.
 * No transcript replay — goal/plan/blocker/last-verify are never dropped; only the oldest
 * "recent" action summaries are trimmed if the render doesn't fit the budget.
 */
export function project(state: FoldedState, opts: ProjectionOptions): string {
  let recent = state.recent;
  let text = render({ ...state, recent });
  while (estimateTokens(text) > opts.budget && recent.length > 0) {
    recent = recent.slice(1);
    text = render({ ...state, recent });
  }
  return text;
}
