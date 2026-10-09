# Narrowbit

Local, provider-independent coding-agent runtime (CLI `narrowbit`, native Mac app, MCP server): **task + repository + durable evidence → the smallest useful active context**. Goal metric: **correct coding work per unit of AI usage**, not just fewer tokens. If quality drops, Narrowbit has failed.

**History lives in [`docs/history.md`](docs/history.md)** (every handoff, numbered entries 1-85, the full benchmark log). It is not loaded automatically; grep it for specifics (`grep -n "^\*\*4[0-5]\." docs/history.md`, `grep -n "click" docs/history.md`). Add new numbered entries there and keep this file short: it is loaded into every session, and at 220 KB it cost ~91k tokens per session (measured 2026-10-06).

## Current state (handoff, 2026-10-08)

- **Repos (both PUBLIC since 2026-10-09, early 0.1 preview, nothing on npm):** `sanjuraw/narrowbit` (runtime + app; its history was cleaned of personal details before publishing, so its commit hashes differ from the old private repo) and `sanjuraw/narrowbit-memory` (mirror of `packages/memory/`; source of truth is this repo, refresh with `scripts/sync-memory-repo.sh`). The full pre-cleaning history is kept in a private repo (see `CLAUDE.local.md`).
- **Machine-specific notes** (folders, accounts, keys, benchmark files, launch-day history cleaning) are in `CLAUDE.local.md`, which is not committed.
- **Code:** last code commit is the thirty-first-audit commit (entry 83; before it the thirtieth, entry 82; the twenty-ninth, entry 81; the twenty-eighth, entry 80; the twenty-seventh, entry 79; the twenty-sixth, entry 78; before it the twenty-fifth audit, entry 77; before it the own audit, entry 76; before it entries 72-75; before it entry 71 and `00d507a`, Claude structured output on by default). Tests: memory 52, unit 321, UI 99, typecheck clean, gitleaks clean. CI runs on GitHub Actions (free now that the repos are public, first green run 2026-10-09), but still run `npm test`, `npm run test:ui`, `npm test -w narrowbit-memory` and gitleaks locally before every push.
- **Deployed:** the app uses a separate deployed clone through the global `narrowbit` link; check `git log -1` there rather than trusting any hash written here. Machine details (paths, accounts, the Mac app copy) are in `CLAUDE.local.md`. The memory mirror is synced at the same commit.
- **Site:** `narrowbit.dev` (Cloudflare registrar, WHOIS redacted) is live on Cloudflare Pages from the public repo: the Pages project `narrowbit-site` builds `site/` (the full one-page site: results with their limits, a Narrowbit Memory section) from `sanjuraw/narrowbit` `main`, with custom domains `narrowbit.dev` and `www.narrowbit.dev`. `soon/` is the old coming-soon page and is no longer served.
- **Email:** `hello@narrowbit.dev` on Zoho Mail (free plan); MX, SPF and DKIM published and checked; the user confirmed mail arrives (2026-10-08). Listed in `SECURITY.md` and the site footer. Optional DMARC (`_dmarc` TXT `v=DMARC1; p=none; rua=mailto:hello@narrowbit.dev`) not yet added by the user. Don't enable Cloudflare Email Routing (it would replace Zoho's MX).
- **Security work:** audit rounds 1-31 fixed plus an own audit (history entries 1-17, 21, 30-44, 71-85). Open gaps are stated in `SECURITY.md` → Known limitations (archives extracted over an existing project; checks run project-defined commands; configuration files in subfolders aren't noticed when a command rewrites them). `narrowbit install claude` pre-approves only the read tools (no blanket `mcp__narrowbit`; existing installs keep an old blanket entry until it is re-run; this repo's own local `.claude/settings.local.json` still has one). Free-run ("ask, except checks") mode is an allowlist of parsed commands (entries 74, 75; run `node scripts/fuzz-free-run.mjs` after any change to it): new permission logic gets an adversarial test list before it ships, because the last three rounds each found holes in it.
- **Housekeeping:** Codex's evidence folders (`.audit-*/`, now git-ignored) sit untracked in the dev checkout; delete them once nothing in them is needed. File-ownership notes are in `CLAUDE.local.md`.

## Evidence (never claim more)

All n=1 per task, public code, Claude Sonnet 5.5 on both sides unless noted; full caveats in `docs/history.md`.

- **Hono (TypeScript), 40 tasks vs same-day native Claude Code** (entries 61-64): 40/40 vs 40/40; cost $1.43 vs $3.48 (-59%); median uncached input -61%; turns 5.2 vs 7.1; time median 19 vs 16 s (slower), p90 28 vs 28 s. With structured output (entry 64, A/B in one run): 40/40 vs 39/40 without it, no looping replies, fewer turns, same speed, +8% cost.
- **click (Python), 43 tasks vs native** (entries 67-68, structured output on): 43/43 vs 43/43; cost $3.07 vs $5.05 (-39%); median uncached input -51%; turns 8.0 vs 9.3; **slower: median 36 vs 25 s** (Narrowbit's arm ran ~4 h after native's). Before structured output: 39/42 (two looping replies).
- Codex 40/40 and DeepSeek V4.1 Flash 39/40 (~$0.22 for 40) on Hono. Memory: no proven token saving (entries 28, 29, 36, 46, 47). Scout cut Claude's cost 57% on 10 tasks, unconfirmed at scale. Narrowbit is not faster than native Claude Code.
- An invalid run is on file (entry 66): native's test commands were blocked, so check a native arm's blocked tool calls before trusting any comparison.

## Decisions (don't reopen without a reason)

- Name **Narrowbit**; domain `narrowbit.dev` (registered 2026-10-07 at Cloudflare); `narrowbit.com` is someone else's. Hosting: Cloudflare Pages. Email: Zoho free plan, one address (`hello@`).
- Two repos only. Not split: code index, provider adapters, benchmark kit, compression, Mac shell.
- npm publish needs the user's explicit yes (nothing is on npm). The repos were made public on 2026-10-09 by publishing the cleaned history as a NEW repo (not a force-push); details in `CLAUDE.local.md`.
- Results are always reported next to their baseline and limits, including what failed (README, site; borrowed from awesome-fly).
- Fork lives on the user's message, not under Scout. New task always starts project-free.
- Defaults from measurement: Claude `sonnet/sonnet/opus` with structured output on (`jsonActions: false` turns it off), Codex `gpt-6-sol` for all slots, lead mode on, compaction at 95% of the model's window, memory injection off, long-lived Claude process on.

## Waiting on the user (don't do unasked)

1. Another independent Codex pass, if the user wants one before going public: entry 72 lists what it did not certify (every filesystem call x every path attack, every secret sink, a naturally won race, the native Mac shell, live OAuth/GitHub/provider calls). Don't run Codex until told.
2. The optional DMARC record (`_dmarc` TXT). 
3. Whether to move the repos to a `narrowbit` GitHub organization later. (Private vulnerability reporting is on for both repos and the owner's 2FA is on, as of 2026-10-09.)
4. Personal items: see `CLAUDE.local.md`.

## Next steps

1. **Speed on Python:** Narrowbit is ~1.4× slower than native on click (entry 68); break the time down as in entry 62 (model, verify, loops, commands) and fix the largest part.
2. **After going public:** done on 2026-10-09: Pages reconnected (project `narrowbit-site`, output `site`). Still to do: CI gitleaks is now 8.30.1; a clean-profile install and update smoke test is still owed; the memory repo's CI must be re-run once to clear failures caused by the old billing block (check `gh run list --repo sanjuraw/narrowbit-memory`).
3. Open speed work: Narrowbit is ~1.2-1.5× slower than native at the median; per-call model time is already on par, the rest is turns and checks.
4. **Memory on multi-file tasks** (entry 69; result 2026-10-08): no win. 15 pairs x 3 repeats, 90 B runs, success 45/45 in both arms; median per-task cost ratio memory/none 1.09 (rule: <= 0.90), only 6/15 tasks cheaper (rule: >= 10), total cost ratio 0.975. Don't claim a memory saving; README and site stay as they are. Revisit only with a new idea for what a note should contain.
5. Older open items: scout at scale, parallel independent subtasks, per-provider usage-limit burn rate, DeepSeek as fallback.

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
2. Local-first: no repo upload, no telemetry; secrets never indexed; emitted text goes through the pattern-based redactor (best effort, see `SECURITY.md`).
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
