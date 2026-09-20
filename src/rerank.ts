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
  model: "typesafe/jev-1.13",
  provider: "openrouter",
  topN: 20,
  concurrency: 4,
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

/** Compact, content-free description of one candidate: path, size, why it was picked, signatures. */
function describe(store: Store, f: RankedFile, task: string): string {
  const syms = store
    .all<{ qualified: string; kind: string; signature: string; start_line: number }>(
      "SELECT qualified, kind, signature, start_line FROM symbols WHERE file_id=? AND kind NOT IN ('test','suite') ORDER BY exported DESC, (end_line - start_line) DESC LIMIT 12",
      f.id,
    )
    .map((s) => `  ${s.kind} ${s.qualified} — ${s.signature.slice(0, 120)}`);
  const matched = f.symbols.slice(0, 5).map((s) => `${s.qualified} (${s.why})`);
  return [
    `TASK: ${task.slice(0, 800)}`,
    ``,
    `CANDIDATE FILE: ${f.path} (${f.lines} lines)`,
    `Why the index suggested it: ${f.reasons.slice(0, 4).join("; ")}`,
    matched.length ? `Matching symbols: ${matched.join(", ")}` : "",
    syms.length ? `File contents (signatures only):\n${syms.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function ask(state: string, cfg: RerankConfig, key: string): Promise<{ relevance: number | null; edit: number | null; inputTokens: number }> {
  const body = {
    model: cfg.provider === "openrouter" ? cfg.model : cfg.model.replace(/^typesafe\//, ""),
    state,
    questions: {
      relevance: { type: "score", instructions: "How likely is this file to be edited to complete the task?", criteria: LEVELS },
      edit: { type: "noul", instructions: "Will completing this task require changing code in this file?" },
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
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const j: any = await res.json();
    const a = j.answers ?? j;
    const rawScore = a.relevance?.score;
    const levels = Math.max(1, (a.relevance?.legend?.length ?? LEVELS.length) - 1);
    return {
      relevance: typeof rawScore === "number" ? rawScore / levels : null,
      edit: typeof a.edit?.noul === "number" ? a.edit.noul : null,
      inputTokens: j.usage?.input_tokens ?? j.usage?.prompt_tokens ?? 0,
    };
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
  const head = files.slice(0, cfg.topN);
  const tail = files.slice(cfg.topN);
  const stats: RerankStats = { calls: 0, errors: 0, inputTokens: 0, ms: 0, estCostUsd: 0 };

  const answers = await pool(head, cfg.concurrency, async (f) => {
    try {
      const a = await ask(describe(store, f, task), cfg, key);
      stats.calls++;
      stats.inputTokens += a.inputTokens;
      return a;
    } catch (e: any) {
      stats.errors++;
      stats.firstError ??= String(e?.message ?? e).slice(0, 300);
      return { relevance: null, edit: null, inputTokens: 0 };
    }
  });

  const maxRule = Math.max(...head.map((f) => f.score), 1);
  const scored: RerankedFile[] = head.map((f, i) => {
    const a = answers[i];
    const model = a.relevance === null && a.edit === null ? null : 0.7 * (a.relevance ?? a.edit ?? 0) + 0.3 * (a.edit ?? a.relevance ?? 0);
    const ruleNorm = f.score / maxRule;
    // A failed call must not penalise the file: fall back to its rule score alone.
    const w = Number.isFinite(cfg.weight) ? cfg.weight : DEFAULT_RERANK.weight;
    const combined = model === null ? ruleNorm : (1 - w) * ruleNorm + w * model;
    return { ...f, modelScore: model, combined };
  });
  scored.sort((a, b) => b.combined - a.combined || b.score - a.score);
  stats.ms = Date.now() - t0;
  stats.estCostUsd = (stats.inputTokens / 1e6) * 0.042; // OpenRouter listing: $0.042/M in, free out
  return { files: [...scored, ...tail.map((f) => ({ ...f, modelScore: null, combined: 0 }))], stats };
}
