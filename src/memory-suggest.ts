import type { Event } from "./events.js";
import type { MemoryType } from "./memory.js";

/**
 * Notes worth keeping, proposed from a finished task's event log — no model call, nothing saved or injected. The user
 * approves each one in the app; only approved notes enter project memory, and memory is still fetched only by `recall`.
 * (From ECC's continuous-learning idea: confidence-scored extraction — but proposals, never automatic injection.)
 */
export interface SuggestedNote {
  type: MemoryType;
  text: string;
  reason?: string;
  files?: string[];
  /** 0-1, from how clear the evidence is. Only proposals at or above MIN_CONFIDENCE are shown. */
  confidence: number;
}

export const MIN_CONFIDENCE = 0.6;
const MAX_NOTES = 3;

export function suggestNotes(events: Event[], existing: { text: string; files?: string[] }[] = []): SuggestedNote[] {
  const out: SuggestedNote[] = [];
  const edits = events.filter((e) => e.type === "edit" && typeof e.meta?.path === "string");
  const files = [...new Set(edits.map((e) => String(e.meta!.path)))];

  // A check that failed, then passed after edits: what was wrong and where the fix went.
  const verifies = events.filter((e) => e.type === "verify");
  const firstFail = verifies.findIndex((e) => !e.meta?.ok);
  const laterPass = firstFail >= 0 ? verifies.findIndex((e, i) => i > firstFail && e.meta?.ok) : -1;
  if (firstFail >= 0 && laterPass > firstFail && files.length) {
    const lines = String(verifies[firstFail].summary).split("\n").map((l) => l.trim()).filter((l) => l && !/^VERIFICATION (FAILED|PASSED)/i.test(l));
    const line = lines.find((l) => /error|expected|cannot|not found|assert/i.test(l)) ?? lines.find((l) => /fail/i.test(l)) ?? lines[0] ?? "a failing check";
    out.push({ type: "bug", text: `Verification failed with "${line.slice(0, 160)}"; it passed after editing ${files.slice(0, 3).join(", ")}.`, reason: "seen in a completed task", files: files.slice(0, 3), confidence: 0.8 });
  }

  // A test/build command that succeeded more than once and isn't already recorded as the repo's verify command.
  const runs = events.filter((e) => e.type === "command" && typeof e.meta?.command === "string" && e.meta.exit === 0);
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(String(r.meta!.command), (counts.get(String(r.meta!.command)) ?? 0) + 1);
  for (const [cmd, n] of counts) {
    if (n >= 2 && /\b(test|vitest|jest|pytest|cargo test|go test|tsc|build|lint)\b/.test(cmd)) out.push({ type: "command", text: `A working check for this repo: \`${cmd.slice(0, 200)}\``, reason: `ran ${n} times successfully in one task`, confidence: 0.65 });
  }

  const norm = (s: string) => s.toLowerCase().replace(/\W+/g, " ").trim();
  const have = existing.map((e) => norm(e.text));
  return out
    .filter((n) => n.confidence >= MIN_CONFIDENCE && !have.some((h) => h === norm(n.text) || (n.files?.length && have.some((x) => n.files!.every((f) => x.includes(norm(f)))))))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_NOTES);
}
