/** Small helpers the memory system needs, kept here so the package stands alone. */

export function now(): string {
  return new Date().toISOString();
}

export function shortId(): string {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 10).replace(/-/g, "");
  return `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Rough token estimate. A character heuristic (~3.6 chars/token for source code), used to budget summaries;
 * provider-reported usage is what any cost figure should be based on.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}
