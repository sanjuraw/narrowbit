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
  mentionsTests: boolean;
  mentionsRecent: boolean;
}

export function parseTask(text: string): ParsedTask {
  const identifiers = new Set<string>();
  const paths = new Set<string>();
  const locations: ParsedTask["locations"] = [];
  const errors: string[] = [];
  const quoted: string[] = [];

  for (const m of text.matchAll(/[`"']([^`"'\n]{2,120})[`"']/g)) quoted.push(m[1]);

  // Locations: "path/file.ts:12:3", "(path/file.ts:12)", "file.ts(12,3)"
  for (const m of text.matchAll(/((?:[\w@.-]+\/)*[\w@.-]+\.(?:[cm]?[jt]sx?))(?::(\d+)(?::\d+)?|\((\d+),\d+\))?/g)) {
    let path = m[1].replace(/^(?:\.\/|file:\/\/)/, "");
    if (/node_modules\//.test(path)) continue;
    const line = m[2] ?? m[3];
    paths.add(path);
    if (line) locations.push({ path, line: Number(line) });
  }
  // Directory-ish mentions like payments/verify or src/auth
  for (const m of text.matchAll(/\b((?:[\w.-]+\/)+[\w.-]+)\b/g)) {
    if (!/^https?:/.test(m[1]) && !m[1].includes("node_modules")) paths.add(m[1]);
  }

  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)(\s*\()?/g)) {
    const w = m[1];
    const looksCode =
      /[a-z][A-Z]/.test(w) || /^[A-Z][a-z]+[A-Z]/.test(w) || (w.includes("_") && w.length > 3 && !/^_+$/.test(w)) || (!!m[2] && w.length > 2);
    if (looksCode) identifiers.add(w);
  }
  for (const q of quoted) if (/^[A-Za-z_$][\w$.]*$/.test(q)) identifiers.add(q.replace(/\(\)$/, ""));

  for (const line of text.split("\n")) {
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
    mentionsTests: /\b(?:tests?|specs?|vitest|jest|mocha|playwright|coverage|test suite)\b/i.test(text),
    mentionsRecent: /\b(?:recent(?:ly)?|since|regress(?:ion|ed)?|after (?:the )?(?:change|commit|update|upgrade|merge)|broke|started)\b/i.test(text),
  };
}
