/**
 * Secret redaction applied to every piece of repository text Narrowbit emits
 * (context packages, MCP responses, compressed command output).
 */
const PATTERNS: [RegExp, string][] = [
  // .env / shell style: NAME_WITH_SECRET=value. Token-shaped values are caught below; this catches the rest (a database
  // password, a session secret). Upper-case names at the start of a line only, values of 8+ characters, so ordinary code
  // and numbers like MAX_TOKENS=4096 are left alone. Not "[REDACTED …]": the commit check reads that prefix as a certain
  // credential, and a placeholder in a .env.example is only a hint.
  [/(?<=^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIALS?|ACCESS_?KEY)[A-Z0-9_]*[ \t]*=[ \t]*)(?!\[|\*\*\*)["']?[^\s#"'][^\r\n#]{6,}/gm, "[redacted value]"],
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
  // More well-known token shapes (the list of formats a secrets-scrubbing memory layer — Hindsight's — screens for).
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, "[REDACTED GITHUB TOKEN]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED GITLAB TOKEN]"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "[REDACTED NPM TOKEN]"],
  [/\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g, "[REDACTED PYPI TOKEN]"],
  [/\bhf_[A-Za-z0-9]{30,}\b/g, "[REDACTED HUGGINGFACE TOKEN]"],
  [/\bxai-[A-Za-z0-9]{20,}\b/g, "[REDACTED XAI KEY]"],
  [/\bpplx-[A-Za-z0-9]{20,}\b/g, "[REDACTED PERPLEXITY KEY]"],
  [/\br8_[A-Za-z0-9]{30,}\b/g, "[REDACTED REPLICATE TOKEN]"],
  [/\bdapi[0-9a-f]{32}\b/g, "[REDACTED DATABRICKS TOKEN]"],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, "[REDACTED GOOGLE OAUTH TOKEN]"],
  [/\bASIA[0-9A-Z]{16}\b/g, "[REDACTED AWS SESSION KEY]"],
  [/\bdop_v1_[0-9a-f]{64}\b/g, "[REDACTED DIGITALOCEAN TOKEN]"],
  [/\bsq0[a-z]{3}-[A-Za-z0-9_-]{22,}/g, "[REDACTED SQUARE TOKEN]"],
  [/\bshpat_[0-9a-f]{32}\b/g, "[REDACTED SHOPIFY TOKEN]"],
  [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, "[REDACTED SENDGRID KEY]"],
  [/\bkey-[0-9a-f]{32}\b/g, "[REDACTED MAILGUN KEY]"],
  [/\b(?:SK|AC)[0-9a-f]{32}\b/g, "[REDACTED TWILIO KEY]"],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/]{20,}/g, "[REDACTED SLACK WEBHOOK]"],
  [/\b[MNO][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}\b/g, "[REDACTED DISCORD TOKEN]"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[REDACTED TELEGRAM BOT TOKEN]"],
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

/**
 * Redacts private-key blocks line for line: every line of a block is replaced by one marker line, so line numbers stay
 * what they were. A reader that shows only some lines of a file (a window in the middle of a key) must redact the whole
 * file first; otherwise the BEGIN/END lines are outside the window and the key's body passes as ordinary text. A block
 * with a BEGIN but no END (a cut-off file) is redacted to the end.
 */
export function redactBlocksKeepingLines(text: string): string {
  const mark = (block: string) => block.split("\n").map(() => "[REDACTED PRIVATE KEY]").join("\n");
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, mark)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g, mark);
}
