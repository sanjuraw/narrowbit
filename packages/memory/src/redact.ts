/**
 * Secret redaction applied to every piece of repository text Narrowbit emits
 * (context packages, MCP responses, compressed command output).
 */
const PATTERNS: [RegExp, string][] = [
  // .env / shell style: NAME_WITH_SECRET=value. Token-shaped values are caught below; this catches the rest (a database
  // password, a session secret). Upper-case names at the start of a line only (the name may be just the keyword: PASSWORD=x).
  // Values of 4+ characters; a short number (MAX_TOKENS=4096), true/false/null and an already-redacted marker are left alone,
  // as are names ending in TOKENS (a count, not a credential). Not "[REDACTED …]": the commit check reads that prefix as a
  // certain credential, and a placeholder in a .env.example is only a hint.
  // Labelled values in any config style (YAML `password: x`, ini `db_password = x`, .env `PASSWORD=1234`), whatever the case. A name
  // that means a password/secret/private key has no length or number exemption (a 4-digit PIN is still a password); a type
  // annotation (`password: string`), a placeholder, and an expression (`this.token`, a call) are not values.
  [/(?<=^[ \t]{0,160}(?:(?:export|ENV|ARG)[ \t]{1,32}|-[ \t]{1,32})?["']?[\w.-]{0,64}(?:secret|passw(?:or)?d|pwd|private[_-]?key|credentials?)[\w.-]{0,64}["']?[ \t]{0,32}[:=][ \t]{0,32})(?![|>][-+0-9]*[ \t]{0,32}(?:#.*)?$)(?!\[(?:redacted|REDACTED)|\*\*\*|(?:string|number|boolean|any|unknown|never|void|null|undefined|true|false|object|bigint|symbol|required|optional)\b|(?:this|self|process|req|args|opts|options|config|env|params|props|state|ctx|os|input|data)\.|[\w.$]+[ \t]{0,32}(?:<[^>\r\n]*>)?[ \t]{0,32}\()["']?[^\s#"',;{}()\[\]<>][^\r\n#,;(){}\[\]]*/gim, "[redacted value]"],
  // Token-like names get the same, except a short count (`max_tokens: 4096`) and names that end in "tokens".
  [/(?<=^[ \t]{0,160}(?:(?:export|ENV|ARG)[ \t]{1,32}|-[ \t]{1,32})?["']?[\w.-]{0,64}(?:token|api[_-]?key|access[_-]?key|auth)[\w.-]{0,64}["']?[ \t]{0,32}[:=][ \t]{0,32})(?<!tokens["']?[ \t]{0,32}[:=][ \t]{0,32})(?![|>][-+0-9]*[ \t]{0,32}(?:#.*)?$)(?!\[(?:redacted|REDACTED)|\*\*\*|(?:string|number|boolean|any|unknown|never|void|null|undefined|true|false|object|bigint|symbol|required|optional)\b|\d{1,5}(?:\s|$|,|;)|(?:this|self|process|req|args|opts|options|config|env|params|props|state|ctx|os|input|data)\.|[\w.$]+[ \t]{0,32}(?:<[^>\r\n]*>)?[ \t]{0,32}\()["']?[^\s#"',;{}()\[\]<>][^\r\n#,;(){}\[\]]{2,}/gim, "[redacted value]"],
  // A JSON value whose key names a credential, anywhere on the line: a password/secret/private-key field is hidden whatever its
  // type or length (a number too), a token/API-key field when it is a string of 3+ characters.
  [/(?<="[\w.-]{0,64}(?:secret|passw(?:or)?d|pwd|private[_-]?key|credentials?)[\w.-]{0,64}"[ \t]{0,32}:[ \t]{0,32}")(?!\[(?:redacted|REDACTED))(?:[^"\\\r\n]|\\.)+(?=")/gi, "[redacted value]"],
  [/(?<="[\w.-]{0,64}(?:secret|passw(?:or)?d|pwd|private[_-]?key|credentials?)[\w.-]{0,64}"[ \t]{0,32}:[ \t]{0,32})-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?=[ \t]{0,32}[,}\]\r\n]|[ \t]{0,32}$)/gi, "[redacted value]"],
  // <password>value</password> and friends.
  [/(?<=<[\w.:-]{0,64}(?:secret|passw(?:or)?d|pwd|private[_-]?key|credentials?|token|api[_-]?key|access[_-]?key)[\w.:-]{0,64}(?:\s[^>]{0,300})?>)\s*(?!\[redacted)[^<\s][^<]*?(?=\s{0,32}<\/)/gi, "[redacted value]"],
  // Connection strings (`Server=db;User ID=u;Password=x;`), the Dockerfile forms `ENV PASSWORD x` and `ENV A=1 PASSWORD=x`.
  [/(?<=(?:^|;)[ \t]{0,32}(?:password|pwd)[ \t]{0,32}=[ \t]{0,32})(?!\[redacted)(?![\w.$]+[ \t]{0,32}\()[^;"'\r\n]+/gim, "[redacted value]"],
  [/(?<=^[ \t]{0,160}(?:ENV|ARG)[ \t]{1,32}[\w.-]{0,64}(?:secret|passw(?:or)?d|pwd|private[_-]?key|credentials?|token|api[_-]?key|access[_-]?key)[\w.-]{0,64}[ \t]{1,32})(?![=\[])[^\r\n]+/gim, "[redacted value]"],
  [/(?<=^[ \t]{0,160}(?:ENV|ARG)[ \t]{1,32}(?:[^\s=]{1,64}=\S{0,128}[ \t]{1,32}){1,16}[\w.-]{0,64}(?:secret|passw(?:or)?d|pwd|private[_-]?key|credentials?|token|api[_-]?key|access[_-]?key)[\w.-]{0,64}=)(?!\[redacted)\S+/gim, "[redacted value]"],
  // HTTP header lines that carry a credential.
  [/(?<=^[ \t]{0,160}(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token)[ \t]{0,32}:[ \t]{0,32})(?!\[(?:redacted|REDACTED))(?=\S)[^\r\n]+/gim, "[redacted value]"],
  // The same names as JSON keys.
  [/(?<="(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)"[ \t]{0,32}:[ \t]{0,32}")(?!\[(?:redacted|REDACTED))(?:[^"\\\r\n]|\\.)+(?=")/gi, "[redacted value]"],
  [/(?<="[\w.-]{0,64}(?:token|api[_-]?key|access[_-]?key)[\w.-]{0,64}"[ \t]{0,32}:[ \t]{0,32}")(?!\[(?:redacted|REDACTED))(?:[^"\\\r\n]|\\.){3,}(?=")/gi, "[redacted value]"],
  [/(?<=^[ \t]{0,160}(?:export[ \t]{1,32})?(?:[A-Z][A-Z0-9_]*)?(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIALS?|ACCESS_?KEY)[A-Z0-9_]*[ \t]{0,32}=[ \t]{0,32})(?<!TOKENS[ \t]{0,32}=[ \t]{0,32})(?!\[(?:redacted|REDACTED)|\*\*\*|(?:true|false|null|none)\b|\d{1,5}(?:\s|$))["']?[^\s#"'][^\r\n#]{3,}/gm, "[redacted value]"],
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
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi, "$1[REDACTED]$3"],
];

const KEY_BEGIN = /^-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const KEY_END = /^-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;

/**
 * Where private-key blocks are in the text, as [start, end) ranges. A scanner rather than a regular expression: a lazy
 * pattern from each BEGIN to a matching END is quadratic on text with many BEGINs and no END. A block with a BEGIN and no
 * END (cut off, half-copied) runs to the end of the text, since what follows is its body.
 */
function keyBlockRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let pos = 0;
  for (;;) {
    const b = text.indexOf("-----BEGIN ", pos);
    if (b < 0) break;
    const head = KEY_BEGIN.exec(text.slice(b, b + 120));
    if (!head) { pos = b + 11; continue; }
    let e = b + head[0].length, end = -1;
    for (;;) {
      const x = text.indexOf("-----END ", e);
      if (x < 0) break;
      const tail = KEY_END.exec(text.slice(x, x + 120));
      if (tail) { end = x + tail[0].length; break; }
      e = x + 9;
    }
    if (end < 0) { ranges.push([b, text.length]); break; }
    ranges.push([b, end]);
    pos = end;
  }
  return ranges;
}

function replaceRanges(text: string, ranges: [number, number][], f: (block: string) => string): string {
  if (!ranges.length) return text;
  let out = "", last = 0;
  for (const [a, b] of ranges) { out += text.slice(last, a) + f(text.slice(a, b)); last = b; }
  return out + text.slice(last);
}

const CRED_NAME = "(?:secret|passw(?:or)?d|pwd|private[_-]?key|credentials?|token|api[_-]?key|access[_-]?key)";
const HEADER_NAME = "(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token)";
const decodeEscapes = (k: string) => k.replace(/\\u([0-9a-fA-F]{4})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));

/** A key written with \uXXXX escapes (JSON `"pass\u0077ord"`, a properties file's `db.pass\u0077ord=`) is the same key; spell it plainly so the rules see it. */
function decodeCredentialKeys(text: string): string {
  if (!text.includes("\\u")) return text;
  const credLike = new RegExp(`${CRED_NAME}|^${HEADER_NAME}$`, "i");
  let out = text.replace(/"((?:[^"\\\r\n]|\\.)*)"(\s*:)/g, (m, key: string, colon: string) => {
    if (!key.includes("\\u")) return m;
    const plain = decodeEscapes(key);
    return credLike.test(plain) ? `"${plain}"${colon}` : m;
  });
  out = out.replace(/^([ \t]*[\w.\-\\]*\\u[0-9a-fA-F]{4}[\w.\-\\]*)([ \t]*[=:])/gm, (m, key: string, sep: string) => {
    const plain = decodeEscapes(key);
    return credLike.test(plain) ? plain + sep : m;
  });
  return out;
}

const indentOf = (l: string) => l.length - l.trimStart().length;

/**
 * A credential key whose value is a YAML block scalar (`password: |`) or a nested map or list (`password:` then indented lines):
 * the indented lines under it are the secret and nothing else is. Scoped by indentation, so siblings (`retries: 3`) and
 * everything after the block stay readable. Line count is unchanged.
 */
function redactYamlValues(lines: string[]): void {
  const keyRe = new RegExp(`^[ \\t]*(?:-[ \\t]+)?(["']?)[\\w.-]*${CRED_NAME}[\\w.-]*\\1[ \\t]*:[ \\t]*(.*?)\\r?$`, "i");
  for (let i = 0; i < lines.length; i++) {
    const m = keyRe.exec(lines[i]);
    if (!m) continue;
    const rest = m[2];
    const block = /^[|>][-+0-9]*[ \t]*(#.*)?$/.test(rest);
    if (!block && rest.trim() !== "") continue;
    const keyIndent = indentOf(lines[i]);
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === "" || indentOf(lines[j]) > keyIndent)) j++;
    for (let k = i + 1; k < j; k++) {
      if (!lines[k].trim()) continue;
      lines[k] = block
        ? lines[k].replace(/^([ \t]*)\S.*$/, "$1[redacted value]")
        : lines[k].replace(/^([ \t]*(?:-[ \t]+)?(?:["']?[\w.-]+["']?[ \t]*:[ \t]*)?)(?!\[redacted)\S.*$/, "$1[redacted value]");
    }
    i = j - 1;
  }
}

/** The data of a Kubernetes Secret, found object by object: only the `data:` and `stringData:` of the object whose `kind` is Secret (also inside a list), never a neighbouring document. */
function redactKubeSecrets(lines: string[]): void {
  const kindRe = /^([ \t]*(?:-[ \t]+)?)kind:[ \t]*Secret\b/i;
  for (let i = 0; i < lines.length; i++) {
    const m = kindRe.exec(lines[i]);
    if (!m) continue;
    const col = m[1].length; // the column this object's keys start at; a sibling list item or a parent key sits to its left
    const inObject = (l: string) => l.trim() === "" || (!/^---\s*$/.test(l) && indentOf(l) >= col);
    // A list item's own first line starts at col - 2 with "- ": when the item's first key came before `kind`, that line belongs to it.
    const startsItem = (l: string) => col >= 2 && new RegExp(`^[ \\t]{${col - 2}}-[ \\t]`).test(l);
    let start = i, end = i;
    while (start > 0 && (inObject(lines[start - 1]) || startsItem(lines[start - 1]))) {
      start--;
      if (startsItem(lines[start])) break;
    }
    while (end + 1 < lines.length && inObject(lines[end + 1])) end++;
    const dataRe = new RegExp(`^(?:[ \\t]{${col}}|[ \\t]{${Math.max(col - 2, 0)}}-[ \\t])(?:data|stringData):[ \\t]*$`);
    for (let k = start; k <= end; k++) {
      if (!dataRe.test(lines[k])) continue;
      let e = k + 1;
      while (e <= end && (lines[e].trim() === "" || indentOf(lines[e]) > col)) e++;
      for (let q = k + 1; q < e; q++) lines[q] = lines[q].replace(/^([ \t]+[\w.\/-]+:[ \t]*)(?!\[redacted)\S.*$/, "$1[redacted value]");
      k = e - 1;
    }
    i = end;
  }
}

/** A JSON key that names a credential and holds an object or array: every string and number leaf inside it is the secret. Strings are scanned with their escapes. */
function redactJsonSubtrees(text: string): string {
  if (!text.includes("{") && !text.includes("[")) return text;
  const re = new RegExp(`"[\\w.-]{0,64}${CRED_NAME}[\\w.-]{0,64}"[ \\t\\r\\n]{0,32}:[ \\t\\r\\n]{0,32}([{\\[])`, "gi");
  let out = "", last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    let depth = 0, i = open, inStr = false;
    // No length limit: one pass over the text in all (matching resumes after the container), and a container that never
    // closes is hidden to the end of the text rather than left readable.
    for (; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") { depth--; if (depth === 0) break; }
    }
    const end = Math.min(i + 1, text.length);
    // A container that never closes (depth still open at the end) is cut off mid-way: every string that is not a key goes, closed or not.
    const closed = depth === 0;
    const hide = (x: string) => (x.startsWith('"') ? '"[redacted value]"' : "[redacted value]");
    const chunk = text.slice(open, end);
    const body = closed
      ? chunk.replace(/"(?:[^"\\\r\n]|\\.)*"(?=\s*[,}\]])|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?=\s*[,}\]])/g, hide)
      : chunk.replace(/"(?:[^"\\\r\n]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (x, at: number) => (/^\s*:/.test(chunk.slice(at + x.length, at + x.length + 40)) ? x : hide(x)));
    out += text.slice(last, open) + body;
    last = end;
    re.lastIndex = end;
  }
  return out + text.slice(last);
}

/** An XML element named for a credential that holds other elements: the text inside them is the secret, however long the element is. One pass; an element that never closes is hidden to the end of the text. */
function redactXmlSubtrees(text: string): string {
  if (!text.includes("<")) return text;
  const open = new RegExp(`<([\\w.:-]{0,64}${CRED_NAME}[\\w.:-]{0,64})(?:\\s[^>]{0,300})?>`, "gi");
  let out = "", last = 0, m: RegExpExecArray | null;
  while ((m = open.exec(text))) {
    const from = m.index + m[0].length;
    const closer = new RegExp(`</${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`, "gi");
    closer.lastIndex = from;
    const found = closer.exec(text);
    const to = found ? found.index : text.length;
    const inner = text.slice(from, to);
    out += text.slice(last, from) + (inner.includes("<") ? inner.replace(/>([^<\s][^<]*)</g, ">[redacted value]<") : inner);
    last = to;
    open.lastIndex = to;
  }
  return out + text.slice(last);
}

/** Credential-bearing structures that span lines. Line count is preserved (so findSecrets can point at the same lines). */
function redactStructures(text: string): string {
  let out = redactXmlSubtrees(redactJsonSubtrees(text)).replace(new RegExp(`(^[ \\t]*[\\w."-]*${CRED_NAME}[\\w."-]*[ \\t]*=[ \\t]*)("""|\'\'\')([\\s\\S]*?)\\2`, "gim"), (_m, head: string, q: string, body: string) => head + q + body.split("\n").map(() => "[redacted value]").join("\n") + q);
  out = out.replace(new RegExp(`(variable\\s{1,32}"[\\w.-]{0,64}${CRED_NAME}[\\w.-]{0,64}"\\s{0,32}\\{[^}]{0,3000}?\\bdefault\\s{0,32}=\\s{0,32}")([^"\\r\\n]+)(")`, "gi"), "$1[redacted value]$3");
  if (!/(kind:[ \t]*Secret\b|(^|\n)[ \t]*(?:-[ \t]+)?[\w."-]*(?:secret|passw|pwd|private|credential|token|api|access)[\w."-]*[ \t]*:)/i.test(out)) return out;
  const lines = out.split("\n");
  redactYamlValues(lines);
  if (/kind:[ \t]*Secret\b/i.test(out)) redactKubeSecrets(lines);
  return lines.join("\n");
}

export function redact(text: string): string {
  let out = replaceRanges(text, keyBlockRanges(text), () => "[REDACTED PRIVATE KEY]");
  out = redactStructures(decodeCredentialKeys(out));
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/**
 * Same patterns as redact(), but reporting what matched instead of hiding it — used by `narrowbit audit`
 * and the commit check. `certain` marks formats that are unmistakably a credential (a GitHub token,
 * an AWS key); the generic `apiKey = "..."` rule is only a hint, since test fixtures and placeholders
 * look the same.
 */
export function findSecrets(original: string): { label: string; certain: boolean; line: number }[] {
  const found: { label: string; certain: boolean; line: number }[] = [];
  // The same normalisation redact() applies, so the detector and the scrubber agree on what counts; both keep the line count.
  const text = decodeCredentialKeys(original);
  const lines = text.split("\n");
  const starts: number[] = [];
  for (let off = 0, i = 0; i < lines.length; off += lines[i].length + 1, i++) starts.push(off);
  const lineOf = (index: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const ignored = (line: number) => lines[line - 1]?.includes("narrowbit-audit-ignore");
  for (const [a, ] of keyBlockRanges(text)) { const line = lineOf(a); if (!ignored(line)) found.push({ label: "private key", certain: true, line }); }
  const structured = redactStructures(text);
  if (structured !== text) {
    const after = structured.split("\n");
    for (let i = 0; i < lines.length; i++) if (lines[i] !== after[i] && !ignored(i + 1)) found.push({ label: "hardcoded secret-looking value", certain: false, line: i + 1 });
  }
  for (const [re, rep] of PATTERNS) {
    const label = rep.startsWith("[REDACTED ") ? rep.slice(1, -1).toLowerCase().replace("redacted ", "") : "hardcoded secret-looking value";
    const certain = rep.startsWith("[REDACTED ");
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const line = lineOf(m.index ?? 0);
      if (ignored(line)) continue;
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
  const blocks = replaceRanges(text, keyBlockRanges(text), (block) => block.split("\n").map(() => "[REDACTED PRIVATE KEY]").join("\n"));
  // Structures that span lines (a JSON "credentials" object, an XML <password> element, a Kubernetes Secret) are judged on the whole
  // file, so that picking a few lines out of it can't leave a value without the label above it. Line numbers stay the same.
  return redactStructures(decodeCredentialKeys(blocks));
}

/**
 * A shell command as shown or logged: a credential written into it (`password=…`, `--token …`, a header, a token-shaped string)
 * is hidden. Only the display is changed; the command that runs is the one given.
 */
export function redactCommand(command: string): string {
  const hide = (_m: string, head: string, q: string, value: string) => (value.startsWith("$") ? _m : `${head}${q}[redacted value]`);
  return redact(command)
    .replace(new RegExp(`(\\b[\\w.-]*${CRED_NAME}[\\w.-]*=)(['"]?)(?!\\[redacted)([^\\s'"]+)`, "gi"), hide)
    .replace(new RegExp(`(\\s--?[\\w-]*${CRED_NAME}[\\w-]*\\s+)(['"]?)(?!\\[redacted)([^\\s'"]+)`, "gi"), hide);
}
