import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { isGeneratedPath } from "./files.js";
import { fileRecency, gitState, recentCommits, type CommitInfo, type GitState } from "./git.js";
import type { Memory, MemoryEntry } from "./memory.js";
import type { Store } from "./store.js";
import type { ParsedTask } from "./taskparse.js";
import { splitIdentifier, normTerm } from "./terms.js";

/**
 * Rule-based relevance weights. Placeholders to be tuned against `narrowbit eval`
 * and real benchmark runs — every weight here should earn its keep with data.
 */
export const WEIGHTS = {
  lexicalMax: 8, // BM25 over identifier/comment/path terms, normalised to top file
  symbolExact: 10, // task names an identifier that is defined here
  symbolFuzzy: 6, // max for partial symbol-name term overlap
  pathExact: 12, // task mentions this file path
  pathPartial: 4, // task mentions a directory/stem of this path
  location: 12, // stack frame / compiler location points here
  memoryFile: 4, // an active memory entry relevant to the task references this file
  dirty: 1.5,
  dirtyRecent: 4,
  recency: 1.2,
  recencyRecent: 3.5,
  neighbor: 0.3, // fraction of a seed's score given to import neighbours
  neighborCap: 5,
  caller: 2.5, // references a seed symbol
  testPenalty: 0.45,
  docPenalty: 0.5,
  configPenalty: 0.5,
  generatedPenalty: 0.25,
};

export interface SymbolHit {
  id: number;
  name: string;
  qualified: string;
  kind: string;
  start: number;
  end: number;
  signature: string;
  score: number;
  why: string;
}

export interface RankedFile {
  id: number;
  path: string;
  kind: string;
  tokens: number;
  lines: number;
  score: number;
  reasons: string[];
  symbols: SymbolHit[];
}

export interface RankResult {
  files: RankedFile[];
  memory: { entry: MemoryEntry; score: number; why: string }[];
  git: GitState;
  commits: CommitInfo[];
  confidence: "high" | "medium" | "low";
  stats: { candidates: number; codeFiles: number; repoCodeTokens: number };
}

interface SymRow {
  id: number;
  file_id: number;
  name: string;
  qualified: string;
  kind: string;
  start_line: number;
  end_line: number;
  signature: string;
  exported: number;
}

export interface RankOptions {
  /** Disable git signals (used by history eval to avoid leaking the answer). */
  noGit?: boolean;
  memory?: Memory;
}

/**
 * Morphological neighbours of task terms present in the index, e.g. verification ↔ verify,
 * validation ↔ validate, auth ↔ authentication. Exact terms weigh 1, neighbours 0.6.
 */
export function expandTerms(store: Store, terms: string[]): Map<string, number> {
  const out = new Map<string, number>(terms.map((t) => [t, 1]));
  for (const t of terms) {
    if (t.length < 4) continue;
    const base = t.replace(/[ye]$/, "");
    if (base.length >= 4) {
      for (const r of store.all<{ term: string }>("SELECT DISTINCT term FROM terms WHERE term >= ? AND term < ? LIMIT 25", base, base + "\uffff"))
        if (!out.has(r.term) && r.term.length <= t.length + 10) out.set(r.term, 0.6);
    }
    const prefixes: string[] = [];
    for (let k = 5; k < t.length; k++) {
      const p = t.slice(0, k);
      prefixes.push(p, p + "e", p + "y");
    }
    if (prefixes.length) {
      const ph = prefixes.map(() => "?").join(",");
      for (const r of store.all<{ term: string }>(`SELECT DISTINCT term FROM terms WHERE term IN (${ph})`, ...prefixes))
        if (!out.has(r.term) && t.startsWith(r.term.replace(/[ye]$/, ""))) out.set(r.term, 0.6);
    }
  }
  return out;
}

export function rank(store: Store, root: string, task: ParsedTask, opts: RankOptions = {}): RankResult {
  const files = store.all<{ id: number; path: string; kind: string; tokens: number; lines: number }>(
    "SELECT id, path, kind, tokens, lines FROM files",
  );
  const byId = new Map(files.map((f) => [f.id, f]));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const N = Math.max(files.length, 1);
  const score = new Map<number, number>();
  const reasons = new Map<number, string[]>();
  const symHits = new Map<number, SymbolHit[]>();
  const add = (fid: number, s: number, why: string) => {
    if (!s || !byId.has(fid)) return;
    score.set(fid, (score.get(fid) ?? 0) + s);
    const r = reasons.get(fid) ?? [];
    r.push(`${why} (+${s.toFixed(1)})`);
    reasons.set(fid, r);
  };
  const addSym = (fid: number, s: SymRow, sc: number, why: string) => {
    const list = symHits.get(fid) ?? [];
    const ex = list.find((x) => x.id === s.id);
    if (ex) {
      ex.score += sc;
      ex.why += `; ${why}`;
    } else
      list.push({ id: s.id, name: s.name, qualified: s.qualified, kind: s.kind, start: s.start_line, end: s.end_line, signature: s.signature, score: sc, why });
    symHits.set(fid, list);
  };

  // ---------- 1. Lexical BM25 ----------
  const idf = new Map<string, number>();
  const termWeight = expandTerms(store, task.terms.slice(0, 60));
  const terms = [...termWeight.keys()].slice(0, 150);
  if (terms.length) {
    const ph = terms.map(() => "?").join(",");
    for (const r of store.all<{ term: string; df: number }>(`SELECT term, count(*) df FROM terms WHERE term IN (${ph}) GROUP BY term`, ...terms))
      idf.set(r.term, Math.log(1 + (N - r.df + 0.5) / (r.df + 0.5)));
    const lens = new Map(store.all<{ file_id: number; len: number }>("SELECT file_id, sum(tf) len FROM terms GROUP BY file_id").map((r) => [r.file_id, r.len]));
    const avgLen = [...lens.values()].reduce((a, b) => a + b, 0) / Math.max(lens.size, 1);
    const bm = new Map<number, number>();
    const matched = new Map<number, Set<string>>();
    for (const r of store.all<{ file_id: number; term: string; tf: number }>(`SELECT file_id, term, tf FROM terms WHERE term IN (${ph})`, ...terms)) {
      const k1 = 1.2;
      const b = 0.75;
      const len = lens.get(r.file_id) ?? avgLen;
      const w = (termWeight.get(r.term) ?? 1) * (idf.get(r.term) ?? 0) * ((r.tf * (k1 + 1)) / (r.tf + k1 * (1 - b + (b * len) / avgLen)));
      bm.set(r.file_id, (bm.get(r.file_id) ?? 0) + w);
      const s = matched.get(r.file_id) ?? new Set();
      s.add(r.term);
      matched.set(r.file_id, s);
    }
    const max = Math.max(0, ...bm.values());
    if (max > 0)
      for (const [fid, v] of bm) {
        const s = (WEIGHTS.lexicalMax * v) / max;
        if (s >= 0.4) add(fid, s, `terms: ${[...(matched.get(fid) ?? [])].slice(0, 6).join(", ")}`);
      }
  }

  // ---------- 2. Symbols ----------
  const syms = store.all<SymRow>("SELECT id, file_id, name, qualified, kind, start_line, end_line, signature, exported FROM symbols");
  const symByName = new Map<string, SymRow[]>();
  const symByLower = new Map<string, SymRow[]>();
  for (const s of syms) {
    (symByName.get(s.name) ?? symByName.set(s.name, []).get(s.name)!).push(s);
    const l = s.name.toLowerCase();
    (symByLower.get(l) ?? symByLower.set(l, []).get(l)!).push(s);
  }
  const seedSyms: { fid: number; sym: SymRow; score: number }[] = [];
  const identSet = new Set(task.identifiers.flatMap((i) => [i, i.split(".").pop()!]));
  for (const ident of identSet) {
    const exact = symByName.get(ident) ?? [];
    const loose = exact.length ? [] : symByLower.get(ident.toLowerCase()) ?? [];
    const hits = [...exact, ...loose];
    if (hits.length > 12) continue; // too generic to be a signal
    for (const s of hits) {
      const w = (exact.includes(s) ? WEIGHTS.symbolExact : WEIGHTS.symbolExact * 0.8) / Math.sqrt(hits.length);
      add(s.file_id, w, `defines ${s.qualified}`);
      addSym(s.file_id, s, w, "named in task");
      seedSyms.push({ fid: s.file_id, sym: s, score: w });
    }
  }
  // Partial term overlap between task terms and symbol names.
  const taskTermSet = new Set(termWeight.keys());
  if (taskTermSet.size) {
    const bestPerFile = new Map<number, { s: number; sym: SymRow; hit: string[] }>();
    for (const s of syms) {
      if (s.kind === "test" || s.kind === "suite") continue;
      const st = [...new Set(splitIdentifier(s.name).map(normTerm).filter(Boolean) as string[])];
      if (!st.length) continue;
      const hit = st.filter((t) => taskTermSet.has(t));
      if (!hit.length) continue;
      const mass = hit.reduce((a, t) => a + (idf.get(t) ?? 1) * (termWeight.get(t) ?? 1), 0);
      const cover = hit.length / st.length;
      const sc = Math.min(WEIGHTS.symbolFuzzy, mass * Math.sqrt(cover) * (s.exported ? 1 : 0.8) * 0.9);
      if (sc < 1.2) continue;
      addSym(s.file_id, s, sc, `name matches ${hit.join(", ")}`);
      const cur = bestPerFile.get(s.file_id);
      if (!cur || cur.s < sc) bestPerFile.set(s.file_id, { s: sc, sym: s, hit });
    }
    for (const [fid, v] of bestPerFile) {
      add(fid, v.s, `symbol ${v.sym.qualified} ~ ${v.hit.join(", ")}`);
      if (v.s >= 3) seedSyms.push({ fid, sym: v.sym, score: v.s });
    }
  }

  // ---------- 3. Paths & locations ----------
  for (const mention of task.paths) {
    const m = mention.replace(/^\.?\//, "");
    const exact = byPath.get(m);
    if (exact) {
      add(exact.id, WEIGHTS.pathExact, `path mentioned: ${m}`);
      continue;
    }
    const cands = files.filter((f) => f.path.endsWith("/" + m) || f.path.startsWith(m + "/") || f.path.includes("/" + m + "/") || f.path.replace(/\.[^.]+$/, "").endsWith(m));
    if (cands.length && cands.length <= 3) for (const f of cands) add(f.id, WEIGHTS.pathExact * 0.8, `path matches ${m}`);
    else if (cands.length && cands.length <= 40) for (const f of cands) add(f.id, WEIGHTS.pathPartial, `under mentioned path ${m}`);
  }
  // Module names: a task word (or joined word pair: "trie router" → trie-router) equal to a
  // directory name or file stem, e.g. "the csrf middleware", "fix(accept): …".
  const GENERIC_SEG = new Set(["src", "lib", "index", "utils", "util", "types", "type", "test", "tests", "helper", "helpers", "common", "core", "main", "app", "components", "packages", "dist", "internal", "shared"]);
  const segFiles = new Map<string, { id: number; stem: boolean }[]>();
  for (const f of files) {
    if (f.kind !== "code" && f.kind !== "test") continue;
    const parts = f.path.split("/");
    const stem = parts[parts.length - 1].replace(/\.(?:test|spec)?\.?[cm]?[jt]sx?$/, "").replace(/\.(?:test|spec)$/, "");
    const segs = new Map<string, boolean>(parts.slice(0, -1).map((s) => [s.toLowerCase(), false]));
    segs.set(stem.toLowerCase(), true);
    for (const [s, isStem] of segs) {
      if (s.length < 3) continue;
      const l = segFiles.get(s) ?? [];
      l.push({ id: f.id, stem: isStem });
      segFiles.set(s, l);
    }
  }
  const words = (task.text.toLowerCase().match(/[a-z][\w-]*/g) ?? []).filter((w) => w.length >= 3);
  const cands = new Set(words);
  for (let i = 0; i + 1 < words.length; i++) for (const j of ["-", "_", ""]) cands.add(words[i] + j + words[i + 1]);
  for (const w of cands) {
    const hit = segFiles.get(w);
    if (!hit || GENERIC_SEG.has(w) || hit.length > 40) continue;
    const perFile = (hit.some((h) => h.stem) ? 5 : 3.5) / Math.sqrt(hit.length);
    for (const h of hit) add(h.id, Math.max(0.5, h.stem ? perFile * 1.3 : perFile), `module name "${w}"`);
  }

  for (const loc of task.locations) {
    const p = loc.path.replace(/^\.?\//, "");
    const f = byPath.get(p) ?? files.find((x) => x.path.endsWith("/" + p) || p.endsWith("/" + x.path));
    if (!f) continue;
    add(f.id, WEIGHTS.location, `error location ${p}${loc.line ? ":" + loc.line : ""}`);
    if (loc.line) {
      const inner = syms
        .filter((s) => s.file_id === f.id && s.start_line <= loc.line! && s.end_line >= loc.line!)
        .sort((a, b) => a.end_line - a.start_line - (b.end_line - b.start_line))[0];
      if (inner) {
        addSym(f.id, inner, WEIGHTS.location, `contains line ${loc.line}`);
        seedSyms.push({ fid: f.id, sym: inner, score: WEIGHTS.location });
      }
    }
  }

  // ---------- 4. Memory ----------
  const memoryHits = opts.memory ? opts.memory.relevant(task.terms, []) : [];
  for (const mh of memoryHits)
    for (const mf of mh.entry.files ?? []) {
      const f = byPath.get(mf);
      if (f) add(f.id, WEIGHTS.memoryFile, `referenced by ${mh.entry.type} ${mh.entry.id}`);
    }

  // ---------- 5. Git ----------
  const git = opts.noGit ? { isRepo: false, head: null, branch: null, dirty: [], staged: [], untracked: [] } : gitState(root);
  const commits = opts.noGit || !git.head ? [] : recentCommits(root, 40);
  if (!opts.noGit) {
    for (const d of new Set([...git.dirty, ...git.staged, ...git.untracked])) {
      const f = byPath.get(d);
      if (!f) continue;
      const base = score.get(f.id) ?? 0;
      if (base > 0) add(f.id, task.mentionsRecent ? WEIGHTS.dirtyRecent : WEIGHTS.dirty, "uncommitted changes");
    }
    const rec = fileRecency(commits);
    for (const [path, r] of rec) {
      const f = byPath.get(path);
      if (!f || !(score.get(f.id) ?? 0)) continue; // recency only amplifies existing evidence
      // Bulk commits (initial import, mass renames) say little about any one file.
      if (r.spread > 30) continue;
      const w = ((task.mentionsRecent ? WEIGHTS.recencyRecent : WEIGHTS.recency) * Math.exp(-r.index / 8)) / Math.sqrt(Math.max(1, r.spread / 4));
      if (w >= 0.2) add(f.id, w, `changed ${r.index === 0 ? "in last commit" : `${r.index + 1} commits ago`}: ${r.hash.slice(0, 7)} ${r.subject.slice(0, 50)}`);
    }
  }

  // ---------- 6. Graph propagation ----------
  const seeds = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const edges = store.all<{ file_id: number; target_id: number; type_only: number }>(
    "SELECT file_id, target_id, type_only FROM imports WHERE target_id IS NOT NULL",
  );
  const out = new Map<number, { t: number; typeOnly: boolean }[]>();
  const inc = new Map<number, { t: number; typeOnly: boolean }[]>();
  for (const e of edges) {
    (out.get(e.file_id) ?? out.set(e.file_id, []).get(e.file_id)!).push({ t: e.target_id, typeOnly: !!e.type_only });
    (inc.get(e.target_id) ?? inc.set(e.target_id, []).get(e.target_id)!).push({ t: e.file_id, typeOnly: !!e.type_only });
  }
  const bonus = new Map<number, { s: number; why: string }>();
  const topScore = seeds[0]?.[1] ?? 0;
  for (const [fid, s] of seeds) {
    if (s < topScore * 0.35) continue;
    const seedPath = byId.get(fid)!.path;
    for (const [dir, list] of [
      ["imported by", out.get(fid) ?? []],
      ["imports", inc.get(fid) ?? []],
    ] as const) {
      for (const n of list) {
        if (n.t === fid) continue;
        const b = Math.min(WEIGHTS.neighborCap, s * WEIGHTS.neighbor * (n.typeOnly ? 0.4 : 1));
        const cur = bonus.get(n.t);
        if (!cur || cur.s < b) bonus.set(n.t, { s: b, why: `${dir} ${seedPath}` });
      }
    }
  }
  for (const [fid, b] of bonus) add(fid, b.s, b.why);

  // Callers of seed symbols (reference by name, restricted to files that import the defining file).
  const seen = new Set<number>();
  for (const seed of seedSyms.sort((a, b) => b.score - a.score).slice(0, 8)) {
    if (seen.has(seed.sym.id) || ["test", "suite", "route"].includes(seed.sym.kind)) continue;
    seen.add(seed.sym.id);
    const importers = new Set((inc.get(seed.fid) ?? []).map((x) => x.t));
    importers.add(seed.fid);
    const callers = store.all<SymRow>(
      `SELECT s.id, s.file_id, s.name, s.qualified, s.kind, s.start_line, s.end_line, s.signature, s.exported
       FROM symbol_refs r JOIN symbols s ON s.id = r.symbol_id WHERE r.name = ? LIMIT 200`,
      seed.sym.name,
    );
    for (const c of callers) {
      if (c.id === seed.sym.id || !importers.has(c.file_id)) continue;
      if (c.kind === "class" && callers.some((x) => x.kind === "method" && x.file_id === c.file_id && x.qualified.startsWith(c.name + "."))) continue;
      addSym(c.file_id, c, WEIGHTS.caller * 0.5, `uses ${seed.sym.name}`);
      if (c.file_id !== seed.fid) add(c.file_id, WEIGHTS.caller, `calls ${seed.sym.name}`);
    }
  }

  // ---------- 7. Kind penalties ----------
  const mentionsDocs = /\b(?:readme|docs?|documentation|markdown)\b/i.test(task.text);
  for (const [fid, s] of score) {
    const f = byId.get(fid)!;
    let mult = 1;
    if (f.kind === "test" && !task.mentionsTests) mult *= WEIGHTS.testPenalty;
    if (f.kind === "doc" && !mentionsDocs) mult *= WEIGHTS.docPenalty;
    if (f.kind === "config" && !task.paths.some((p) => f.path.endsWith(p))) mult *= WEIGHTS.configPenalty;
    if (f.kind === "other") mult *= 0.3;
    if (isGeneratedPath(f.path)) mult *= WEIGHTS.generatedPenalty;
    if (mult !== 1) {
      score.set(fid, s * mult);
      reasons.get(fid)!.push(`×${mult.toFixed(2)} ${f.kind}${isGeneratedPath(f.path) ? "/generated" : ""} penalty`);
    }
  }

  const ranked: RankedFile[] = [...score.entries()]
    .filter(([, s]) => s > 0.5)
    .sort((a, b) => b[1] - a[1])
    .map(([fid, s]) => {
      const f = byId.get(fid)!;
      return {
        id: fid,
        path: f.path,
        kind: f.kind,
        tokens: f.tokens,
        lines: f.lines,
        score: Math.round(s * 100) / 100,
        reasons: reasons.get(fid) ?? [],
        symbols: (symHits.get(fid) ?? []).sort((a, b) => b.score - a.score),
      };
    });

  // Confidence: do we have a strong, specific anchor, or only diffuse lexical overlap?
  const top = ranked[0];
  const anchored = top?.reasons.some((r) => /^(?:defines|path|error location|symbol )/.test(r)) ?? false;
  const gap = ranked.length > 5 ? top.score / Math.max(ranked[5].score, 0.1) : 2;
  const confidence: RankResult["confidence"] = !top ? "low" : anchored && top.score >= 10 ? "high" : anchored || gap > 1.8 ? "medium" : "low";

  const codeFiles = files.filter((f) => f.kind === "code" || f.kind === "test");
  return {
    files: ranked,
    memory: memoryHits,
    git,
    commits,
    confidence,
    stats: { candidates: ranked.length, codeFiles: codeFiles.length, repoCodeTokens: codeFiles.reduce((a, f) => a + f.tokens, 0) },
  };
}

export function relatedTests(store: Store, fileIds: number[], limit = 6): { path: string; id: number; strength: number; reason: string; source: string }[] {
  if (!fileIds.length) return [];
  const ph = fileIds.map(() => "?").join(",");
  const rows = store.all<{ path: string; id: number; strength: number; reason: string; source: string }>(
    `SELECT t.path, t.id, m.strength, m.reason, s.path AS source FROM tests_map m
     JOIN files t ON t.id = m.test_id JOIN files s ON s.id = m.source_id
     WHERE m.source_id IN (${ph}) ORDER BY m.strength DESC`,
    ...fileIds,
  );
  const order = new Map(fileIds.map((id, i) => [id, i]));
  const best = new Map<string, (typeof rows)[number] & { rankKey: number }>();
  for (const r of rows) {
    const srcRank = order.get(store.fileByPath(r.source)!.id) ?? 99;
    const key = r.strength * 10 - srcRank;
    const cur = best.get(r.path);
    if (!cur || cur.rankKey < key) best.set(r.path, { ...r, rankKey: key });
  }
  return [...best.values()].sort((a, b) => b.rankKey - a.rankKey).slice(0, limit);
}

export function topLevelMap(store: Store): { dir: string; files: number; code: number }[] {
  const m = new Map<string, { files: number; code: number }>();
  for (const f of store.all<{ path: string; kind: string }>("SELECT path, kind FROM files")) {
    const parts = f.path.split("/");
    const dir = parts.length > 2 && ["src", "packages", "apps", "lib", "services"].includes(parts[0]) ? `${parts[0]}/${parts[1]}` : parts.length > 1 ? parts[0] : ".";
    const cur = m.get(dir) ?? { files: 0, code: 0 };
    cur.files++;
    if (f.kind === "code" || f.kind === "test") cur.code++;
    m.set(dir, cur);
  }
  return [...m.entries()].map(([dir, v]) => ({ dir, ...v })).sort((a, b) => b.code - a.code || b.files - a.files);
}

export function detectStack(root: string, store: Store): string[] {
  const out = new Set<string>();
  const langs = store.get<{ ts: number; js: number }>(
    "SELECT sum(path LIKE '%.ts' OR path LIKE '%.tsx' OR path LIKE '%.mts') ts, sum(path LIKE '%.js' OR path LIKE '%.jsx' OR path LIKE '%.mjs') js FROM files WHERE kind IN ('code','test')",
  );
  if (langs?.ts) out.add("TypeScript");
  if (langs?.js && (!langs.ts || langs.js > langs.ts / 4)) out.add("JavaScript");
  const known: Record<string, string> = {
    next: "Next.js", react: "React", vue: "Vue", svelte: "Svelte", "@angular/core": "Angular", express: "Express", fastify: "Fastify",
    koa: "Koa", "@nestjs/core": "NestJS", hono: "Hono", prisma: "Prisma", "@prisma/client": "Prisma", "drizzle-orm": "Drizzle",
    typeorm: "TypeORM", mongoose: "Mongoose", sequelize: "Sequelize", vitest: "Vitest", jest: "Jest", mocha: "Mocha",
    "@playwright/test": "Playwright", electron: "Electron", "react-native": "React Native", vite: "Vite", graphql: "GraphQL",
    "@trpc/server": "tRPC", zod: "Zod", tailwindcss: "Tailwind",
  };
  for (const f of store.all<{ path: string }>("SELECT path FROM files WHERE path LIKE '%package.json' AND path NOT LIKE '%node_modules%' LIMIT 50")) {
    try {
      const pkg = JSON.parse(readFileSync(posix.join(root, f.path), "utf8"));
      for (const dep of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) if (known[dep]) out.add(known[dep]);
    } catch {
      /* ignore */
    }
  }
  return [...out];
}
