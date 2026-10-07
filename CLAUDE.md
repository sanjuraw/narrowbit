# Narrowbit

Local, provider-independent coding-agent runtime (CLI `narrowbit`, native Mac app, MCP server): **task + repository + durable evidence → the smallest useful active context**. Goal metric: **correct coding work per unit of AI usage**, not just fewer tokens. If quality drops, Narrowbit has failed.

**History lives in [`docs/history.md`](docs/history.md)** (every handoff, numbered entries 1-67, the full benchmark log). It is not loaded automatically; grep it for specifics (`grep -n "^\*\*4[0-5]\." docs/history.md`, `grep -n "click" docs/history.md`). Add new numbered entries there and keep this file short: it is loaded into every session, and at 220 KB it cost ~91k tokens per session (measured 2026-10-06).

## Current state (handoff, 2026-10-08)

- **Repos (both PRIVATE, nothing on npm):** `sanjuraw/narrowbit` (runtime + app) and `sanjuraw/narrowbit-memory` (mirror of `packages/memory/`; source of truth is this repo, refresh with `scripts/sync-memory-repo.sh`). Both go public together (user's decision), after the go-public checklist below.
- **Machine-specific notes** (folders, accounts, keys, benchmark files, launch-day history cleaning) are in `CLAUDE.local.md`, which is not committed.
- **Code:** last code commit `00d507a` (Claude structured output on by default). Tests: memory 24, unit 266, UI 95, typecheck clean, gitleaks clean. **GitHub Actions is out of minutes until 1 Nov 2026** (private repo): run `npm test`, `npm run test:ui`, `npm test -w narrowbit-memory` and gitleaks locally before every push. Going public restores free CI.
- **Site:** `narrowbit.dev` (Cloudflare registrar, WHOIS redacted) is live on Cloudflare Pages from this repo, serving `soon/` (a coming-soon page with no links into the private repo). The full one-page site is in `site/` (results with their limits, a Narrowbit Memory section); on launch day switch the Pages build output directory from `soon` to `site`. `www.narrowbit.dev` also works. Every other path serves the same page (no source exposed, checked).
- **Email:** `hello@narrowbit.dev` on Zoho Mail (free plan); MX, SPF and DKIM published and checked. Optional DMARC (`_dmarc` TXT `v=DMARC1; p=none; rua=mailto:hello@narrowbit.dev`) not yet added by the user. Don't enable Cloudflare Email Routing (it would replace Zoho's MX).
- **Security work:** audit rounds 1-19 fixed (history entries 1-17, 21, 30-44). Open gaps are stated in `SECURITY.md` → Known limitations (archives extracted over an existing project; checks run project-defined commands; some config files that run under a test command aren't called out).

## Evidence (never claim more)

All n=1 per task, public code, Claude Sonnet 5.5 on both sides unless noted; full caveats in `docs/history.md`.

- **Hono (TypeScript), 40 tasks vs same-day native Claude Code** (entries 61-64): 40/40 vs 40/40; cost $1.43 vs $3.48 (-59%); median uncached input -61%; turns 5.2 vs 7.1; time median 19 vs 16 s (slower), p90 28 vs 28 s. With structured output (entry 64, A/B in one run): 40/40 vs 39/40 without it, no looping replies, fewer turns, same speed, +8% cost.
- **click (Python), 43 tasks vs native** (entry 67, before structured output was on): native 42/42 vs Narrowbit **39/42**, -47% cost, slower (median 30 vs 25 s). Two of the three failures were looping replies. Re-run with structured output pending. **Don't claim equal quality on Python.**
- Codex 40/40 and DeepSeek V4.1 Flash 39/40 (~$0.22 for 40) on Hono. Memory: no proven token saving (entries 28, 29, 36, 46, 47). Scout cut Claude's cost 57% on 10 tasks, unconfirmed at scale. Narrowbit is not faster than native Claude Code.
- An invalid run is on file (entry 66): native's test commands were blocked, so check a native arm's blocked tool calls before trusting any comparison.

## Decisions (don't reopen without a reason)

- Name **Narrowbit**; domain `narrowbit.dev` (registered 2026-10-07 at Cloudflare); `narrowbit.com` is someone else's. Hosting: Cloudflare Pages. Email: Zoho free plan, one address (`hello@`).
- Two repos only. Not split: code index, provider adapters, benchmark kit, compression, Mac shell.
- Public, npm publish need the user's explicit yes. History is cleaned on launch day and published as a NEW repo (not a force-push); see `CLAUDE.local.md`.
- Results are always reported next to their baseline and limits, including what failed (README, site; borrowed from awesome-fly).
- Fork lives on the user's message, not under Scout. New task always starts project-free.
- Defaults from measurement: Claude `sonnet/sonnet/opus` with structured output on (`jsonActions: false` turns it off), Codex `gpt-6-sol` for all slots, lead mode on, compaction at 95% of the model's window, memory injection off, long-lived Claude process on.

## Waiting on the user (don't do unasked)

1. Codex's own audit Part 3 and its re-check of entries 43-44: after its weekly limit resets (10 Oct). Don't run Codex until told.
2. DMARC record and a test email to `hello@narrowbit.dev`.
3. The explicit go-ahead to go public (after the checklist), and whether to create a `narrowbit` GitHub organization for the new repos.
4. Personal items: see `CLAUDE.local.md`.

## Next steps

1. **Python re-run** (in progress): Narrowbit's arm on all 43 click tasks with structured output on, plus native's usage-limit task 27b3ee26. Then put the Python numbers in the README results section, the site (`site/index.html`) and a history entry, whichever way they go. If still below native, look at the failures before launch.
2. **Go-public checklist:** (a) Codex audit Part 3 and fixes; (b) Python result in README and site; (c) run `~/.narrowbit-launch/clean-history.sh`, rename the old repo, publish the cleaned history as a new repo (and `narrowbit-memory`); (d) Pages output dir `soon` → `site`, reconnect Pages to the new repo; (e) put `hello@narrowbit.dev` in `SECURITY.md`; (f) the user's explicit yes.
3. Open speed work: Narrowbit is ~1.2-1.5× slower than native at the median; per-call model time is already on par, the rest is turns and checks.
4. Older open items: memory that saves tokens (multi-file tasks, more repeats), scout at scale, parallel independent subtasks, per-provider usage-limit burn rate, DeepSeek as fallback.

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
