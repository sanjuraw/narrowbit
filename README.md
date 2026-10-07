<p align="center"><img src="docs/assets/logo.svg" width="120" alt="Narrowbit logo"></p>

# Narrowbit

A local, context-managed **coding agent** for your Mac. It plans, reads, edits, runs commands and verifies, keeping a durable local log of everything it does, so a model only ever sees the small slice of context it needs for the next step.

Goal metric: **correct coding work per unit of AI usage**, not just fewer tokens.

- **Bring your own model.** Claude (your Claude subscription), Codex (your ChatGPT subscription), Antigravity (your Google account), or any OpenAI-compatible API: OpenRouter, Groq, Gemini, OpenAI, DeepSeek, Ollama, Ollama Cloud, LM Studio and others. Three model slots (explore / execute / escalate) exist for mixing models, but measurement found a single good model in all three usually wins — see "What is and isn't proven".
- **Point it at a file.** `@path/to/file` in a task reads that file straight into context instead of costing a search turn; attach images or PDFs (Claude, Codex, vision-capable API models) for UI bugs or specs.
- **Rewind.** A checkpoint is taken before a task starts and after every edit; undo any of them without touching your commit history. Files created since the checkpoint are moved to `.narrowbit/rewind-trash/` rather than deleted, and files you have staged are left alone.
- **Local-first.** No telemetry, no repo upload. Selected code and context go to the model provider you choose on every call, the same as typing it into that provider yourself; the app also checks GitHub for updates, and any connectors you configure make their own calls. Secrets are redacted from everything the agent stores or re-reads.
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

**Built-in skills** (in every project's Skills list; click one to drop it into the message box, or `narrowbit agent --skill "bug fix" "<what's wrong>"`): *Bug fix* (root cause, reproduce, smallest fix, verify), *Code review* (correctness, security, tests; changes nothing), *Write tests*, *Refactor* (pin behaviour first, small verified steps), *Explain this code* (read-only walkthrough) and *Security review*. Save a skill with the same name to override one; add your own with the **+** next to Skills.

```bash
narrowbit agent "<task>" [--provider claude|codex|openrouter|...] [--skill "<name>"] [--boss] [--max-steps N]
narrowbit models choose                # pick provider + the three model slots (saved per repo)
narrowbit keys set <provider>          # API key, stored in ~/.narrowbit/keys.json (0600)
narrowbit skills add "Bug Fix" "Reproduce with a failing test, fix the code not the test, verify."
narrowbit connectors add github --env GITHUB_TOKEN=... -- npx -y @modelcontextprotocol/server-github
narrowbit limits                       # Claude / Codex 5-hour and weekly usage
```

`narrowbit agent` edits your working tree directly and refuses to start on a dirty tree unless you pass `--force`. Review the diff before committing.

## What is and isn't proven

Every result below names its baseline and how much it rests on. Tasks are real fixes mined from a project's history: start at the commit before the fix with the fix's own tests added (so they fail), and succeed when those tests pass without the agent touching them. The full log, including what did *not* work, is in [`docs/history.md`](docs/history.md).

**Hono (TypeScript), all 40 tasks, against native Claude Code, both on Claude Sonnet** (history entries 61-63):

| | Native Claude Code | Narrowbit |
|---|---|---|
| Tasks solved | 40 / 40 | 40 / 40 |
| Cost for all 40 | $3.48 | $1.43 (−59%) |
| Uncached input per task (median) | — | −61% |
| Turns per task | 7.1 | 5.2 |
| Task time, median | 16 s | 19 s (slower) |
| Task time, slowest 10% | 28 s | 28 s |

Limits: one repository · one try per task · one model · native measured once on the same day, not repeated · public code the model may have seen · subscription cost is notional (nothing is billed per token).

**Python:** a 43-task run on `pallets/click` is in progress; an earlier 8-task hand-picked set gave 6/8 at about 3× the tokens per task of Hono.

**Other providers, same 40 Hono tasks:** Codex (`gpt-6-sol`) 40/40; DeepSeek V4.1 Flash through its API 39/40, about $0.22 for all 40 at list prices. Antigravity and free API models worked but used 2-3× the tokens, and free models solved about 6-7 of 10.

**What did not work:**
- Narrowbit is not faster than native Claude Code; at best it matches it.
- Mixing models (a cheap one reading, an expensive one editing) lost to one good model doing the whole task, both times measured. A cheap model scouting in its own conversation helped once (Claude's cost −57% on 10 tasks), unconfirmed at scale.
- Project memory notes showed no reliable token saving on single-file fixes.

**Not proven:** other languages and project sizes beyond these, the API adapters beyond DeepSeek, and parallel multi-agent work (untried).

Run the numbers yourself: see "Benchmarking" below.

## Security

- **Every project gets a checkpoint.** `narrowbit audit` (no model, nothing leaves your machine) finds committed secrets, `.env` files git would commit, and secrets given browser-exposed prefixes; it also runs gitleaks over history if installed. The app runs the same scan when you click **Commit** and pauses if it finds credentials. The built-in **Security review** skill asks the agent for the judgement-based checks: access control, data handling, input handling, production hygiene.
- **The agent asks before running commands** (in the app and in the terminal; `--allow-commands` opts out), and its file access is confined to the project folder, symlinks included.
- **Connectors** run commands you configure, like any MCP client; their environment variables (often tokens) are stored in `~/.narrowbit/connectors.json` (mode 0600) and never sent to the app page. Only add servers you trust.
- **Updates trust the repository:** the update button runs `npm install` and a build on whatever is on GitHub `main`. Keep the repo's owners on two-factor authentication.
- Codex's `exec` and Antigravity's `agy` don't fully disable their own tools by flag: Codex is sandboxed and its own tool features are switched off; Antigravity runs under a lean custom agent with one inert tool. Claude runs fully tool-free.
- Report vulnerabilities privately (see `SECURITY.md`).

## Contributing

Issues and PRs welcome. `npm test` and `npm run test:ui` must pass; none call a model. Read `CLAUDE.md` first (architecture, rules, current state), and `docs/history.md` for what was tried and failed, so you don't repeat it. A working rule of this project: every automatic feature needs a measured reason to exist.

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

Used by `narrowbit task`/`claude` and by the agent's `search`; the agent runtime itself does not inject a predicted package (see `docs/history.md` for why).

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

Python repositories work too (pytest, through the repo's `.venv` when it has one); `--setup` runs in each worktree, for example to create that `.venv`.

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

Add a "context hygiene" baseline arm via `arms[].appendSystemPrompt` to compare against a tuned native setup. Check that the native arm can actually run the tests: its commands are limited to `claudeArgs`' allow list, and a test command missing from it quietly turns the run into an unfair comparison.

## Memory

Markdown notes with frontmatter, one per entry, in `.narrowbit/memory/<type>s/` (decisions, constraints, failures, …). Open that folder as an Obsidian vault to browse and edit it; hand-written notes are picked up too. To also read notes you already keep elsewhere, add folders to `memoryDirs` in `.narrowbit/config.json`; these are read-only. Retrieval is deterministic keyword/file overlap, with no model calls. V0 JSON memory migrates automatically.

## Ideas borrowed (MIT-licensed projects; ideas only, no code copied)

- **jcode:** grep results that carry file structure → `nb_grep` (matches tagged with the enclosing function).
- **9router (RTK):** lossless, fail-safe compression of tool output → `git diff` and grep condensers, plus a guard that never returns something larger than the raw output.
- **Claude Code:** old tool output is the first thing to go when context fills, so Narrowbit keeps tool results small up front; the hook sends deltas only, to stay friendly to prompt caching.

## Layout

`src/` holds the modules; `CLAUDE.md` has the full, current module table. Highlights: `runtime.ts` (the agent loop), `providers/` (model adapters), `ui.ts` + `ui-page.ts` (the app), `skills.ts`, `connectors.ts` + `mcpClient.ts`, and the index/ranker/query modules from the original context engine. `mac/` is the SwiftPM native window. `test/` has a fixture generator and the suite: `npm test`.

Requires Node ≥ 22.13 (for `node:sqlite`). Runtime dependency: `typescript` only.

## More things it can do

- **Ask you a question** mid-task instead of guessing, and answer plain questions without touching your files.
- **A suggested next prompt.** When a task ends, the empty box shows a likely follow-up as ghost text (for example "Review your changes for mistakes before I commit them", or "Continue where you left off" if it ran out of steps); Tab fills it in. It comes from simple rules on how the task ended, so it costs no model call, and a plain answer to a question suggests nothing.
- **Isolated runs** (`--isolate`, or the Isolate toggle): the agent works in a separate git worktree; you press **Apply** (or run `narrowbit apply <task>`) to bring the changes into your folder, or **Discard**.
- **Rewind** (`narrowbit rewind <task> [checkpoint]`, or a **Rewind here** button in the app): restores your folder to a checkpoint taken before the task or after any of its edits, deleting anything created since. Built on plain git plumbing; never touches your commit history.
- **`@` mentions**: name a file in your task text and it's read straight into context, no exploration turn needed. The composer autocompletes as you type.
- **Attachments**: images and PDFs on the composer, or `--attach a.png,b.pdf` — useful for pointing at a UI bug from a screenshot.
- **Scout, lead and reviewer on their own models**: research, planning and review can each run on a different provider/model from the worker, in their own conversation (`narrowbit models set scout provider:model`, or the app's Scout dropdown). Off by default — see "What is and isn't proven" for when it helped and when it didn't.
- **Remote connectors**: add a hosted MCP server by URL (Linear, Slack, Notion…) and sign in with your browser, or give it an API token. Every connector call asks first.
- **Skills from GitHub**: import a `SKILL.md`, a folder or a repo (you read it before saving), or save a finished chat as a skill.
- **Step view**: each step has a `context ~N` button showing exactly what the model was sent for it.
- **Light/dark theme** and a hideable sidebar (Cmd/Ctrl+B) in the app.
