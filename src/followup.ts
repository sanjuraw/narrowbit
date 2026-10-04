import { fold, type Event } from "./events.js";

/**
 * The prompt the composer offers (as ghost text, Tab to take it) when a task has ended, like the suggested next message in
 * the Claude app. Worked out from how the task ended, by rules: it costs no model call and no tokens, and says nothing when
 * there is nothing natural to say (a plain answer to a question).
 */
export interface Ending {
  outcome: string;
  summary: string;
  /** How many files the task changed. */
  filesChanged: number;
  errorKind?: string;
}

export function suggestFollowUp(e: Ending): string | null {
  switch (e.outcome) {
    case "done":
      if (!e.filesChanged) return null;
      // runtime.ts appends this label when edits were made and no check has confirmed them.
      return /\[Narrowbit: NOT verified/.test(e.summary) ? "Run the tests and tell me whether they pass" : "Review your changes for mistakes before I commit them";
    case "max_steps":
    case "stopped":
      return "Continue where you left off";
    case "blocked":
      return "Try a different approach";
    case "error":
      // A usage limit and a sign-in problem have their own cards; no prompt fixes either.
      return e.errorKind === "limit" || e.errorKind === "auth" ? null : "Try again";
    default:
      return null;
  }
}

/** The same, for a conversation reopened later: read from its event log. */
export function suggestionFromEvents(events: Event[]): string | null {
  const end = [...events].reverse().find((e) => e.type === "decision" && typeof e.meta?.outcome === "string");
  if (!end) return null;
  return suggestFollowUp({
    outcome: String(end.meta!.outcome),
    summary: String(end.meta!.summary ?? ""),
    filesChanged: fold(end.taskId ?? "", events).filesTouched.length,
    errorKind: typeof end.meta!.errorKind === "string" ? (end.meta!.errorKind as string) : undefined,
  });
}
