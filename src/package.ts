import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NarrowbitConfig, Paths } from "./config.js";
import { changedHunks } from "./git.js";
import { Memory, openMemory, renderMemory } from "./memory.js";
import { detectStack, rank, relatedTests, topLevelMap, type FeatureVec, type RankedFile, type RankResult, type SymbolHit } from "./ranker.js";
import { redact } from "./redact.js";
import { loadWeights } from "./train.js";
import type { Store } from "./store.js";
import type { Level, SelectedItem, TaskRecord } from "./tasks.js";
import { parseTask, type ParsedTask } from "./taskparse.js";
import { termsOf } from "./terms.js";
import { estimateTokens, now, shortId, realRel, isGitInternal, sourceText } from "./util.js";

const SNIPPET_MAX_LINES = 140;

export function readLines(root: string, path: string, start: number, end: number): string {
  let text: string;
  try {
    // Refuse anything that really lands outside the project or inside .git: this is the one reader behind the MCP
    // `nb_lines` tool and the package builder, and neither has its own path check.
    const rel = realRel(root, join(root, path));
    if (rel === null || isGitInternal(rel) || isGitInternal(path)) return "";
    text = readFileSync(join(root, path), "utf8");
  } catch {
    return "";
  }
  const lines = text.split("\n");
  return redact(lines.slice(Math.max(0, start - 1), Math.min(lines.length, end)).join("\n"));
}

export function snippet(root: string, path: string, start: number, end: number, maxLines = SNIPPET_MAX_LINES): string {
  if (end - start + 1 <= maxLines) return `// ${path}:${start}-${end}\n${readLines(root, path, start, end)}`;
  const head = Math.floor(maxLines * 0.7);
  const tail = maxLines - head;
  return (
    `// ${path}:${start}-${end} (middle elided; read lines ${start + head}-${end - tail} if needed)\n` +
    readLines(root, path, start, start + head - 1) +
    `\n  // … ${end - start + 1 - maxLines} lines elided …\n` +
    readLines(root, path, end - tail + 1, end)
  );
}

export function outline(store: Store, fileId: number, prefer: SymbolHit[] = [], limit = 10): string[] {
  const syms = store.all<{ id: number; qualified: string; kind: string; start_line: number; end_line: number; signature: string; exported: number }>(
    "SELECT id, qualified, kind, start_line, end_line, signature, exported FROM symbols WHERE file_id=? AND kind NOT IN ('test') ORDER BY start_line",
    fileId,
  );
  const pref = new Set(prefer.map((p) => p.id));
  const picked = syms
    .map((s) => ({ s, w: (pref.has(s.id) ? 10 : 0) + (s.exported ? 2 : 0) + (s.kind === "route" ? 3 : 0) + (s.kind === "method" ? 0.5 : 1) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, limit)
    .map((x) => x.s)
    .sort((a, b) => a.start_line - b.start_line);
  const lines = picked.map((s) => `  L${s.start_line}-${s.end_line} ${s.kind === "method" ? "  " : ""}${redact(s.signature)}`);
  if (syms.length > picked.length) lines.push(`  … ${syms.length - picked.length} more symbols (nb_outline)`);
  return lines;
}

/**
 * Intra-file localisation: when a file is relevant but its symbol *names* don't match the task,
 * score each function/method by the task terms its *body* contains, so we can load the right
 * function instead of only an outline of a large file.
 */
function localize(store: Store, root: string, f: RankedFile, taskTerms: Set<string>): SymbolHit[] {
  if (!taskTerms.size) return [];
  let lines: string[];
  try {
    const text = sourceText(root, join(root, f.path));
    if (text === null) return [];
    lines = text.split("\n");
  } catch {
    return [];
  }
  const syms = store.all<{ id: number; name: string; qualified: string; kind: string; start_line: number; end_line: number; signature: string }>(
    "SELECT id, name, qualified, kind, start_line, end_line, signature FROM symbols WHERE file_id=? AND kind IN ('function','method','class','route','variable')",
    f.id,
  );
  const out: SymbolHit[] = [];
  for (const s of syms) {
    const len = s.end_line - s.start_line + 1;
    if (len < 3 || len > 220) continue;
    const body = termsOf(lines.slice(s.start_line - 1, s.end_line).join("\n"));
    const distinct = new Set(body.filter((t) => taskTerms.has(t)));
    if (distinct.size < 2) continue;
    const occ = body.filter((t) => taskTerms.has(t)).length;
    // Favour specific (short) symbols that concentrate the task's vocabulary.
    const score = (distinct.size * 1.5 + Math.min(occ, 12) * 0.15) / Math.sqrt(Math.max(1, len / 40));
    out.push({ id: s.id, name: s.name, qualified: s.qualified, kind: s.kind, start: s.start_line, end: s.end_line, signature: s.signature, score, why: `body mentions ${[...distinct].slice(0, 4).join(", ")}` });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4);
}

/** One compact reason for the agent (full reasons stay in `narrowbit inspect`). */
function shortWhy(f: RankedFile): string {
  const best = [...f.reasons]
    .map((r) => ({ r, v: Number(/\(\+([\d.]+)\)$/.exec(r)?.[1] ?? 0) }))
    .sort((a, b) => b.v - a.v)[0];
  if (!best) return "";
  const text = best.r.replace(/\s*\(\+[\d.]+\)$/, "");
  return text.length > 70 ? text.slice(0, 67) + "…" : text;
}

/** Choose non-overlapping symbol snippets for a file: prefer the most specific high-scoring ranges. */
function pickSnippets(hits: SymbolHit[], max = 4): SymbolHit[] {
  if (!hits.length) return [];
  const best = hits[0].score;
  const chosen: SymbolHit[] = [];
  for (const h of hits) {
    if (h.score < best * 0.35 || chosen.length >= max) break;
    if (h.kind === "test" || h.kind === "suite") continue;
    // Trivial declarations (one-line consts) are covered by the outline; not worth a snippet.
    if ((h.kind === "variable" || h.kind === "type") && h.end - h.start < 2 && !/named in task|contains line/.test(h.why)) continue;
    // Skip a class that contains an already chosen method, and a method inside an already chosen range.
    if (chosen.some((c) => c.start <= h.start && c.end >= h.end)) continue;
    const inner = chosen.findIndex((c) => h.start <= c.start && h.end >= c.end);
    if (inner >= 0) {
      if (h.end - h.start > 80) continue;
      chosen.splice(inner, 1);
    }
    chosen.push(h);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

// Kept short: this text is sent fresh (uncached) on every task. Tool names are self-describing
// via their own MCP schemas, so they aren't re-listed here — see CLAUDE.md "fresh-token tax".
export const AGENT_PROTOCOL = `Narrowbit pre-selected the context below from a local repo index; it is current on disk.
Prefer the nb_* MCP tools over broad Glob/Grep/Bash for further lookups. Use nb_remember for decisions, constraints and failed approaches.`;

export interface BuildOptions {
  budget?: number;
  noGit?: boolean;
  source?: TaskRecord["source"];
  /** Items already delivered (for hooks within a running session). */
  exclude?: Set<string>;
  withProtocol?: boolean;
  /** Explicit ranking weights (eval/benchmark); defaults to the repo's trained weights. */
  weights?: FeatureVec;
}

export interface BuiltPackage {
  text: string;
  record: TaskRecord;
  ranking: RankResult;
  task: ParsedTask;
}

export function buildPackage(store: Store, p: Paths, cfg: NarrowbitConfig, taskText: string, opts: BuildOptions = {}): BuiltPackage {
  const t0 = Date.now();
  const budget = opts.budget ?? cfg.budget.initial;
  const task = parseTask(taskText);
  const memory = openMemory(p);
  const ranking = rank(store, p.root, task, { noGit: opts.noGit, memory, weights: opts.weights ?? loadWeights(p) });
  const rankMs = Date.now() - t0;
  const exclude = opts.exclude ?? new Set<string>();
  const given: string[] = [];

  const sections: string[] = [];
  const push = (s: string) => sections.push(s);
  const used = () => estimateTokens(sections.join("\n\n"));

  if (opts.withProtocol !== false) push(AGENT_PROTOCOL);
  push(`TASK\n${task.text.length > 2000 ? task.text.slice(0, 2000) + " …" : task.text}`);

  const stack = detectStack(p.root, store);
  const map = topLevelMap(store).slice(0, 10);
  push(
    `PROJECT\n${stack.length ? `stack: ${stack.join(", ")}\n` : ""}layout: ${map.filter((m) => m.code > 0).map((m) => `${m.dir}(${m.code})`).join(" ")}` +
      `\nselection confidence: ${ranking.confidence.toUpperCase()}${ranking.confidence === "low" ? " — treat files below as hints; use nb_search before broad exploration" : ""}`,
  );

  // Memory: constraints, decisions, failed approaches.
  const topFiles = ranking.files.slice(0, 8).map((f) => f.path);
  const mem = memory.relevant(task.terms, topFiles, 8);
  if (mem.length) push(`PROJECT MEMORY\n${mem.map((m) => renderMemory(m.entry)).join("\n")}`);

  // Git: only what is relevant to the selected files.
  if (ranking.git.head) {
    const lines = [`branch ${ranking.git.branch} @ ${ranking.git.head.slice(0, 8)}`];
    const topSet = new Set(ranking.files.slice(0, 10).map((f) => f.path));
    const dirtyRel = [...new Set([...ranking.git.dirty, ...ranking.git.staged])].filter((d) => topSet.has(d));
    const dirtyOther = ranking.git.dirty.length + ranking.git.staged.length - dirtyRel.length;
    if (dirtyRel.length) {
      const hunks = changedHunks(p.root, "HEAD", dirtyRel);
      lines.push(`uncommitted in selected files: ${dirtyRel.map((d) => `${d}${hunks.get(d) ? ` (lines ${hunks.get(d)!.slice(0, 4).map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(",")})` : ""}`).join("; ")}`);
    }
    if (dirtyOther > 0) lines.push(`${dirtyOther} other uncommitted file(s)`);
    const rel = ranking.commits.filter((c) => c.files.length <= 15 && c.files.some((f) => topSet.has(f))).slice(0, 4);
    for (const c of rel) {
      const hit = c.files.filter((f) => topSet.has(f));
      lines.push(`recent: ${c.hash.slice(0, 7)} ${c.date.slice(0, 10)} ${c.subject.slice(0, 70)} [${hit.slice(0, 3).join(", ")}${hit.length > 3 ? ", …" : ""}]`);
    }
    if (lines.length > 1) push(`GIT\n${lines.join("\n")}`);
  }

  // Code, progressively: full file → symbol snippets → outline → path only.
  const selected: SelectedItem[] = [];
  const taskTermSet = new Set(task.terms);
  const candidates = ranking.files.filter((f) => f.kind !== "test" || task.mentionsTests).slice(0, 30);
  const top = candidates[0]?.score ?? 0;
  const codeBlocks: string[] = [];
  const outlines: string[] = [];
  const listed: RankedFile[] = [];
  const reserveForTail = Math.min(900, budget * 0.12);
  const codeUsed = () => estimateTokens([...codeBlocks, ...outlines].join("\n"));

  for (let i = 0; i < candidates.length; i++) {
    const f = candidates[i];
    const remaining = budget - used() - codeUsed() - reserveForTail;
    const primary = i < 6 && f.score >= top * 0.45;
    const why = shortWhy(f);
    let level: Level = "listed";
    let tokens = 0;
    let symNames: string[] = [];
    const fileKey = `file:${f.path}`;

    if (exclude.has(fileKey)) {
      listed.push(f);
      continue;
    }
    if (primary && f.kind !== "doc") {
      let hits = f.symbols.filter((s) => !exclude.has(`sym:${f.path}#${s.qualified}`));
      if (f.tokens > cfg.maxInlineFileTokens || !pickSnippets(hits).length) {
        const local = localize(store, p.root, f, taskTermSet).filter((s) => !exclude.has(`sym:${f.path}#${s.qualified}`));
        // Merge: name-matched symbols keep priority; body-matched fill in.
        const have = new Set(hits.map((h) => h.id));
        const top = hits[0]?.score ?? 0;
        hits = [...hits, ...local.filter((l) => !have.has(l.id)).map((l) => ({ ...l, score: Math.max(l.score, top * 0.5) }))].sort((a, b) => b.score - a.score);
      }
      const snips = pickSnippets(hits);
      const snipLines = snips.reduce((a, s) => a + Math.min(SNIPPET_MAX_LINES, s.end - s.start + 1), 0);
      const fullSmall = f.tokens <= cfg.maxInlineFileTokens && (i < 2 || f.tokens < 600);
      if (fullSmall && (f.tokens <= remaining) && (!snips.length || snipLines > f.lines * 0.45)) {
        const block = `// ${f.path} (full file, ${f.lines} lines) — ${why}\n${readLines(p.root, f.path, 1, f.lines)}`;
        codeBlocks.push(block);
        level = "full";
        tokens = estimateTokens(block);
        given.push(fileKey);
        symNames = f.symbols.filter((s) => s.kind !== "test" && s.kind !== "suite").slice(0, 3).map((s) => s.qualified);
      } else if (snips.length) {
        const parts: string[] = [];
        for (const s of snips) {
          const sn = snippet(p.root, f.path, s.start, s.end);
          if (estimateTokens(parts.join("\n") + sn) > remaining) break;
          parts.push(sn);
          symNames.push(s.qualified);
          given.push(`sym:${f.path}#${s.qualified}`);
        }
        if (parts.length) {
          const ol = outline(store, f.id, f.symbols, 8);
          const block = `// ${f.path} — ${why}\n${ol.length ? `// outline:\n${ol.map((l) => "//" + l).join("\n")}\n` : ""}${parts.join("\n\n")}`;
          codeBlocks.push(block);
          level = "symbols";
          tokens = estimateTokens(block);
        }
      }
    }
    if (level === "listed" && f.kind !== "doc" && f.kind !== "other") {
      const ol = outline(store, f.id, f.symbols, primary ? 10 : 5);
      const block = `${f.path}  [score ${f.score.toFixed(1)}] ${why}${ol.length ? "\n" + ol.join("\n") : ""}`;
      if (estimateTokens(block) <= remaining && outlines.length < 10) {
        outlines.push(block);
        level = "outline";
        tokens = estimateTokens(block);
        symNames = f.symbols.slice(0, 5).map((s) => s.qualified);
      }
    }
    if (level === "listed") listed.push(f);
    selected.push({ path: f.path, score: f.score, level, tokens, fileTokens: f.tokens, reasons: f.reasons, symbols: symNames });
  }

  if (codeBlocks.length) push(`RELEVANT CODE\n${codeBlocks.join("\n\n")}`);
  if (outlines.length) push(`RELATED FILES (outline: L<start>-<end> signature)\n${outlines.join("\n")}`);

  // Tests for the selected code.
  const codeIds = ranking.files.filter((f) => f.kind === "code").slice(0, 6).map((f) => f.id);
  const tests = relatedTests(store, codeIds, 5);
  const testTerms = new Set(task.terms);
  if (tests.length) {
    const lines: string[] = [];
    for (const t of tests) {
      const cases = store
        .all<{ qualified: string; start_line: number; name: string }>("SELECT qualified, start_line, name FROM symbols WHERE file_id=? AND kind='test'", t.id)
        .map((c) => ({ c, hit: c.name.toLowerCase().split(/\W+/).filter((w) => testTerms.has(w.replace(/s$/, ""))).length }))
        .filter((x) => x.hit > 0)
        .sort((a, b) => b.hit - a.hit)
        .slice(0, 3);
      lines.push(`${t.path}  (covers ${t.source}; ${t.reason})${cases.map((x) => `\n  L${x.c.start_line} ${x.c.qualified}`).join("")}`);
    }
    if (cfg.verify.testFocused) lines.push(`focused run: ${cfg.verify.testFocused.replace("{files}", tests.slice(0, 3).map((t) => t.path).join(" "))}`);
    push(`RELEVANT TESTS\n${lines.join("\n")}`);
  }

  // Paths only, no scores/reasons: nb_expand/nb_search give detail on demand, cheaper than
  // paying for it here on every task regardless of whether it's used.
  if (listed.length) push(`MORE CANDIDATES (nb_expand/nb_search for detail)\n${listed.slice(0, 8).map((f) => f.path).join(", ")}`);

  const text = sections.join("\n\n");
  const packageTokens = estimateTokens(text);
  const selectedFullTokens = selected.filter((s) => s.level !== "listed").reduce((a, s) => a + s.fileTokens, 0);

  const record: TaskRecord = {
    id: shortId(),
    text: taskText,
    createdAt: now(),
    head: ranking.git.head,
    branch: ranking.git.branch,
    dirtyAtStart: [...new Set([...ranking.git.dirty, ...ranking.git.staged, ...ranking.git.untracked])],
    budget,
    packageTokens,
    confidence: ranking.confidence,
    selected,
    tests: tests.map((t) => t.path),
    memory: mem.map((m) => m.entry.id),
    given,
    events: [],
    runs: [],
    stats: {
      repoCodeTokens: ranking.stats.repoCodeTokens,
      selectedFullTokens,
      codeFiles: ranking.stats.codeFiles,
      candidates: ranking.stats.candidates,
      rankMs,
    },
    source: opts.source ?? "cli",
  };
  return { text, record, ranking, task };
}
