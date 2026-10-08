import { termsOf } from "./terms.js";

export interface ParsedTask {
  text: string;
  terms: string[];
  /** Tokens that look like code identifiers (camelCase, PascalCase, snake_case, calls). */
  identifiers: string[];
  /** Path-ish mentions: `src/foo.ts`, `foo.ts`, `payments/verify` */
  paths: string[];
  /** Stack frames / compiler locations. */
  locations: { path: string; line?: number }[];
  errors: string[];
  quoted: string[];
  /** Asks for a change or reports a defect ("fix", "add", "crashes", …) rather than asking a general question. */
  mentionsAction: boolean;
  mentionsTests: boolean;
  mentionsRecent: boolean;
}

/** Longest stretch of one line (and of the whole text) the pattern scans look at: a pasted log with a 100 KB base64 line must not
 * make a regular-expression scan quadratic. The task text itself is kept whole; only what is scanned for paths and names is capped. */
const SCAN_LINE = 500;
const SCAN_TOTAL = 100_000;

export function parseTask(fullText: string): ParsedTask {
  const text = fullText;
  const scan = fullText.length > SCAN_TOTAL || fullText.length > 5000 ? fullText.slice(0, SCAN_TOTAL).split("\n").map((l) => (l.length > SCAN_LINE ? l.slice(0, SCAN_LINE) : l)).join("\n") : fullText;
  const identifiers = new Set<string>();
  const paths = new Set<string>();
  const locations: ParsedTask["locations"] = [];
  const errors: string[] = [];
  const quoted: string[] = [];

  for (const m of scan.matchAll(/[`"']([^`"'\n]{2,120})[`"']/g)) quoted.push(m[1]);

  // Locations: "path/file.ts:12:3", "(path/file.ts:12)", "file.ts(12,3)"
  for (const m of scan.matchAll(/((?:[\w@.-]{1,100}\/){0,12}[\w@.-]{1,100}\.(?:[cm]?[jt]sx?))(?::(\d+)(?::\d+)?|\((\d+),\d+\))?/g)) {
    let path = m[1].replace(/^(?:\.\/|file:\/\/)/, "");
    if (/node_modules\//.test(path)) continue;
    const line = m[2] ?? m[3];
    paths.add(path);
    if (line) locations.push({ path, line: Number(line) });
  }
  // Directory-ish mentions like payments/verify or src/auth
  for (const m of scan.matchAll(/\b((?:[\w.-]{1,100}\/){1,12}[\w.-]{1,100})\b/g)) {
    if (!/^https?:/.test(m[1]) && !m[1].includes("node_modules")) paths.add(m[1]);
  }

  for (const m of scan.matchAll(/\b([A-Za-z_$][\w$]{0,100})(\s{0,8}\()?/g)) {
    const w = m[1];
    const looksCode =
      /[a-z][A-Z]/.test(w) || /^[A-Z][a-z]+[A-Z]/.test(w) || (w.includes("_") && w.length > 3 && !/^_+$/.test(w)) || (!!m[2] && w.length > 2);
    if (looksCode) identifiers.add(w);
  }
  for (const q of quoted) if (/^[A-Za-z_$][\w$.]*$/.test(q)) identifiers.add(q.replace(/\(\)$/, ""));

  for (const line of scan.split("\n")) {
    const l = line.trim();
    if (/\b(?:\w*Error|Exception|error TS\d+|FAIL|failed|Cannot|Uncaught|TypeError|ReferenceError|expected|received)\b/i.test(l) && l.length < 400)
      errors.push(l);
  }

  return {
    text,
    terms: [...new Set(termsOf(text))],
    identifiers: [...identifiers],
    paths: [...paths],
    locations,
    errors: errors.slice(0, 10),
    quoted,
    mentionsAction:
      /\b(?:fix(?:es|ed)?|add(?:s|ed)?|implement|refactor|rename|remove|delete|update|change|create|write|debug|resolve|migrate|replace|extract|support|handle|throws?|thrown|fail(?:s|ed|ing|ure)?|crash(?:es|ed)?|bug|broken|regress(?:ion|ed)?|wrong|incorrect|error|exception|not working|doesn'?t work|no longer)\b/i.test(text),
    mentionsTests: /\b(?:tests?|specs?|vitest|jest|mocha|playwright|coverage|test suite)\b/i.test(text),
    mentionsRecent: /\b(?:recent(?:ly)?|since|regress(?:ion|ed)?|after (?:the )?(?:change|commit|update|upgrade|merge)|broke|started)\b/i.test(text),
  };
}
