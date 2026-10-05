import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Paths } from "./config.js";
import { redact } from "./redact.js";
import { estimateTokens, shortId, stripAnsi, writeProjectFile } from "./util.js";

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

const ERR_LINE = /\b(?:error|Error|ERROR|failed|FAILED|FAIL|fatal|panic|exception|Exception|Traceback|Cannot|not found|ENOENT|EADDRINUSE|ECONNREFUSED|denied|expected|received|AssertionError)\b|✗|×/;

/**
 * Collapses runs of near-identical lines (same text once numbers, hex ids and timestamps are masked) into the
 * first one plus a count — the repeated "progress 12/300", "GET /x 200 4ms" kind of noise. Error lines are never
 * grouped: two errors that differ only by line number are two different errors. (Idea from OmniRoute's RTK.)
 */
export function groupSimilar(lines: string[], minRun = 3): string[] {
  const norm = (l: string) => l.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<T>").replace(/\b[0-9a-f]{8,40}\b/gi, "<H>").replace(/\d+/g, "<N>").replace(/\s+/g, " ").trim();
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (ERR_LINE.test(l) || !l.trim()) { out.push(l); i++; continue; }
    const key = norm(l);
    let j = i + 1;
    while (j < lines.length && !ERR_LINE.test(lines[j]) && norm(lines[j]) === key) j++;
    if (j - i >= minRun) out.push(`${l}  [+${j - i - 1} similar lines]`);
    else for (let k = i; k < j; k++) out.push(lines[k]);
    i = j;
  }
  return out;
}

/**
 * Cuts long output to a token budget the way a person skims it: the start, the end (where the summary and the
 * final error usually are), and any error lines from the middle — not just the first N characters. Used for
 * command, verification and connector output; a plain file read keeps head-only, since its range is explicit.
 */
export function capOutput(text: string, capTokens = 800): string {
  if (estimateTokens(text) <= capTokens) return text;
  const lines = text.split("\n");
  const budget = Math.floor(capTokens * 3.6);
  const take = (from: number, to: number, step: 1 | -1, chars: number) => {
    const got: number[] = [];
    let used = 0;
    for (let i = from; step === 1 ? i < to : i >= to; i += step) {
      used += lines[i].length + 1;
      if (used > chars && got.length) break;
      got.push(i);
    }
    return step === 1 ? got : got.reverse();
  };
  const head = take(0, lines.length, 1, Math.floor(budget * 0.15));
  const tailAll = take(lines.length - 1, 0, -1, Math.floor(budget * 0.2));
  const tail = tailAll.filter((i) => i > head[head.length - 1]);
  const keep = new Set([...head, ...tail]);
  let used = 0;
  for (const i of keep) used += lines[i].length + 1;
  const mid: number[] = [];
  for (let i = head[head.length - 1] + 1; i < (tail[0] ?? lines.length); i++) {
    if (!ERR_LINE.test(lines[i]) || used + lines[i].length > budget) continue;
    mid.push(i);
    used += lines[i].length + 1;
    if (mid.length >= 40) break;
  }
  const chosen = [...new Set([...head, ...mid, ...tail])].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -1;
  for (const i of chosen) {
    if (prev >= 0 && i > prev + 1) out.push(`… ${i - prev - 1} line${i - prev - 1 === 1 ? "" : "s"} omitted …`);
    out.push(lines[i]);
    prev = i;
  }
  if (prev < lines.length - 1) out.push(`… ${lines.length - 1 - prev} more lines omitted …`);
  return out.join("\n") + "\n(shortened: kept the start, the end and the error lines; ask for a narrower range or query for more)";
}

/** Identifiers a reader would act on: error codes and failing test files, from lines that report a problem. (Not file:line
 * — condensers legitimately reformat locations, e.g. tsc's grouping by file.) */
function criticalTokens(raw: string, max = 20): string[] {
  const seen: string[] = [];
  for (const l of raw.split("\n")) {
    if (!ERR_LINE.test(l)) continue;
    for (const m of l.matchAll(/\bTS\d{4}\b|\b[A-Z]{2,}\d{3,}\b|\bE[A-Z]{3,}\b|(?<=FAIL\s+)\S+/g)) {
      if (!seen.includes(m[0])) seen.push(m[0]);
      if (seen.length >= max) return seen;
    }
  }
  return seen;
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

/** git diff: keep file headers and changed lines, drop index/mode noise, cap context and per-file size. */
function gitDiff(lines: string[]): Compressed | null {
  if (!lines.some((l) => l.startsWith("diff --git "))) return null;
  const out: string[] = [];
  let files = 0;
  let added = 0;
  let removed = 0;
  let inFile = 0;
  for (const l of lines) {
    if (l.startsWith("diff --git ")) {
      files++;
      inFile = 0;
      out.push(l.replace(/^diff --git a\/(.*) b\/.*$/, "FILE $1"));
    } else if (/^(?:index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|old mode|new mode)/.test(l)) continue;
    else if (l.startsWith("@@")) out.push(l.replace(/^(@@ [^@]+ @@).*/, "$1"));
    else if (l.startsWith("+") || l.startsWith("-")) {
      l.startsWith("+") ? added++ : removed++;
      if (++inFile <= 60) out.push(l.slice(0, 200));
      else if (inFile === 61) out.push("  … more changes in this file omitted");
    }
  }
  const summary = `${files} file(s) changed, +${added} -${removed}`;
  return { kind: "generic", text: [summary, ...out].join("\n"), errorCount: 0, summary };
}

/** grep -rn / rg output: cap matches per file, dedupe identical lines. */
function grepOut(lines: string[]): Compressed | null {
  const re = /^([^\s:]+):(\d+):(.*)$/;
  const hits = lines.filter((l) => re.test(l));
  if (hits.length < 25 || hits.length < lines.length * 0.8) return null;
  const per = new Map<string, string[]>();
  for (const l of hits) {
    const m = re.exec(l)!;
    (per.get(m[1]) ?? per.set(m[1], []).get(m[1])!).push(`  L${m[2]} ${m[3].trim().slice(0, 140)}`);
  }
  const out = [`${hits.length} matches in ${per.size} files`];
  for (const [f, ls] of per) out.push(f, ...ls.slice(0, 4), ...(ls.length > 4 ? [`  … ${ls.length - 4} more`] : []));
  return { kind: "generic", text: out.slice(0, 120).join("\n"), errorCount: 0, summary: out[0] };
}

export function compressOutput(raw: string, exit: number): Compressed {
  const all = stripAnsi(raw).split("\n");
  const lines = groupSimilar(collapse(all.filter((l) => !NOISE.some((re) => re.test(l)))));
  const r = tsc(lines) ?? tests(lines) ?? eslint(lines) ?? gitDiff(lines) ?? grepOut(lines) ?? npm(lines) ?? generic(lines, exit);
  // Fail-safe (from 9router's RTK): a compressor must never make things worse or hide everything.
  // Fidelity gate (idea from OmniRoute): the condensed text must still mention what the raw output reported —
  // its error codes and failing test files. If it lost more than 15% of them, the raw output wins.
  const crit = criticalTokens(raw);
  const lostTooMuch = crit.length >= 3 && crit.filter((t) => r.text.includes(t)).length < Math.ceil(crit.length * 0.85);
  if (r.text.length >= raw.length || !r.text.trim() || lostTooMuch) {
    const t = redact(raw.length > 12_000 ? raw.slice(0, 12_000) + "\n… (truncated)" : raw);
    return { kind: "generic", text: t, errorCount: r.errorCount, summary: r.summary };
  }
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

export function runCommand(p: Paths, command: string, opts: { timeoutMs?: number; cwd?: string; signal?: AbortSignal } = {}): Promise<RunResult> {
  const t0 = Date.now();
  return new Promise((resolveP) => {
    const chunks: Buffer[] = [];
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    let giveUp: NodeJS.Timeout | undefined;
    let killTree = (_sig: NodeJS.Signals) => {};
    const stop = () => {
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 3000).unref();
      // A stray process holding the output pipes would keep 'close' from firing: stop waiting for it.
      giveUp = setTimeout(() => finish(null, "SIGKILL"), 5000);
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(giveUp);
      opts.signal?.removeEventListener("abort", stop);
      process.removeListener("exit", killOnExit);
      const raw = Buffer.concat(chunks).toString("utf8");
      const exit = code ?? (signal ? 124 : 1);
      const logName = `${shortId()}.log`;
      const rawLog = join(p.logs, logName);
      try {
        writeProjectFile(dirname(p.nb), rawLog, `$ ${command}\n# exit ${exit}\n${raw}`);
      } catch {
        // Non-essential: the compressed result below still gets returned to the caller either way. This
        // callback runs from a child process's own 'close' event, outside any promise chain a caller could
        // catch — an uncaught throw here (e.g. p.logs vanished because the project folder was renamed or
        // removed out from under a running task) crashes the whole server, not just this one command.
      }
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
    };
    const killOnExit = () => killTree("SIGKILL");
    if (opts.signal?.aborted) {
      chunks.push(Buffer.from("(stopped by the user before it started — not run)\n"));
      return finish(130, null);
    }
    // Its own process group, so Stop and the timeout can end everything the command started: killing only the shell
    // left a background process (a dev server, a hung test) running, and the call waited for it.
    const child = spawn(command, { cwd: opts.cwd ?? p.root, shell: true, detached: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" } });
    killTree = (sig) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };
    process.once("exit", killOnExit);
    opts.signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    timer = setTimeout(stop, opts.timeoutMs ?? 10 * 60_000);
    child.on("close", (code, signal) => finish(code, signal));
  });
}
