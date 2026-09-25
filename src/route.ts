/**
 * Experimental Jev-style routing: instead of fixed rules ("Haiku until the first edit, Opus after two
 * failed checks"), ask a small local decision model which tier should handle the next turn, from compact
 * metadata only — the goal, where the task stands, and a one-line view of the last action. It never
 * receives source files. Off by default; measured against the rules in bench.ts before it earns a default.
 */
export type Tier = "explore" | "execute" | "escalate";

export interface RouteSignals {
  goal: string;
  step: number;
  maxSteps: number;
  edits: number;
  editedSinceVerify: boolean;
  checksSinceEdit: number;
  sinceLastEdit: number;
  recent: string[];
  lastResult: string;
}

export interface RouteDecision {
  tier: Tier;
  probs: Record<Tier, number>;
  confidence: number | null;
  ms: number;
}

const OPTIONS: Record<Tier, string> = {
  explore: "A small, fast, cheap model. Enough for reading files, searching, and orienting before any edit is made.",
  execute: "A balanced model. The right choice for writing edits, running tests and applying a clear fix.",
  escalate: "The strongest, most expensive model. Only for when the work is stuck: repeated failing checks, confusing results, or a hard design decision.",
};

export function describeState(s: RouteSignals): string {
  const phase = s.edits === 0 ? "still reading and orienting; no edit made yet" : s.editedSinceVerify ? `${s.edits} edit(s) made, not yet verified` : `${s.edits} edit(s) made and verified since`;
  return [
    "A coding agent is working through a task, one step at a time. Each step is handled by one of three models.",
    `Task: ${s.goal.slice(0, 400)}`,
    `Progress: step ${s.step + 1} of ${s.maxSteps}; ${phase}.`,
    `Failed checks since the last edit: ${s.checksSinceEdit}. Steps since the last edit: ${s.sinceLastEdit}.`,
    `Recent actions: ${s.recent.slice(-4).join("; ") || "none yet"}.`,
    `Result of the last action: ${s.lastResult.replace(/\s+/g, " ").slice(0, 240) || "none"}.`,
  ].join("\n");
}

export async function chooseTier(url: string, s: RouteSignals, timeoutMs = 8000): Promise<RouteDecision | null> {
  const t0 = Date.now();
  const ids = Object.keys(OPTIONS) as Tier[];
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "decider-2b",
        state: describeState(s),
        questions: { tier: { type: "choice", instructions: "Which model should handle the next step?", criteria: OPTIONS } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const a = j.answers?.tier ?? j.tier ?? {};
    const probs = { explore: 0, execute: 0, escalate: 0 } as Record<Tier, number>;
    for (const id of ids) if (typeof a.probabilities?.[id] === "number") probs[id] = a.probabilities[id];
    let tier: Tier | null = ids.includes(a.choice) ? a.choice : null;
    if (!tier) {
      const best = ids.reduce((x, y) => (probs[y] > probs[x] ? y : x), ids[0]);
      tier = probs[best] > 0 ? best : null;
    }
    return tier ? { tier, probs, confidence: typeof a.confidence === "number" ? a.confidence : null, ms: Date.now() - t0 } : null;
  } catch {
    return null;
  }
}
