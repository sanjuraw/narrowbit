/**
 * Turns a raw model-call failure message into something the app can explain. Deliberately just
 * pattern matching on the text providers actually return (Claude Code: "You've hit your session
 * limit · resets 1am (Asia/Calcutta)"; HTTP APIs: 429 / quota / rate limit; auth: 401 / not logged in),
 * so a limit or sign-in problem is shown as what it is, and never retried as if it were a glitch.
 */
export type ModelErrorKind = "limit" | "auth" | "network" | "other";

export interface ClassifiedError {
  kind: ModelErrorKind;
  /** When a usage limit says it resets, e.g. "1am (Asia/Calcutta)". */
  resets?: string;
}

export function classifyModelError(message: string | undefined | null): ClassifiedError {
  const m = String(message ?? "");
  if (/hit your .{0,20}limit|usage limit|session limit|weekly limit|rate.?limit|quota|too many requests|\b429\b|exceeded your/i.test(m)) {
    const resets = /resets?\s+(?:at\s+|in\s+)?([^\n.]{2,40})/i.exec(m)?.[1]?.trim();
    return { kind: "limit", resets };
  }
  if (/not logged in|not authenticated|unauthori[sz]ed|\b401\b|\b403\b|invalid api key|authentication/i.test(m)) return { kind: "auth" };
  if (/ECONN|ENOTFOUND|EAI_AGAIN|timed out|network|fetch failed|couldn't reach|socket hang up/i.test(m)) return { kind: "network" };
  return { kind: "other" };
}

/** Retrying the identical call cannot fix these. */
export function isPermanentModelError(message: string | undefined | null): boolean {
  const k = classifyModelError(message).kind;
  return k === "limit" || k === "auth";
}
