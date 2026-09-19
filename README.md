# Narrowbit (V0)

**Task + repository → minimum sufficient context** for coding agents. Local-first, deterministic-first, no model calls of its own.

V0 scope, per the brief: CLI, TypeScript/JavaScript repo index, rule-based task relevance, Claude Code integration, verification, and benchmarking.

## Status: what is proven so far and what isn't

- **Selection quality (free, offline):** `narrowbit eval` on `honojs/hono` (471 files, 6.5k symbols) takes each of the last 40 source-changing commits and replays its message as the task. Results:
  - 97.5% recall@10
  - 82% of changed files loaded as code (not just an outline)
  - about 5.2k-token packages, estimated

  Commit messages are weak task descriptions, so treat these numbers as a lower bound.
- **Not proven yet:** the thesis itself, ≥40% less *effective* context than native Claude Code at equal quality. Only `narrowbit benchmark run` measures that, using provider-reported token usage on 30–50 real tasks. Nothing in this repo claims savings until that has run.

## Quick start

```bash
npm install && npm run build
cd /path/to/your-ts-repo
node /path/to/Narrowbit/bin/narrowbit.js init           # creates .narrowbit/ (self-gitignored) + .narrowbitignore, indexes
narrowbit task "Fix Razorpay signature verification failing after payment callback"
narrowbit inspect                                       # why each file was selected
narrowbit claude "<task>"                               # launch Claude Code with the package + MCP tools
```

Or integrate with plain `claude` sessions, so there's no change to how you work:

```bash
narrowbit install claude     # .mcp.json (narrowbit MCP server) + UserPromptSubmit hook in .claude/settings.local.json
```

## Commands

| | |
|---|---|
| `init`, `index [--force]`, `status` | incremental index (mtime/size fast-path, then content hash) |
| `task "<text>" [--budget N] [--print] [--json] [--error-file f]` | compile a context package |
| `inspect`, `context`, `expand`, `close [--success\|--failure]` | explain selection, show the package, get more context, record the outcome and selection recall against the files actually changed |
| `symbol`, `refs`, `outline`, `search`, `tests` | deterministic lookups (the same ones are exposed over MCP) |
| `run -- <cmd>` | run a command and get compressed output (tsc, eslint, vitest/jest/mocha/node:test, npm, generic); raw log kept in `.narrowbit/logs` |
| `verify [--full]` | type-check + lint + tests *focused on changed files*, reporting only the failures |
| `memory add <type> "<text>"` … | decisions, constraints, conventions, facts, **failed approaches**; stored as JSON in `.narrowbit/memory` |
| `eval [--commits N]` | offline selection benchmark over git history |
| `benchmark init \| run <file> \| report` | paired A/B: native Claude Code vs Claude Code + Narrowbit |
| `stats` | aggregates over recorded tasks |

MCP tools (`narrowbit mcp`): `nb_context`, `nb_symbol`, `nb_refs`, `nb_outline`, `nb_search`, `nb_grep`, `nb_expand`, `nb_tests`, `nb_lines`, `nb_run`, `nb_verify`, `nb_remember`, `nb_memory`.

## How selection works (`src/ranker.ts`, `src/package.ts`)

The ranker scores files with rule-based signals. The weights are in `WEIGHTS` and meant to be tuned with `eval` and `benchmark`:
- BM25 over identifier sub-words, comments and path segments, with morphological expansion (verification↔verify)
- exact symbol names mentioned in the task
- fuzzy matches against symbol names
- mentioned paths, and module names (e.g. "trie router" → `router/trie-router/`)
- stack-frame locations, including the enclosing function
- project memory
- git dirty/recency, which only amplifies existing evidence and ignores bulk commits
- import-graph propagation from seed files
- callers of seed symbols
- penalties for tests, docs, config and generated files

The package is then filled progressively up to the budget, 8k by default:
1. small files in full
2. otherwise the matching functions (by name, or by body vocabulary for large files) plus a file outline
3. outlines for secondary files
4. path-only candidates

It also includes related tests with the focused-test command, the relevant git state and relevant memory. A confidence label (`high`, `medium` or `low`) tells the agent when to treat the selection as hints.

All emitted text is secret-redacted. `.env*`, keys and credentials are never indexed.

## Benchmarking

```bash
narrowbit benchmark init            # writes benchmark.json; fill in 30–50 real tasks with verify commands
narrowbit benchmark run benchmark.json --dry-run
narrowbit benchmark run benchmark.json
narrowbit benchmark report
```

- **Isolation:** each task × arm runs `claude -p --output-format stream-json` in a fresh git worktree at the same commit, with `--strict-mcp-config` so the user's other MCP servers don't skew either arm, and with arm order alternated between tasks.
- **Recorded per run:** success (the verify command's exit code), input, cache-creation, cache-read and output tokens, cost, turns, tool calls, files read and searches.
- **Report:** the north-star metric (successful tasks per million input tokens) and paired reductions. It gives the brief's GO/NO-GO verdict only once n ≥ 30 tasks.

Add a "context hygiene" baseline arm via `arms[].appendSystemPrompt` to compare against a tuned native setup (brief §38).

## Memory

Markdown notes with frontmatter, one per entry, in `.narrowbit/memory/<type>s/` (decisions, constraints, failures, …). Open that folder as an Obsidian vault to browse and edit it; hand-written notes are picked up too. To also read notes you already keep elsewhere, add folders to `memoryDirs` in `.narrowbit/config.json`; these are read-only. Retrieval is deterministic keyword/file overlap, with no model calls. V0 JSON memory migrates automatically.

## Ideas borrowed (MIT-licensed projects; ideas only, no code copied)

- **jcode:** grep results that carry file structure → `nb_grep` (matches tagged with the enclosing function).
- **9router (RTK):** lossless, fail-safe compression of tool output → `git diff` and grep condensers, plus a guard that never returns something larger than the raw output.
- **Claude Code:** old tool output is the first thing to go when context fills, so Narrowbit keeps tool results small up front; the hook sends deltas only, to stay friendly to prompt caching.

## Layout

`src/` holds the modules:

| Module | Role |
|---|---|
| `indexer` | indexing |
| `parser` | TypeScript compiler API parsing |
| `resolve` | module resolution: relative, tsconfig paths, workspaces |
| `store` | `node:sqlite` storage |
| `ranker` | relevance ranking |
| `package` | context package builder |
| `query` | deterministic lookups |
| `compress` | command-output compression |
| `verify` | verification checks |
| `memory` | project memory |
| `tasks` | task records |
| `mcp` | hand-rolled stdio JSON-RPC server |
| `claude` | launcher, install, hook |
| `bench` | A/B benchmark |
| `eval` | offline history eval |

`test/` contains a fixture generator (a payments/auth app among 50 unrelated feature files, with git history) and the test suite: `npm test`.

Requires Node ≥ 22.13 (for `node:sqlite`). Runtime dependency: `typescript` only.
