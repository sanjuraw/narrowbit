/**
 * Secret redaction applied to every piece of repository text Narrowbit emits
 * (context packages, MCP responses, compressed command output).
 */
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY]"],
  [/\bsk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED KEY]"],
  [/\b(?:rzp_(?:live|test)_)[A-Za-z0-9]{10,}\b/g, "[REDACTED KEY]"],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[REDACTED STRIPE KEY]"],
  [/\bwhsec_[A-Za-z0-9]{16,}\b/g, "[REDACTED STRIPE WEBHOOK SECRET]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "[REDACTED GITHUB TOKEN]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED SLACK TOKEN]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED GOOGLE KEY]"],
  [/\bgsk_[A-Za-z0-9]{20,}\b/g, "[REDACTED GROQ KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]"],
  [/(\b(?:[a-z0-9_]*(?:api[_-]?key|secret|token|passwd|password|private[_-]?key|client[_-]?secret))\b["']?\s*[:=]\s*)(["'`])([^"'`\s]{8,})\2/gi, "$1$2[REDACTED]$2"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]{3,})(@)/gi, "$1[REDACTED]$3"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/**
 * Same patterns as redact(), but reporting what matched instead of hiding it — used by `narrowbit audit`
 * and the commit check. `certain` marks formats that are unmistakably a credential (a GitHub token,
 * an AWS key); the generic `apiKey = "..."` rule is only a hint, since test fixtures and placeholders
 * look the same.
 */
export function findSecrets(text: string): { label: string; certain: boolean; line: number }[] {
  const found: { label: string; certain: boolean; line: number }[] = [];
  for (const [re, rep] of PATTERNS) {
    const label = rep.startsWith("[REDACTED ") ? rep.slice(1, -1).toLowerCase().replace("redacted ", "") : "hardcoded secret-looking value";
    const certain = rep.startsWith("[REDACTED ");
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const line = text.slice(0, m.index ?? 0).split("\n").length;
      if (text.split("\n")[line - 1]?.includes("narrowbit-audit-ignore")) continue;
      found.push({ label, certain, line });
    }
  }
  return found;
}
