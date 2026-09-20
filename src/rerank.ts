import type { RankedFile } from "./ranker.js";
import type { Store } from "./store.js";

/**
 * Optional re-ranking of the rule-based shortlist by a small hosted decision model
 * (TypeSafe "Jev", via OpenRouter or the TypeSafe API).
 *
 * OFF by default and never used by the local package builder yet: it sends file paths and
 * signatures — never file contents — to a third party, which breaks the local-first promise.
 * It exists so `narrowbit eval --rerank` can measure whether it beats the rules, cheaply and
 * without touching Claude quota.
 */
export interface RerankConfig {
  model: string;
  /** "openrouter" (OPENROUTER_API_KEY) or "typesafe" (TYPESAFE_API_KEY). */
  provider: "openrouter" | "typesafe";
  topN: number;
  concurrency: number;
  /** 0 = rules only, 1 = model only. */
  weight: number;
  timeoutMs: number;
}

export const DEFAULT_RERANK: RerankConfig = {
  // TypeSafe direct when a TYPESAFE_API_KEY exists, else OpenRouter's alpha decisions endpoint.
  model: process.env.TYPESAFE_API_KEY ? "jev-latest" : "typesafe/jev-1.13",
  provider: process.env.TYPESAFE_API_KEY ? "typesafe" : "openrouter",
  topN: 20,
  concurrency: 1,
  weight: 0.5,
  timeoutMs: 60_000,
};

const LEVELS = [
  "unrelated to the task",
  "background only: might be read for context, but not edited",
  "supporting: likely read, possibly a small change",
  "likely edited to complete the task",
  "almost certainly where the change belongs",
];

export interface RerankStats {
  calls: number;
  errors: number;
  /** First failure, verbatim — silent failures cost a whole eval run. */
  firstError?: string;
  inputTokens: number;
  ms: number;
  estCostUsd: number;
}

export interface RerankedFile extends RankedFile {
  /** 0..1 from the decision model, or null when the call failed. */
  modelScore: number | null;
  combined: number;
}

/** One compact, content-free line per candidate: path, size, why shortlisted, a few signatures. */
function describeCandidate(store: Store, f: RankedFile): string {
  const syms = store
    .all<{ qualified: string; kind: string; signature: string }>(
      "SELECT qualified, kind, signature FROM symbols WHERE file_id=? AND kind NOT IN ('test','suite') ORDER BY exported DESC, (end_line - start_line) DESC LIMIT 6",
      f.id,
    )
    .map((x) => `${x.kind} ${x.qualified}`)
    .join(", ");
  const why = f.reasons.slice(0, 2).map((r) => r.replace(/\s*\(\+[\d.]+\)$/, "")).join("; ");
  return `${f.path} (${f.lines} lines) — shortlisted because: ${why}${syms ? ` — defines: ${syms.slice(0, 300)}` : ""}`;
}

interface ChoiceAnswer {
  /** path → probability this is where the change belongs */
  probs: Map<string, number>;
  confidence: number | null;
  inputTokens: number;
}

/**
 * One request per task: Choice over the whole shortlist (up to 255 options), which returns a
 * probability distribution we can rank by directly — cheaper and better calibrated than
 * scoring each file in a separate call.
 */
async function askChoice(store: Store, task: string, head: RankedFile[], cfg: RerankConfig, key: string): Promise<ChoiceAnswer> {
  // Opaque option ids keep paths out of the option keys and make the mapping back unambiguous.
  const ids = head.map((_, i) => `c${i}`);
  const criteria = Object.fromEntries(head.map((f, i) => [ids[i], describeCandidate(store, f)]));
  const state = [
    `A developer is working in a TypeScript repository. Their task:`,
    task.slice(0, 2000),
    ``,
    `Candidate files were shortlisted by a local index. Decide where the change belongs.`,
  ].join("\n");
  const body = {
    model: cfg.model,
    state,
    questions: {
      target: { type: "choice", instructions: "Which candidate file must be edited to complete this task?", criteria },
    },
  };
  const url = cfg.provider === "openrouter" ? "https://openrouter.ai/api/alpha/decisions" : "https://api.typesafe.ai/v1/systemone";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
    const j: any = await res.json();
    const a = j.answers?.target ?? j.target ?? j.answers ?? {};
    const probs = new Map<string, number>();
    const dist = a.probabilities ?? {};
    for (const [id, pr] of Object.entries(dist)) {
      const i = ids.indexOf(id);
      if (i >= 0 && typeof pr === "number") probs.set(head[i].path, pr);
    }
    // Fall back to the single top choice when no distribution is returned.
    if (!probs.size && typeof a.choice === "string") {
      const i = ids.indexOf(a.choice);
      if (i >= 0) probs.set(head[i].path, 1);
    }
    return { probs, confidence: typeof a.confidence === "number" ? a.confidence : null, inputTokens: j.usage?.input_tokens ?? j.usage?.prompt_tokens ?? 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Simple worker pool: the decision service is fast, but we stay polite and bounded. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export function rerankKey(cfg: RerankConfig): string | null {
  return (cfg.provider === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.TYPESAFE_API_KEY) ?? null;
}

/**
 * Re-score the top `topN` candidates. Files below the cut keep their rule order beneath them,
 * so a failed or slow call can only lose the improvement, never the baseline.
 */
export async function rerank(
  store: Store,
  task: string,
  files: RankedFile[],
  cfg: RerankConfig = DEFAULT_RERANK,
): Promise<{ files: RerankedFile[]; stats: RerankStats }> {
  const key = rerankKey(cfg);
  if (!key) throw new Error(`no API key: set ${cfg.provider === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY"}`);
  const t0 = Date.now();
  const head = files.slice(0, Math.min(cfg.topN, 255));
  const tail = files.slice(head.length);
  const stats: RerankStats = { calls: 0, errors: 0, inputTokens: 0, ms: 0, estCostUsd: 0 };

  let answer: ChoiceAnswer = { probs: new Map(), confidence: null, inputTokens: 0 };
  if (head.length) {
    try {
      answer = await askChoice(store, task, head, cfg, key);
      stats.calls = 1;
      stats.inputTokens = answer.inputTokens;
    } catch (e: any) {
      stats.errors = 1;
      stats.firstError = String(e?.message ?? e).slice(0, 300);
    }
  }

  const maxRule = Math.max(...head.map((f) => f.score), 1);
  const maxProb = Math.max(0, ...answer.probs.values()) || 1;
  const w = Number.isFinite(cfg.weight) ? cfg.weight : DEFAULT_RERANK.weight;
  const scored: RerankedFile[] = head.map((f) => {
    const pr = answer.probs.get(f.path);
    const ruleNorm = f.score / maxRule;
    // A missing answer must not penalise a file: it keeps its rule score alone.
    const model = pr === undefined ? null : pr / maxProb;
    return { ...f, modelScore: model, combined: model === null ? ruleNorm : (1 - w) * ruleNorm + w * model };
  });
  scored.sort((a, b) => b.combined - a.combined || b.score - a.score);
  stats.ms = Date.now() - t0;
  stats.estCostUsd = cfg.provider === "openrouter" ? (stats.inputTokens / 1e6) * 0.042 : 0; // only the OpenRouter rate is published
  return { files: [...scored, ...tail.map((f) => ({ ...f, modelScore: null, combined: 0 }))], stats };
}
