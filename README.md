# Narrowbit

A local, context-managed **coding agent** for your Mac. It plans, reads, edits, runs commands and verifies, keeping a durable local log of everything it does, so a model only ever sees the small slice of context it needs for the next step.

Goal metric: **correct coding work per unit of AI usage**, not just fewer tokens.

- **Bring your own model.** Claude (your Claude subscription, via the `claude` CLI), Codex (your ChatGPT subscription, via `codex`), or any OpenAI-compatible API: OpenRouter, Groq, Gemini, OpenAI, DeepSeek, Ollama, LM Studio and others. Three model slots (explore / execute / lead) route cheap work to cheap models.
- **Local-first.** No telemetry, no repo upload. The only network calls are to the model provider you choose. Secrets are redacted from everything the agent stores or re-reads.
- **You stay in control.** Commands ask for approval, edits show as diffs, and nothing is committed until you say so. "Done" is checked against your repo's own verify commands.
- **Extensible.** Reusable **skills** (task templates) and **connectors** (any MCP server, e.g. GitHub) the agent can call.

> **Status: early (0.1).** Expect rough edges. See "What is and isn't proven" below.

## Install

macOS. The installer checks what you have, asks before installing anything missing (Homebrew, Node), clones this repo to `~/Narrowbit`, builds it, puts `narrowbit` on your PATH and builds the native app:

```bash
git clone https://github.com/sanjuraw/narrowbit.git ~/Narrowbit && ~/Narrowbit/scripts/install.sh
```

Run `scripts/install.sh --check` first to only see what's missing. It can't sign in for you: to use Claude run `claude auth login` (or `codex login`, or add a free API key); the app's "get a model ready" card and `narrowbit doctor` show what's left. If the repo is private you need GitHub access (`gh auth login`).

Manual install: Node ≥ 22.13, then `npm install && npm run build && npm link && scripts/build-mac-app.sh --install`.

Then in any project folder: `narrowbit init`, and either `narrowbit ui` (browser/app) or `narrowbit agent "fix the failing test in src/foo.ts"`.

**Updating:** the app checks GitHub on launch (and every few hours) and shows an **Update available** banner; **Update now** fast-forwards the checkout, reinstalls if dependencies changed, rebuilds (rolling back if the build fails) and restarts. It refuses to touch a copy with uncommitted edits or local-only commits, and only the account that owns the folder can update it. Manual equivalent: `git pull --ff-only && npm install && npm run build`, then reopen the app.

## Using it

```bash
narrowbit agent "<task>" [--provider claude|codex|openrouter|...] [--skill "<name>"] [--no-boss] [--max-steps N]
narrowbit models choose                # pick provider + the three model slots (saved per repo)
narrowbit keys set <provider>          # API key, stored in ~/.narrowbit/keys.json (0600)
narrowbit skills add "Bug Fix" "Reproduce with a failing test, fix the code not the test, verify."
narrowbit connectors add github --env GITHUB_TOKEN=... -- npx -y @modelcontextprotocol/server-github
narrowbit limits                       # Claude / Codex 5-hour and weekly usage
```

`narrowbit agent` edits your working tree directly and refuses to start on a dirty tree unless you pass `--force`. Review the diff before committing.

## What is and isn't proven

Measured on `honojs/hono`: 40 tasks mined from real commits (start at the parent commit with the fix's tests applied; success = those tests pass), Claude models only.

- **Vs. Claude Code + Narrowbit's own MCP tools** (n=40): the agent finished 39/40 tasks (baseline 40/40) using ~90% fewer input tokens at ~56% lower notional cost. The one failure was an infrastructure error, not a wrong answer.
- **Vs. plain native Claude Code** (n=15 subset, earlier version of the loop): 15/15 both, ~75% fewer tokens, about half the cost.
- **Not proven:** other repos or languages, models other than Claude, or the Codex and API-provider adapters on real tasks. The Codex adapter has only been verified on its error path; the API providers only against a mock server. "Cost" for subscriptions is notional (nothing is billed per token).

Run the numbers yourself: see "Benchmarking" below. Full history, including the approaches that did *not* work, is in `CLAUDE.md`.

## Security notes

- `connectors` run commands you configure (like any MCP client). Only add servers you trust; their environment variables (often tokens) are stored in `~/.narrowbit/connectors.json` with mode 0600.
- Codex's `exec` has no switch to disable its own tools, so the adapter runs it read-only sandboxed; Claude runs fully tool-free.
- Report vulnerabilities privately via GitHub security advisories rather than public issues.

## Contributing

Issues and PRs welcome. `npm test` must pass (43 tests, none call a model). Read `CLAUDE.md` first: it documents the architecture and, more importantly, what was tried and failed, so you don't repeat it. A working rule of this project: every automatic feature needs a measured reason to exist.

## Command reference (context tools, also usable standalone)

| | |
|---|---|
| `init`, `index [--force]`, `status` | incremental index (mtime/size fast-path, then content hash) |
| `task "<text>" [--budget N] [--print] [--json] [--error-file f]` | compile a context package |
| `inspect`, `context`, `expand`, `close [--success\|--failure]` | explain selection, show the package, get more context, record the outcome |
| `symbol`, `refs`, `outline`, `search`, `grep`, `tests` | deterministic lookups (also exposed over MCP as `nb_*` tools) |
| `run -- <cmd>` | run a command, get compressed output; raw log kept in `.narrowbit/logs` |
| `verify [--full]` | type-check + lint + tests focused on changed files, failures only |
| `memory add <type> "<text>"` … | decisions, constraints, conventions, facts, **failed approaches**, as Markdown in `.narrowbit/memory` |
| `train`, `eval` | learn / measure file-ranking weights from git history (local, no model calls) |
| `benchmark init \| run <file> \| report` | paired A/B benchmarks |
| `claude "<task>"`, `install claude` | the older Claude Code sidecar mode (MCP tools + hook) |

## Context selection (`src/ranker.ts`, `src/package.ts`)

Used by `narrowbit task`/`claude` and by the agent's `search`; the agent runtime itself does not inject a predicted package (see the history in `CLAUDE.md` for why).

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

Build a task set from a repository's own history (no model calls):

```bash
node scripts/build-tasks.mjs --repo ../hono --out bench-hono.json --max 40 --verify-each --setup "npm ci"
```

Each commit that changed source *and* its tests becomes a task: the agent starts at the parent commit with the commit's **tests already applied** (so they fail) and must make them pass without touching the tests. `--verify-each` proves every task is winnable by checking fail→pass with the real fix. Add `--with-body` to include the commit body in the prompt (usually explains the fix, so off by default).

```bash
narrowbit benchmark init            # or hand-write benchmark.json
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

`src/` holds the modules; `CLAUDE.md` has the full, current module table. Highlights: `runtime.ts` (the agent loop), `providers/` (model adapters), `ui.ts` + `ui-page.ts` (the app), `skills.ts`, `connectors.ts` + `mcpClient.ts`, and the index/ranker/query modules from the original context engine. `mac/` is the SwiftPM native window. `test/` has a fixture generator and the suite: `npm test`.

Requires Node ≥ 22.13 (for `node:sqlite`). Runtime dependency: `typescript` only.
