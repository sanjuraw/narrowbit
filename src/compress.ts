import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Paths } from "./config.js";
import { redact } from "./redact.js";
import { estimateTokens, shortId, stripAnsi } from "./util.js";

export interface Compressed {
  kind: "tsc" | "eslint" | "tests" | "npm" | "generic";
  text: string;
  errorCount: number;
  summary: string;
}

const NOISE = [
  /^\s*$/,
  /^\s*[|/\\-]\s*$/, // spinners
  /^\s*[⠁-⣿]+/, // braille spinners
  /\b\d{1,3}%\s*\|?[█▓▒░=#>.\s-]*\|?/, // progress bars
  /^\s*(?:✓|√|PASS|ok \d+ )\s/, // passing test lines
  /^\s*at .*node_modules/, // dependency stack frames
  /^\s*at (?:node:|internal\/|process\.processTicksAndRejections|new Promise|Generator\.next)/,
  /^npm (?:WARN|notice)/,
  /^\s*(?:RUN|DEV)\s+v\d/, // vitest banner
];

function collapse(lines: string[]): string[] {
  const out: string[] = [];
  let prev = "";
  let rep = 0;
  for (const l of lines) {
    if (l === prev) {
      rep++;
      continue;
    }
    if (rep) out.push(`  … (previous line repeated ${rep}×)`);
    rep = 0;
    out.push(l);
    prev = l;
  }
  if (rep) out.push(`  … (previous line repeated ${rep}×)`);
  return out;
}

function tsc(lines: string[]): Compressed | null {
  const re1 = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
  const re2 = /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/;
  const errs: { file: string; line: string; code: string; msg: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = re1.exec(lines[i]) ?? re2.exec(lines[i]);
    if (!m) continue;
    let msg = m[5];
    // Continuation lines (indented) belong to the message.
    for (let j = i + 1; j < lines.length && j < i + 4 && /^\s{2,}\S/.test(lines[j]) && !re1.test(lines[j]); j++) msg += " " + lines[j].trim();
    errs.push({ file: m[1], line: m[2], code: m[4], msg: msg.slice(0, 300) });
  }
  if (!errs.length) return null;
  const byFile = new Map<string, typeof errs>();
  for (const e of errs) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  const out = [`${errs.length} type error(s) in ${byFile.size} file(s)`];
  let shown = 0;
  for (const [file, list] of byFile) {
    out.push(file);
    for (const e of list) {
      if (shown++ >= 25) break;
      out.push(`  L${e.line} ${e.code}: ${e.msg}`);
    }
  }
  if (errs.length > 25) out.push(`… ${errs.length - 25} more`);
  return { kind: "tsc", text: out.join("\n"), errorCount: errs.length, summary: out[0] };
}

function eslint(lines: string[]): Compressed | null {
  const re = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}([\w@/-]+)\s*$/;
  if (!lines.some((l) => re.test(l))) return null;
  const out: string[] = [];
  let file = "";
  let errors = 0;
  let warnings = 0;
  const shownFiles: string[] = [];
  for (const l of lines) {
    const m = re.exec(l);
    if (!m) {
      if (/^\S.*\.[cm]?[jt]sx?$/.test(l.trim())) file = l.trim();
      continue;
    }
    if (m[3] === "error") errors++;
    else warnings++;
    if (m[3] !== "error" && errors > 0) continue; // warnings only when there are no errors
    if (out.length < 30) {
      if (shownFiles[shownFiles.length - 1] !== file) {
        out.push(file);
        shownFiles.push(file);
      }
      out.push(`  L${m[1]} ${m[3]} ${m[4]} (${m[5]})`);
    }
  }
  const summary = `${errors} lint error(s), ${warnings} warning(s)`;
  return { kind: "eslint", text: [summary, ...out].join("\n"), errorCount: errors, summary };
}

function tests(lines: string[]): Compressed | null {
  const summaryRe =
    /^\s*(?:Tests?:?\s+.*(?:passed|failed|total)|Test Files\s+.*|Test Suites:.*|#\s*(?:tests|pass|fail)\s+\d+|\d+ (?:passing|failing|pending)\b.*|ℹ (?:tests|pass|fail) \d+)/i;
  const summaries = lines.filter((l) => summaryRe.test(l)).map((l) => l.trim());
  const failHeader = /^\s*(?:●\s+(?!Console)|FAIL\s+|×\s+|✗\s+|✕\s+|❯\s+.*\s(?:\d+\/\d+|FAIL)|not ok \d+|\d+\) )/;
  if (!summaries.length && !lines.some((l) => failHeader.test(l))) return null;
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length && blocks.length < 12; i++) {
    if (!failHeader.test(lines[i])) continue;
    const head = lines[i].trim();
    if (seen.has(head)) continue;
    seen.add(head);
    const body: string[] = [head];
    let inRepoFrame = false;
    for (let j = i + 1; j < lines.length && body.length < 14; j++) {
      const l = lines[j];
      if (failHeader.test(l) && j > i + 1) break;
      if (/^\s*at /.test(l)) {
        if (inRepoFrame || /node_modules|node:|internal\//.test(l)) continue;
        inRepoFrame = true; // keep first in-repo frame only
      }
      if (!l.trim()) {
        if (body[body.length - 1] === "") continue;
      }
      body.push(l.replace(/\s+$/, ""));
    }
    blocks.push(body.join("\n").replace(/\n{2,}/g, "\n").trim());
  }
  const failed = (summaries.join(" ").match(/(\d+)\s+fail(?:ed|ing|ures?)?/gi) ?? []).map((s) => parseInt(s, 10));
  const errorCount = failed.length ? Math.max(...failed) : blocks.length;
  const summary = summaries.slice(-3).join(" | ") || `${blocks.length} failure block(s)`;
  return { kind: "tests", text: [summary, ...(blocks.length ? ["FAILURES", ...blocks] : [])].join("\n"), errorCount, summary };
}

function npm(lines: string[]): Compressed | null {
  const errs = lines.filter((l) => /^npm (?:ERR!|error)|^ERR_PNPM|^error /.test(l));
  if (!errs.length) return null;
  const uniq = [...new Set(errs)].slice(0, 25);
  return { kind: "npm", text: uniq.join("\n"), errorCount: uniq.length, summary: uniq[0] };
}

function generic(lines: string[], exit: number): Compressed {
  const errRe = /\b(?:error|Error|ERROR|failed|FAILED|fatal|panic|exception|Exception|Traceback|Cannot|not found|ENOENT|EADDRINUSE|ECONNREFUSED|denied)\b/;
  const idx: number[] = [];
  lines.forEach((l, i) => errRe.test(l) && idx.push(i));
  const keep = new Set<number>();
  for (const i of idx.slice(0, 20)) for (let k = Math.max(0, i - 1); k <= Math.min(lines.length - 1, i + 3); k++) keep.add(k);
  let out: string[];
  if (keep.size && exit !== 0) {
    out = [...keep].sort((a, b) => a - b).map((i) => lines[i]);
  } else if (lines.length <= 40) {
    out = lines;
  } else {
    out = [...lines.slice(0, 10), `  … ${lines.length - 35} lines omitted …`, ...lines.slice(-25)];
  }
  return { kind: "generic", text: out.join("\n"), errorCount: exit === 0 ? 0 : Math.max(1, idx.length), summary: exit === 0 ? "ok" : `exit ${exit}` };
}

export function compressOutput(raw: string, exit: number): Compressed {
  const all = stripAnsi(raw).split("\n");
  const lines = collapse(all.filter((l) => !NOISE.some((re) => re.test(l))));
  const r = tsc(lines) ?? tests(lines) ?? eslint(lines) ?? npm(lines) ?? generic(lines, exit);
  const text = r.text.length > 12_000 ? r.text.slice(0, 12_000) + "\n… (truncated)" : r.text;
  return { ...r, text: redact(text) };
}

export interface RunResult {
  command: string;
  exit: number;
  rawLog: string;
  rawLines: number;
  rawTokens: number;
  compressed: Compressed;
  compressedTokens: number;
  ms: number;
  rendered: string;
}

export function runCommand(p: Paths, command: string, opts: { timeoutMs?: number; cwd?: string } = {}): Promise<RunResult> {
  const t0 = Date.now();
  return new Promise((resolveP) => {
    const child = spawn(command, { cwd: opts.cwd ?? p.root, shell: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" } });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 10 * 60_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const exit = code ?? (signal ? 124 : 1);
      const logName = `${shortId()}.log`;
      const rawLog = join(p.logs, logName);
      writeFileSync(rawLog, `$ ${command}\n# exit ${exit}\n${raw}`, { mode: 0o600 });
      const c = compressOutput(raw, exit);
      const rawLines = raw.split("\n").length;
      const head = `$ ${command}  (exit ${exit}${signal ? `, ${signal}` : ""}; ${rawLines} lines → ${c.text.split("\n").length}; raw: ${relative(p.root, rawLog)})`;
      const rendered = `${head}\n${c.text}`;
      resolveP({
        command,
        exit,
        rawLog: relative(p.root, rawLog),
        rawLines,
        rawTokens: estimateTokens(raw),
        compressed: c,
        compressedTokens: estimateTokens(rendered),
        ms: Date.now() - t0,
        rendered,
      });
    });
  });
}
