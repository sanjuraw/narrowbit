# Narrowbit

Local, provider-independent coding-agent runtime (CLI `narrowbit`, native Mac app, MCP server): **task + repository + durable evidence → the smallest useful active context**. Goal metric: **correct coding work per unit of AI usage**, not just fewer tokens. If quality drops, Narrowbit has failed.

**History lives in [`docs/history.md`](docs/history.md)** (every handoff, numbered entries 1-45, the full benchmark log). It is not loaded automatically; grep it for specifics (`grep -n "^\*\*4[0-5]\." docs/history.md`, `grep -n "click" docs/history.md`). Add new numbered entries there and keep this file short: it is loaded into every session, and at 220 KB it cost ~91k tokens per session (measured 2026-10-06).

## Current state (2026-10-06)

- **Repos (both PRIVATE, nothing on npm):** `sanjuraw/narrowbit` (runtime + app) and `sanjuraw/narrowbit-memory` (mirror of `packages/memory/`; the source of truth is this repo, refresh with `scripts/sync-memory-repo.sh`).
- **Folders:** dev checkout `/Users/Shared/Projects/Narrowbit` (owner the main account, group-writable for `staff`, `core.sharedRepository group`; the the second account account needs `safe.directory` for it); deployed clone `/Users/Shared/NarrowbitApp` (at `1abe5d4`); app `/Applications/Narrowbit.app`.
- **Last code commit `1abe5d4`** (nineteenth audit, Part 3). Tests there: memory 24, unit 244, UI 93, typecheck clean. CI green on `b17b743` (gitleaks allowlist for the fake test secrets). **GitHub Actions is out of minutes until 1 Nov 2026** (2,000/month on a private repo; the test job ran on macOS, which counts 10x): runs are refused ("spending limit"), nothing is billed. Until then run `npm test`, `npm run test:ui`, `npm test -w narrowbit-memory` and gitleaks locally before every push, and push in batches. CI now runs on Linux, skips docs-only pushes and cancels superseded runs; macOS only by hand. The Linux run hasn't been seen yet: check it after 1 Nov.
- **Security work:** audit rounds 1-19 are fixed (history entries 1-17, 21, 30-44). Still open: archives extracted over an existing project (entry 32 #2). Accepted tradeoffs: `nb_verify`/direct `verify` and benchmark specs run configured commands; config files that execute under an approved test command (`vitest.config.ts`, `jest.config.*`, `.yarnrc.yml`, `noxfile.py`) aren't in the script-warning list.

## Evidence (never claim more)

Hono, 40 real bug-fix tasks, n=1 per task, public code: Claude via the runtime ~90% fewer tokens than the `mcpOnly` baseline at ~equal success (39-40/40); Codex 40/40; DeepSeek V4.1 Flash 39/40 at ~$0.22 for all 40. Python/click: 6/8, ~3.3× the tokens. Memory: no proven token saving (entries 28, 29, 36, 46, 47: notes, including exact-pointer notes, cut fresh tokens and cost on average but per-task results go both ways, inside the noise; single-file fixes are the wrong place for memory to pay). Scout (Codex sol scouting Claude) cut Claude's cost 57% on 10 tasks, unconfirmed at scale. Details and caveats: `docs/history.md`.

## Decisions (don't reopen without a reason)

- Name **Narrowbit** ("harness" is a description); site will be `narrowbit.dev` (user registers it; none built until going public). `narrowbit.com` is someone else's.
- Two repos only. Not split: code index (likeliest third), provider adapters, benchmark kit, compression, Mac shell.
- Repo stays private; public, npm publish and the domain need the user's explicit yes.
- Fork lives on the user's message, not under Scout. New task always starts project-free.
- Defaults from measurement: Claude `sonnet/sonnet/opus`, Codex `gpt-6-sol` for all slots, lead mode on, compaction at 95% of the model's window, memory injection off.

## Waiting on the user (don't do unasked)

1. Codex's own audit Part 3 and its re-check of entries 43-44: after its weekly limit resets (10 Oct). Don't run Codex until told.
2. October Bus connector test (download/run their daemon; state file, source and size first).
3. Android APK for a separate app of the user's (EAS login or a ~5-6 GB local toolchain).
4. `claude update` on the shared Mac must be run as the second account (owner of the install).

## Next steps

1. Memory that saves tokens: pointer notes (entry 46) and path-triggered notes (entry 47, `--memory-inject path`) showed no clear win on single-file fixes. Remaining idea: architecture/convention notes measured on multi-file tasks with more repeats.
2. Coding experience (entry 49): Narrowbit tasks take ~83 s vs ~63 s in native Claude Code; 2.6-3.8 s of every turn is starting a new `claude` process. Next: one long-lived process per task, then live streaming, then permission modes.
3. Older open items: scout at scale, parallel independent subtasks, Python task mining in `build-tasks.mjs`, per-provider usage-limit burn rate, DeepSeek as fallback.

## Working rules

- Measure before changing a default; cite numbers with their caveats. Every feature needs a benchmark reason.
- No third-party installs or downloads without explicit OK. Never enter credentials into tools.
- Commit trailer names the model that did the work (`Co-Authored-By: Claude <model> <noreply@anthropic.com>`); repo-local git identity only (GitHub no-reply for `sanjuraw`); never change another account's global git config or folder permissions yourself.
- Every fix gets a regression test confirmed to fail on the old code. Re-verify an outside review's claims in the code before fixing.
- Bound every test run (`--test-timeout`), never overlap build/test chains, add a `test-ui/` case for every UI change.
- `ui-page.ts` holds the page JS in a `String.raw` template: no backticks in it (`grep -c '`'` stays 3).
- Commit bodies of user-visible changes are shown as release notes in the app: write them in plain language.
- After pulling into the deployed clone: `npm install`, then `npm run build`; rebuild the Mac app (`scripts/build-mac-app.sh --install`) only if `mac/` changed.
- zsh: no `timeout`, `$VAR` doesn't word-split, each Bash call resets cwd.

## Product principles

1. Deterministic computation first, AI reasoning second (index, git, parsers for "where is X").
2. Local-first: no repo upload, no telemetry; secrets never indexed; all emitted text redacted.
3. Start narrow, expand only on evidence. Store memory automatically, inject only on demonstrated relevance; never predictive pre-injection by default (it failed twice: see the 2026-09-22 handoffs in history).
4. Officially supported integration points only (APIs, CLIs, MCP, hooks); no scraping, patching or credential extraction.
5. Provider-independent core; integrations are thin.

## Commands

```bash
npm install
npm run build          # memory package, then tsc → dist/
npm test               # build + memory package tests + unit tests (no model calls)
npm run test:ui        # jsdom checks of the app page + app-level flows with a stand-in model
npm test -w narrowbit-memory
scripts/build-mac-app.sh [--install]
scripts/sync-memory-repo.sh
node bin/narrowbit.js help
```

Node ≥ 22.13 (`node:sqlite`). `bin/narrowbit.js` imports `dist/`: rebuild after editing `src/`.

## Architecture

| Area | Modules |
|---|---|
| Agent loop | `runtime.ts` (actions, batching ≤5, done gate, stall guard, compaction, lead/scout/reviewer), `approvals.ts`, `planning.ts`, `followup.ts`, `route.ts` |
| Providers | `providers/claude-cli.ts`, `codex-cli.ts`, `antigravity-cli.ts`, `openai-compat.ts`, `models.ts` (registry, catalogs, context windows), `streamjson.ts`, `keys.ts`, `limits.ts`, `errors.ts` |
| Memory (package) | `packages/memory/src`: notes, event log, evidence, projection, hand-over digest, fork, redact, safefs, MCP server; imports only itself and `node:`. `src/memory.ts` etc. are thin re-exports |
| Index & retrieval | `files.ts`, `parser.ts`, `resolve.ts`, `store.ts` (bump `SCHEMA_VERSION` on schema change), `indexer.ts`, `taskparse.ts`, `ranker.ts`, `package.ts`, `query.ts`, `train.ts`, `eval.ts`, `rerank.ts` |
| Safety | `trust.ts` (git filters, repo config, shipped `.narrowbit/`), `guard.ts`, `audit.ts`, `util.ts` (`safeAbsPath`, `gitArgs`, project-file helpers), `checkpoints.ts` (rewind/discard), `isolate.ts` |
| App & CLI | `cli.ts`, `ui.ts` + `ui-page.ts` (local server + page; `mac/` wraps it), `project.ts`, `update.ts`, `readiness.ts`, `mentions.ts`, `attachments.ts` |
| Integrations | `mcp.ts` (`nb_*` server), `mcpClient.ts`, `mcpHttp.ts`, `oauth.ts`, `connectors.ts`, `claude.ts`, `skills.ts`, `builtin-skills.ts`, `skillimport.ts` |
| Measurement | `bench.ts`, `scripts/build-tasks.mjs`, `compress.ts`, `verify.ts` |

State lives in `.narrowbit/` in the target repo (self-gitignored, files `0600`). Never read or write it through links (history entries 31-43).

## Testing notes

`test/fixture.mjs` builds a throwaway TS repo. In `test-ui/ui.test.mjs`, `page.w` is the jsdom window; page tests feed events through `window.__nb.stream`; start a run before opening its SSE stream. A runtime test that edits a file needs a `run`/`verify` in the fake model's replies to clear the done gate.
