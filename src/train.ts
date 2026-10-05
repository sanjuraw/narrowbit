import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths, type Paths } from "./config.js";
import { CODE_EXT, isTestPath } from "./files.js";
import { indexRepo } from "./indexer.js";
import { FEATURES, rank, type Feature, type FeatureVec } from "./ranker.js";
import { Store } from "./store.js";
import { parseTask } from "./taskparse.js";
import { sh, writeProjectFile } from "./util.js";

/**
 * Learn per-signal weights from the repository's own history — locally, no model calls.
 *
 * Every past commit is a labelled example: "for this message, these files changed". We rank
 * at the parent commit, then fit multipliers over the ranker's raw signals so the files that
 * actually changed come first. Pairwise logistic loss (gold above each non-gold candidate),
 * which optimises ordering rather than absolute scores.
 */
export interface TrainedWeights {
  weights: FeatureVec;
  trainedAt: string;
  commits: number;
  examples: number;
  /** Recent commits excluded from training, so an eval over them stays honest. */
  skipped: number;
  /** Held-out ordering quality before and after, so a bad fit is obvious. */
  before: { hitAt1: number; mrr: number; recallAt5: number };
  after: { hitAt1: number; mrr: number; recallAt5: number };
  repo: string;
}

interface Example {
  cands: { features: FeatureVec; kindMult: number; gold: boolean }[];
}

const WEIGHTS_FILE = "weights.json";

export function loadWeights(p: Paths): FeatureVec | undefined {
  const f = join(p.nb, WEIGHTS_FILE);
  if (!existsSync(f)) return undefined;
  try {
    const t: TrainedWeights = JSON.parse(readFileSync(f, "utf8"));
    // Never apply a fit that made held-out ordering worse.
    return t.after.mrr >= t.before.mrr ? t.weights : undefined;
  } catch {
    return undefined;
  }
}

function score(c: { features: FeatureVec; kindMult: number }, w: FeatureVec): number {
  let s = 0;
  for (const f of FEATURES) s += (c.features[f] ?? 0) * (w[f] ?? 1);
  return s * c.kindMult;
}

function metrics(examples: Example[], w: FeatureVec) {
  let hit = 0;
  let mrr = 0;
  let r5 = 0;
  for (const ex of examples) {
    const ranked = [...ex.cands].sort((a, b) => score(b, w) - score(a, w));
    const idx = ranked.findIndex((c) => c.gold);
    const golds = ex.cands.filter((c) => c.gold).length;
    if (idx === 0) hit++;
    if (idx >= 0) mrr += 1 / (idx + 1);
    r5 += ranked.slice(0, 5).filter((c) => c.gold).length / Math.max(golds, 1);
  }
  const n = Math.max(examples.length, 1);
  return { hitAt1: hit / n, mrr: mrr / n, recallAt5: r5 / n };
}

/** Pairwise logistic loss with L2 pull toward 1 (the hand-set weights stay the prior). */
function fit(examples: Example[], epochs = 60, lr = 0.05, l2 = 0.02): FeatureVec {
  const w: Record<string, number> = Object.fromEntries(FEATURES.map((f) => [f, 1]));
  for (let e = 0; e < epochs; e++) {
    const grad: Record<string, number> = Object.fromEntries(FEATURES.map((f) => [f, 0]));
    let pairs = 0;
    for (const ex of examples) {
      const golds = ex.cands.filter((c) => c.gold);
      const others = ex.cands.filter((c) => !c.gold);
      for (const g of golds) {
        for (const o of others) {
          const diff = score(g, w) - score(o, w);
          const sig = 1 / (1 + Math.exp(diff)); // dLoss/dDiff for log(1+exp(-diff))
          pairs++;
          for (const f of FEATURES) {
            const d = (g.features[f] ?? 0) * g.kindMult - (o.features[f] ?? 0) * o.kindMult;
            grad[f] -= sig * d;
          }
        }
      }
    }
    if (!pairs) break;
    for (const f of FEATURES) {
      const g = grad[f] / pairs + l2 * (w[f] - 1);
      w[f] = Math.max(0.05, Math.min(5, w[f] - lr * g));
    }
  }
  return Object.fromEntries(FEATURES.map((f) => [f, Math.round(w[f] * 1000) / 1000])) as FeatureVec;
}

export async function train(
  p: Paths,
  opts: { commits?: number; log?: (s: string) => void; topN?: number; holdout?: number; skip?: number } = {},
): Promise<TrainedWeights> {
  const log = opts.log ?? ((s: string) => process.stderr.write(s + "\n"));
  const want = opts.commits ?? 150;
  const topN = opts.topN ?? 25;
  const raw = sh("git", ["log", "HEAD", ...(opts.skip ? [`--skip=${opts.skip}`] : []), `-n${want * 3}`, "--no-merges", "--format=%x1e%H%x1f%P%x1f%s%x1f%b", "--name-status"], p.root).stdout;
  const cands: { hash: string; parent: string; msg: string; changed: string[] }[] = [];
  for (const block of raw.split("\x1e")) {
    if (!block.trim()) continue;
    const [meta, ...rest] = block.split("\n");
    const [hash, parents, subject, body] = meta.split("\x1f");
    const parent = parents?.split(" ")[0];
    if (!parent || !subject || subject.length < 12) continue;
    if (/^(?:wip|merge|bump|release|v?\d+\.\d+|chore\(deps\))/i.test(subject)) continue;
    const changed: string[] = [];
    for (const l of rest) {
      const m = /^M\d*\t(.+)$/.exec(l);
      if (m && CODE_EXT.test(m[1]) && !isTestPath(m[1]) && !/\.d\.ts$/.test(m[1])) changed.push(m[1]);
    }
    if (changed.length && changed.length <= 8) cands.push({ hash, parent, msg: [subject, body].filter(Boolean).join("\n"), changed });
    if (cands.length >= want) break;
  }
  if (cands.length < 10) throw new Error(`need at least 10 usable commits, found ${cands.length}`);

  const wt = join(p.nb, "train-worktree");
  const trainNb = join(p.nb, "train");
  mkdirSync(trainNb, { recursive: true });
  if (existsSync(wt)) sh("git", ["worktree", "remove", "--force", wt], p.root);
  const add = sh("git", ["worktree", "add", "--detach", "--force", wt, cands[0].parent], p.root);
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
  const wp: Paths = { ...paths(wt), nb: trainNb, db: join(trainNb, "index.db"), memory: join(trainNb, "memory"), tasks: join(trainNb, "tasks") };
  const store = new Store(wp.db);
  const examples: Example[] = [];
  try {
    for (const c of cands) {
      if (sh("git", ["checkout", "--detach", "--force", c.parent], wt).code !== 0) continue;
      sh("git", ["clean", "-fdq"], wt);
      indexRepo(wp, store);
      // noGit: the future commit must not leak through recency/dirty signals.
      const r = rank(store, wt, parseTask(c.msg), { noGit: true });
      const head = r.files.slice(0, topN);
      const gold = new Set(c.changed.filter((g) => store.fileByPath(g)));
      if (!gold.size || !head.some((f) => gold.has(f.path))) continue;
      examples.push({ cands: head.map((f) => ({ features: f.features, kindMult: f.kindMult, gold: gold.has(f.path) })) });
      if (examples.length % 10 === 0) log(`  ${examples.length} examples…`);
    }
  } finally {
    store.close();
    sh("git", ["worktree", "remove", "--force", wt], p.root);
  }
  if (examples.length < 10) throw new Error(`only ${examples.length} usable examples; need 10+`);

  // Held-out split so the reported improvement is not the fit talking about itself.
  const cut = Math.floor(examples.length * (1 - (opts.holdout ?? 0.3)));
  const trainSet = examples.slice(0, cut);
  const testSet = examples.slice(cut).length >= 5 ? examples.slice(cut) : examples;
  const weights = fit(trainSet);
  const base = Object.fromEntries(FEATURES.map((f) => [f, 1])) as FeatureVec;
  const t: TrainedWeights = {
    weights,
    trainedAt: new Date().toISOString(),
    commits: cands.length,
    examples: examples.length,
    skipped: opts.skip ?? 0,
    before: metrics(testSet, base),
    after: metrics(testSet, weights),
    repo: p.root,
  };
  writeProjectFile(dirname(p.nb), join(p.nb, WEIGHTS_FILE), JSON.stringify(t, null, 2) + "\n");
  return t;
}
