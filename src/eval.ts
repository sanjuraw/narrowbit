import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, paths, type Paths } from "./config.js";
import { CODE_EXT, isTestPath } from "./files.js";
import { indexRepo } from "./indexer.js";
import { buildPackage } from "./package.js";
import { Store } from "./store.js";
import { DEFAULT_RERANK, rerank, type RerankConfig, type RerankStats } from "./rerank.js";
import { sh, shortId } from "./util.js";

/**
 * Offline selection benchmark over git history — free (no model calls).
 * For each past commit: index the parent, use the commit message as the task,
 * and measure whether Narrowbit's package contains the files the commit changed.
 * Commit messages are much weaker task descriptions than real prompts, so treat
 * the numbers as a lower bound on selection quality; use them to tune weights.
 */
export interface EvalCase {
  commit: string;
  subject: string;
  gold: string[];
  added: string[];
  rankOfFirst: number | null;
  recallAt5: number;
  recallAt10: number;
  recallLoaded: number;
  recallInPackage: number;
  packageTokens: number;
  goldFullTokens: number;
  confidence: string;
  /** Same metrics after model re-ranking of the shortlist (only with --rerank). */
  reranked?: { rankOfFirst: number | null; recallAt5: number; recallAt10: number };
}

export async function evalHistory(p: Paths, opts: { commits?: number; budget?: number; log?: (s: string) => void; ref?: string; rerank?: Partial<RerankConfig> } = {}) {
  const log = opts.log ?? ((s: string) => process.stderr.write(s + "\n"));
  const n = opts.commits ?? 40;
  const raw = sh("git", ["log", opts.ref ?? "HEAD", `-n${n * 4}`, "--no-merges", "--format=%x1e%H%x1f%P%x1f%s%x1f%b", "--name-status"], p.root).stdout;
  const cands: { hash: string; parent: string; msg: string; subject: string; modified: string[]; added: string[] }[] = [];
  for (const block of raw.split("\x1e")) {
    if (!block.trim()) continue;
    const [meta, ...rest] = block.split("\n");
    const [hash, parents, subject, bodyStart] = meta.split("\x1f");
    const bodyLines: string[] = [bodyStart ?? ""];
    const modified: string[] = [];
    const added: string[] = [];
    for (const l of rest) {
      const m = /^([AMDR])\d*\t(.+?)(?:\t(.+))?$/.exec(l);
      if (m) {
        const path = m[3] ?? m[2];
        if (!CODE_EXT.test(path) || isTestPath(path) || /\.d\.ts$/.test(path)) continue;
        if (m[1] === "M" || (m[1] === "R" && m[3])) modified.push(m[1] === "R" ? m[2] : path);
        else if (m[1] === "A") added.push(path);
      } else if (!modified.length && !added.length) bodyLines.push(l);
    }
    const parent = parents.split(" ")[0];
    if (!parent || !modified.length || modified.length > 12) continue;
    if (subject.length < 12 || /^(?:wip|merge|bump|release|v?\d+\.\d+|chore\(deps\)|format|lint|prettier)\b/i.test(subject)) continue;
    cands.push({ hash, parent, subject, msg: [subject, bodyLines.join("\n").trim()].filter(Boolean).join("\n"), modified, added });
    if (cands.length >= n) break;
  }
  if (!cands.length) throw new Error("no suitable commits found (need non-merge commits modifying TS/JS source files)");

  const wt = join(p.nb, "eval-worktree");
  const evalNb = join(p.nb, "eval");
  mkdirSync(evalNb, { recursive: true });
  if (!existsSync(wt)) {
    const r = sh("git", ["worktree", "add", "--detach", "--force", wt, cands[0].parent], p.root);
    if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr}`);
  }
  const wp: Paths = { ...paths(wt), nb: evalNb, db: join(evalNb, "index.db"), memory: join(evalNb, "memory"), tasks: join(evalNb, "tasks") };
  const cfg = loadConfig(p);
  const store = new Store(wp.db);
  const cases: EvalCase[] = [];
  const rrCfg: RerankConfig = { ...DEFAULT_RERANK, ...Object.fromEntries(Object.entries(opts.rerank ?? {}).filter(([, v]) => v !== undefined)) };
  const rrStats: RerankStats = { calls: 0, errors: 0, inputTokens: 0, ms: 0, estCostUsd: 0 };
  try {
    for (const c of cands) {
      const co = sh("git", ["checkout", "--detach", "--force", c.parent], wt);
      if (co.code !== 0) {
        log(`skip ${c.hash.slice(0, 8)}: checkout failed`);
        continue;
      }
      sh("git", ["clean", "-fdq"], wt);
      indexRepo(wp, store);
      const b = buildPackage(store, wp, cfg, c.msg, { noGit: true, budget: opts.budget, source: "eval", withProtocol: false });
      const gold = c.modified.filter((g) => store.fileByPath(g));
      if (!gold.length) continue;
      const order = b.ranking.files.map((f) => f.path);
      const firstIdx = order.findIndex((f) => gold.includes(f));
      const r = (k: number) => gold.filter((g) => order.slice(0, k).includes(g)).length / gold.length;
      const levelOf = new Map(b.record.selected.map((s) => [s.path, s.level]));
      const loaded = gold.filter((g) => ["full", "symbols"].includes(levelOf.get(g) ?? "")).length / gold.length;
      const inPkg = gold.filter((g) => ["full", "symbols", "outline"].includes(levelOf.get(g) ?? "")).length / gold.length;
      const goldFullTokens = gold.reduce((a, g) => a + (store.fileByPath(g)?.tokens ?? 0), 0);
      const ec: EvalCase = {
        commit: c.hash,
        subject: c.subject,
        gold,
        added: c.added,
        rankOfFirst: firstIdx >= 0 ? firstIdx + 1 : null,
        recallAt5: r(5),
        recallAt10: r(10),
        recallLoaded: loaded,
        recallInPackage: inPkg,
        packageTokens: b.record.packageTokens,
        goldFullTokens,
        confidence: b.record.confidence,
      };
      if (opts.rerank) {
        const rr = await rerank(store, c.msg, b.ranking.files, rrCfg);
        for (const k of ["calls", "errors", "inputTokens", "ms"] as const) rrStats[k] += rr.stats[k];
        rrStats.estCostUsd += rr.stats.estCostUsd;
        const order2 = rr.files.map((f) => f.path);
        const idx2 = order2.findIndex((f) => gold.includes(f));
        const r2 = (k: number) => gold.filter((g) => order2.slice(0, k).includes(g)).length / gold.length;
        ec.reranked = { rankOfFirst: idx2 >= 0 ? idx2 + 1 : null, recallAt5: r2(5), recallAt10: r2(10) };
      }
      cases.push(ec);
      log(
        `${c.hash.slice(0, 8)} r@5=${ec.recallAt5.toFixed(2)} r@10=${ec.recallAt10.toFixed(2)} loaded=${ec.recallLoaded.toFixed(2)} first=${ec.rankOfFirst ?? "-"} pkg=${ec.packageTokens} [${ec.confidence}] ${c.subject.slice(0, 60)}`,
      );
    }
  } finally {
    store.close();
    sh("git", ["worktree", "remove", "--force", wt], p.root);
  }
  const mean = (f: (c: EvalCase) => number) => (cases.length ? cases.reduce((a, c) => a + f(c), 0) / cases.length : 0);
  const summary = {
    cases: cases.length,
    recallAt5: mean((c) => c.recallAt5),
    recallAt10: mean((c) => c.recallAt10),
    recallLoaded: mean((c) => c.recallLoaded),
    recallInPackage: mean((c) => c.recallInPackage),
    mrr: mean((c) => (c.rankOfFirst ? 1 / c.rankOfFirst : 0)),
    hitAt1: mean((c) => (c.rankOfFirst === 1 ? 1 : 0)),
    meanPackageTokens: mean((c) => c.packageTokens),
    rerank: opts.rerank
      ? {
          ...rrStats,
          model: rrCfg.model,
          weight: rrCfg.weight,
          recallAt5: mean((c) => c.reranked?.recallAt5 ?? 0),
          recallAt10: mean((c) => c.reranked?.recallAt10 ?? 0),
          mrr: mean((c) => (c.reranked?.rankOfFirst ? 1 / c.reranked.rankOfFirst : 0)),
          hitAt1: mean((c) => (c.reranked?.rankOfFirst === 1 ? 1 : 0)),
        }
      : null,
    byConfidence: Object.fromEntries(
      ["high", "medium", "low"].map((k) => {
        const cs = cases.filter((c) => c.confidence === k);
        return [k, { n: cs.length, recallInPackage: cs.length ? cs.reduce((a, c) => a + c.recallInPackage, 0) / cs.length : null }];
      }),
    ),
  };
  const out = join(p.benchmarks, `eval-${shortId()}.json`);
  writeFileSync(out, JSON.stringify({ summary, cases }, null, 2));
  return { summary, cases, file: out };
}
