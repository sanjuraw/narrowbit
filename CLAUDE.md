# Narrowbit

Context-efficiency engine for coding agents: **task + repository → minimum sufficient context**. It sits alongside Claude Code (later Codex, Antigravity, others) and does repo understanding, retrieval, memory and output compression locally, so the model spends fewer turns and tokens getting oriented.

Goal metric: **correct coding work per unit of AI usage**, not just fewer tokens. If quality drops, Narrowbit has failed.

## Status (update this section as things change)

- V0 CLI is built and pushed to a **private** GitHub repo: `sanjuraw/narrowbit` (branch `main`).
- Offline selection eval on `honojs/hono` (40 commits, commit message as the task): recall@10 97.5%, 82% of changed files loaded as code, ~5.2k-token packages (estimated). Commit messages are weak prompts, so this is a lower bound.
- **The core thesis is NOT yet proven**: ≥40% less effective context than native Claude Code at equal or better task success. Only the paired benchmark (`narrowbit benchmark`) measures it. It spends the user's Claude quota, so **ask before running it**. Never claim token savings until it has run.
- Live smoke test done (2026-09-19, 1 task, Sonnet, this repo): narrowbit arm SUCCESS, native arm FAIL (it silently changed an unrelated output line); 293k vs 367k total input tokens (-20.2%), fresh input -6.4%, $0.29 vs $0.31. n=1 on a 32-file repo — an anecdote, not evidence. Confirmed working end to end: MCP server connects, all 13 nb_* tools load, usage parsing.
- Known environment gotcha: the npm-installed `claude` on this machine is broken (native binary missing; stale `.claude-code-*` temp dir blocks reinstall). Benchmarks use `claudeBin` / `$NARROWBIT_CLAUDE` pointing at the desktop app's bundled binary.
- `scripts/build-tasks.mjs` mines a repo's history into a benchmark task set (start = parent + the fix's tests applied; success = those tests pass; `--verify-each` proves fail→pass). Verified working on this repo's own history; the Hono set still needs a run with its deps installed.
- `src/rerank.ts` (opt-in, OFF by default): re-ranks the rule shortlist with a hosted decision model (TypeSafe Jev via OpenRouter, $0.042/M in). Sends paths + signatures only, never file contents — it breaks local-first, so it is experiment-only and not wired into the package builder. One Choice call per task over the whole shortlist (≤255 options); its probability distribution is the ranking, blended with the rule score. Provider auto-detects: TypeSafe direct if `TYPESAFE_API_KEY` is set, else OpenRouter (`OPENROUTER_API_KEY`). Measure with `narrowbit eval --rerank`; costs their credit, not Claude quota.
- **Jev re-ranking result (2026-09-20, hono, 40 commits, weight 0.5):** hit@1 25% → **82.5%** (+57.5pp), recall@5 79.4% → **95.6%** (+16.3pp), MRR 0.530 → 0.894, recall@10 unchanged at 97.5% (already at ceiling). 40 calls, 0 errors, ~83k input tokens, ~$0.0035 equivalent. Weights 0.8/1.0 were no better than 0.5, so the rules still contribute. Ordering only — this has NOT been shown to save agent tokens; that needs the package builder wired up and the paired benchmark.
- **`narrowbit train` (local, no model calls, no deps):** fits per-signal weights from the repo's own history (each past commit = "this message → these files changed"), pairwise logistic loss, 30% held-out, stored in `.narrowbit/weights.json` and applied automatically; refuses to apply a fit that made held-out ordering worse. Hono, trained on older commits and evaluated on the 40 most recent (no overlap): hit@1 25% → **60%**, recall@5 79.4% → 83.8%, MRR 0.530 → 0.721, gold files **loaded as code 81.9% → 89.4%**. Jev re-ranking reaches hit@1 82.5% but needs a hosted service; training is the local answer and closes about half the gap. Learned weights are per-repo.
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
