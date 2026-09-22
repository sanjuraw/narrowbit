# Narrowbit

Context-efficiency engine for coding agents: **task + repository → minimum sufficient context**. It sits alongside Claude Code (later Codex, Antigravity, others) and does repo understanding, retrieval, memory and output compression locally, so the model spends fewer turns and tokens getting oriented.

Goal metric: **correct coding work per unit of AI usage**, not just fewer tokens. If quality drops, Narrowbit has failed.

## Status (update this section as things change)

- V0 CLI is built and pushed to a **private** GitHub repo: `sanjuraw/narrowbit` (branch `main`).
- Offline selection eval on `honojs/hono` (40 commits, commit message as the task): recall@10 97.5%, 82% of changed files loaded as code, ~5.2k-token packages (estimated). Commit messages are weak prompts, so this is a lower bound.
- **PAIRED BENCHMARK RUN (2026-09-22, hono, 40 tasks from `scripts/build-tasks.mjs --verify-each`, Sonnet, rule-based ranker only — trained weights and local-decider re-ranking were NOT wired into `buildPackage`/this run):**
  - Success: native 40/40, narrowbit 40/40 — no quality regression either direction.
  - Total input tokens: native mean 568,502, narrowbit mean 459,649 → **aggregate reduction 19.1%**. Per-task: median 11.4%, mean 3.9% (skewed by a few huge-token tasks).
  - **Fresh (uncached, full-price) input tokens were HIGHER for narrowbit on 39 of 40 tasks — including on narrowbit's biggest wins.** Median fresh-token change: -56.2% (i.e. narrowbit typically used ~56% *more* fresh tokens). Real dollar cost: narrowbit $10.32 vs native $9.85 total — narrowbit cost *more*, despite fewer total tokens.
  - Turns/tools: narrowbit meaningfully lower (8.5 vs 11.2 turns, 7.8 vs 10.2 tool calls) — the one place it's unambiguously better.
  - **Mechanism:** the context package (~2.4-5.8k tokens) plus 13 MCP tool schemas are a fixed fresh-token tax paid on every single task. The apparent win is concentrated in *cached* tokens (already ~90% discounted) saved by needing fewer exploration turns over a session; it does not reduce, and on this run increased, the expensive uncached slice.
  - **Verdict per brief thresholds: NO-GO** (aggregate reduction 19.1% < 20% floor; brief §65 kill criterion "token savings remain under ~20%" is met). n=40 meets the brief's minimum sample size — not underpowered.
  - Total spend: $20.17 (under the $35-60 estimate).
  - **Not yet tried before concluding:** wiring the validated local-ranking improvements (`narrowbit train`, local decider re-ranking) into `buildPackage` and re-running — those improve *which* file is selected but would not by themselves fix the fresh-token tax, which comes from fixed per-turn overhead (package + tool schemas), not selection accuracy. A smaller, targeted fix (fewer/shorter tool descriptions, smaller default budget) is the more direct lever if this is worth pursuing further.
- **SECOND FULL RUN (2026-09-22), trimmed system prompt + tool schemas (AGENT_PROTOCOL 211->64 tokens, MCP tool descriptions 1293->854 tokens, dropped verbose MORE CANDIDATES section) — hypothesis: fixed per-turn overhead was the fresh-token tax. Result: WORSE, not better.**
  - A diagnostic 8-task subset (deliberately the 5 worst regressions from run 1 + 3 already-good tasks) showed a dramatic apparent fix: -39% aggregate vs native, cost flipped to a win. **This was misleading** — regression-to-the-mean on cherry-picked outliers, not a real broad effect. Recorded here as a lesson in test design, not a result to trust.
  - Full unbiased 40-task re-run (native reused from run 1, unchanged): aggregate reduction dropped from run 1's 19.1% to **11.2%**; fresh tokens got worse (+46.6% vs native, worse than run 1); cost worse ($11.08 vs native $9.85, also worse than run 1's $10.32). Turns/tools did drop again (11.2->8.8, 10.2->8.3) — a real, repeatable behavioral change from the shorter prompt — but it did not translate into fewer tokens or lower cost at full scale.
  - **Two independent full-scale runs now both say NO-GO, with the second one worse than the first.** The core thesis (>=40% less effective context at equal/better success) is NOT met. Trying to fix the fresh-token tax by shortening the system prompt made it worse, not better — the mechanism is not simply "fixed overhead size." Further micro-tuning of prompt wording is not recommended without a fundamentally different experimental design (e.g. a hook that enforces tool use rather than offering it, tested on a random/full sample from the start, not a cherry-picked one).
  - Total spend across both full runs + diagnostics: ~$45-50.
- Never claim token savings without citing these results.
- Live smoke test done (2026-09-19, 1 task, Sonnet, this repo): narrowbit arm SUCCESS, native arm FAIL (it silently changed an unrelated output line); 293k vs 367k total input tokens (-20.2%), fresh input -6.4%, $0.29 vs $0.31. n=1 on a 32-file repo — an anecdote, not evidence. Confirmed working end to end: MCP server connects, all 13 nb_* tools load, usage parsing.
- Known environment gotcha: the npm-installed `claude` on this machine is broken (native binary missing; stale `.claude-code-*` temp dir blocks reinstall). Benchmarks use `claudeBin` / `$NARROWBIT_CLAUDE` pointing at the desktop app's bundled binary.
- `scripts/build-tasks.mjs` mines a repo's history into a benchmark task set (start = parent + the fix's tests applied; success = those tests pass; `--verify-each` proves fail→pass). Verified working on this repo's own history; the Hono set still needs a run with its deps installed.
- `src/rerank.ts` (opt-in, OFF by default): re-ranks the rule shortlist with a hosted decision model (TypeSafe Jev via OpenRouter, $0.042/M in). Sends paths + signatures only, never file contents — it breaks local-first, so it is experiment-only and not wired into the package builder. One Choice call per task over the whole shortlist (≤255 options); its probability distribution is the ranking, blended with the rule score. Provider auto-detects: TypeSafe direct if `TYPESAFE_API_KEY` is set, else OpenRouter (`OPENROUTER_API_KEY`). Measure with `narrowbit eval --rerank`; costs their credit, not Claude quota.
- **Jev re-ranking result (2026-09-20, hono, 40 commits, weight 0.5):** hit@1 25% → **82.5%** (+57.5pp), recall@5 79.4% → **95.6%** (+16.3pp), MRR 0.530 → 0.894, recall@10 unchanged at 97.5% (already at ceiling). 40 calls, 0 errors, ~83k input tokens, ~$0.0035 equivalent. Weights 0.8/1.0 were no better than 0.5, so the rules still contribute. Ordering only — this has NOT been shown to save agent tokens; that needs the package builder wired up and the paired benchmark.
- **`narrowbit train` (local, no model calls, no deps):** fits per-signal weights from the repo's own history (each past commit = "this message → these files changed"), pairwise logistic loss, 30% held-out, stored in `.narrowbit/weights.json` and applied automatically; refuses to apply a fit that made held-out ordering worse. Hono, trained on older commits and evaluated on the 40 most recent (no overlap): hit@1 25% → **60%**, recall@5 79.4% → 83.8%, MRR 0.530 → 0.721, gold files **loaded as code 81.9% → 89.4%**. Jev re-ranking reaches hit@1 82.5% but needs a hosted service; training is the local answer and closes about half the gap. Learned weights are per-repo.
- **Local decider (2026-09-22): `scripts/laya_server.py` + `laya` (Apache 2.0, ModernBERT-421M, github.com/NandhaKishorM/laya) as an in-process, offline alternative to hosted Jev.** `rerank.ts` gained a `provider: "local"` pointed at `NARROWBIT_LOCAL_DECIDER` (same request/response shape, no auth). Installed in an isolated venv (`~/bench-repos/laya-env`) because system Python had a conflicting `transformers`; first call per language ~20-28s (lazy per-language checkpoint load), warm calls ~50-80ms on the M4's MPS backend. Hono, 40 commits, no overlap with training data:
  - Laya alone (rules off): hit@1 25% → 40% (+15pp) — worse than local-trained weights alone.
  - Trained weights + Laya blended in (weight 0.5, the Jev-tuned default): hit@1 60% → 35% (**-25pp** — Laya actively hurts at that blend).
  - Trained weights + a *small* Laya nudge (weight 0.1-0.15): hit@1 60% → **65%** (+5pp), MRR 0.721 → 0.750-0.753 — the best local-only result so far, but a small, unvalidated-on-holdout edge; treat as noise until repeated on more commits or another repo.
  - For reference: hosted Jev alone reached 82.5%. A 421M encoder is not a substitute for Jev's judgement at this task; it's a free, offline, small improvement on top of trained weights only.
  - Default `rerank.ts` weight (0.5) is tuned for hosted Jev and is a poor default for Laya; if Laya is kept, its default weight should drop to ~0.1-0.15.
- **`scripts/decider_server.py` + `decider` (Apache 2.0, github.com/Mapika/decider, Mapika/decider-2b) — a second local decider, installed direct from GitHub (its PyPI listing "decider" is unrelated/unaffiliated, no homepage/author — do not trust it).** This is the strongest local result so far, closing most of the gap to hosted Jev. Same hono/40-commit protocol, trained weights blended with decider-2b:
  - Decider-2b alone (rules off): hit@1 25% → **65%** — already beats trained weights alone (60%) and Laya (40%).
  - Trained weights + decider-2b, weight sweep: 0.15→67.5%, **0.2→72.5% (peak)**, 0.25→70%, 0.3→70%, 0.4→65%, 0.5→65%, 0.7→67.5%, 1.0→67.5% (only setting where recall@10 regressed, to 94.4%). 0.2 is a genuine local optimum (both neighbors lower), not a single lucky point — still n=40 on one repo, so treat as directional.
  - Best local-only combo: hit@1 **72.5%**, recall@5 86.3%, MRR 0.802, recall@10 unaffected (97.5%) — closes ~56% of the gap from trained-weights-alone (60%) to hosted Jev (82.5%), fully offline.
  - **Operational lesson:** fp32 on MPS for a 2B model got silently OOM-killed by macOS (no Python traceback, just process death — this machine has 16GB unified memory). bf16 on MPS fixed it (`torch.backends.mps` supports bf16) and is now `decider_server.py`'s default for non-CPU devices.
  - Not yet tried: SemIf (github.com/TheoLeeCJ/SemIf, formerly OpenJev) — heavier (Qwen3.5-4B, ~9GB), CLI/batch-file oriented (`semif-score`, jsonl in/out) rather than a simple library call, added native Apple Silicon MPS/MLX support the same day this was tested (2026-09-22). Untried given decider-2b's local result is already close to Jev.
- Not done yet: running the 30–50 task benchmark, Codex and Antigravity integrations, automatic end-of-task memory extraction.

## Product principles (from the brief)

1. Deterministic computation first, AI reasoning second. Use the index, git and parsers for "where is X", "who imports Y", "which tests failed".
2. Local-first. No repo upload, no source telemetry. Secrets never indexed; all emitted text is redacted.
3. Start narrow, expand only on evidence (progressive context loading; `nb_expand`).
4. Every feature needs a benchmark reason to exist. Measure, don't assume.
5. Use only officially supportable integration points (MCP, hooks, CLI flags). No scraping private UIs, patching binaries, or extracting credentials.
6. Provider-independent core; integrations are thin.

**Out of scope for V0:** GUI/Mac app, cloud, multi-provider router, account switching, vector DB/embeddings (add only if benchmarks show keyword matching fails), agent swarms.

**Kill/pivot criteria:** benchmark reduction under ~20%, quality materially worse, native harnesses already this efficient, or users constantly override the selection.

**Go thresholds (n ≥ 30 tasks):** <20% NO-GO, 20–40% CONTINUE, ≥40% GO, ≥60% STRONG GO, all at equal or better success.

## Commands

```bash
npm install
npm run build          # tsc → dist/
npm test               # build + node --test test/*.test.mjs (22 tests)
npm run typecheck
node bin/narrowbit.js help
```

Requires Node ≥ 22.13 (uses `node:sqlite`). Only runtime dependency: `typescript`. `bin/narrowbit.js` imports `dist/`, so **rebuild before running the CLI** after editing `src/`.

## Architecture (`src/`)

| Module | Role |
|---|---|
| `cli.ts` | Command dispatch and arg parsing |
| `config.ts` | Paths, `.narrowbit/config.json`, default ignore list, verify-command detection |
| `files.ts` | File discovery (git ls-files, else walk), gitignore-style `IgnoreMatcher`, file kinds |
| `parser.ts` | TypeScript compiler API: symbols, methods, routes, test cases, imports, terms |
| `resolve.ts` | Module resolution: relative, tsconfig `paths`/`baseUrl`, workspace packages |
| `store.ts` | SQLite schema (`files`, `symbols`, `symbol_refs`, `imports`, `terms`, `tests_map`); bump `SCHEMA_VERSION` on schema change |
| `indexer.ts` | Incremental index (mtime+size fast path, then sha1), import resolution, test mapping |
| `terms.ts` | Identifier splitting, stemming, term extraction |
| `taskparse.ts` | Task text → terms, identifiers, paths, stack-frame locations, errors |
| `ranker.ts` | Rule-based relevance scoring (`WEIGHTS`), term expansion, graph propagation, confidence |
| `package.ts` | Context package builder: budgeted, progressive (full file → symbol snippets → outline → path only) |
| `query.ts` | Deterministic lookups: symbol, refs, outline, search, grep, tests, expand |
| `compress.ts` | Command-output compression (tsc, eslint, test runners, npm, git diff, grep, generic) with a fail-safe |
| `verify.ts` | Type-check + lint + tests focused on changed files |
| `memory.ts` | Markdown+frontmatter notes, Obsidian-compatible; read-only external dirs via `memoryDirs` |
| `tasks.ts` | Task records in `.narrowbit/tasks/` |
| `mcp.ts` | Hand-rolled stdio JSON-RPC MCP server (tools `nb_*`) |
| `claude.ts` | `narrowbit claude` launcher, `install claude`, UserPromptSubmit hook |
| `bench.ts` | Paired A/B benchmark harness (git worktrees, `claude -p --output-format stream-json`), report and verdict |
| `eval.ts` | Free offline selection eval over git history |
| `redact.ts` | Secret redaction applied to all emitted text |

State lives in `.narrowbit/` in the target repo (self-gitignored, files `0600`): `index.db`, `config.json`, `memory/`, `tasks/`, `logs/`, `benchmarks/`, `sessions/`.

## Key design details

- **Ranking signals:** BM25 over identifier sub-words/comments/paths (with morphological expansion), exact and fuzzy symbol names, path and module-name mentions, stack-frame locations, memory-referenced files, git dirty/recency (amplifies existing evidence only; bulk commits ignored), import-graph neighbours, callers of seed symbols, penalties for tests/docs/config/generated. Weights are placeholders to tune against `eval`/`benchmark`.
- **Confidence label** (`high`/`medium`/`low`) is emitted in the package so the agent knows when to treat selection as hints.
- **Token counts are estimates** (chars / 3.6) and labelled "est." everywhere. Benchmarks use provider-reported usage from Claude Code's stream-json output.
- **Memory:** one note per entry in `.narrowbit/memory/<type>s/` (types: fact, decision, constraint, convention, failure, bug, command, environment). Retrieval is deterministic keyword/file overlap; failed approaches get a boost. Legacy JSON memory auto-migrates.
- **Claude Code integration:** `narrowbit claude "<task>"` (appends the package as system prompt + attaches MCP), or `narrowbit install claude` (project `.mcp.json` + `UserPromptSubmit` hook in `.claude/settings.local.json`). The hook never blocks or errors the session; follow-up prompts get only new context.
- **Benchmark isolation:** each task × arm in a fresh worktree at the same commit, `--strict-mcp-config`, alternating arm order. Supports a third "context hygiene" baseline arm (brief §38).

## Testing notes

- `test/fixture.mjs` builds a throwaway TS repo (payments/auth app plus 50 unrelated feature files, with git history and a fake `.env` secret). Tests cover parser, ignore rules, redaction, compression, stream parsing, indexing, ranking, memory, grep, lookups, expansion, CLI, hook and the MCP protocol.
- For real-repo checks, clone a TS repo into the scratchpad and run `narrowbit eval --commits 40` (used `honojs/hono`). Beware overfitting weights to one repo.

## Conventions

- TypeScript, ESM (`NodeNext`), strict. Match the surrounding comment density (sparse; explain *why*).
- Never make a compressor or selector silently drop information the agent needs; when unsure, fall back to raw or a wider selection.
- Commits end with the `Co-Authored-By: Claude …` trailer for the current model. The repo uses a repo-local git identity (GitHub no-reply address for `sanjuraw`); don't change global git config.

## Borrowed ideas (MIT-licensed projects; ideas only, no code copied)

- **jcode:** structure-aware grep → `nb_grep`.
- **9router (RTK):** lossless, fail-safe tool-output compression → git diff/grep condensers and the fail-safe.
- **Claude Code:** clear old tool output first, keep prompt prefixes cache-friendly → keep tool results small; hook sends deltas.
- Not adopted: 9router "caveman mode" (model-level), jcode embedding recall and multi-session swarm, DeepSeek Harness (nothing concrete found on context handling). Codex harness not yet researched.

## Roadmap (in order)

1. Smoke test: one task, native vs Narrowbit, on the fixture. Confirms the live MCP/hook/usage-parsing path.
2. Build the 30–50 task benchmark set from a real TS repo's history (prompt, start commit, success command, expected files).
3. Run the paired benchmark (ideally 2 repeats, plus a context-hygiene arm; consider Serena and repo-map tools as comparisons). Act on the verdict.
4. If GO: automatic end-of-task memory extraction, staleness detection for memory tied to changed code, Codex integration, then Antigravity/Gemini.
5. Only after that: polished UX (Mac app, VS Code extension, etc.).

## Competitors and comparisons to keep in mind

Serena (LSP-based symbol tools, MCP), Aider repo map, Zilliz claude-context, 9router RTK, jcode, DeepSeek Harness, Claude Code's own compaction/subagents/caching. Narrowbit must beat *realistic* baselines, not just an unoptimized agent.
