# narrowbit-memory

Project memory for coding agents: decisions, constraints and failed approaches as Markdown notes under `<root>/.narrowbit/memory/`, with an MCP server (`narrowbit-memory serve`) and a small CLI. Local, no model calls. Used by the Narrowbit coding-agent runtime and usable on its own from Claude Code or Codex.

## Where this lives

The source of truth is `packages/memory/` in the `sanjuraw/narrowbit` repo. This repo (`sanjuraw/narrowbit-memory`, private) is a mirror made with `scripts/sync-memory-repo.sh` in that repo. Change code in `narrowbit`, then sync; edits made only here will be overwritten or conflict.

## Rules

- **Boundary (test-enforced):** `src/` imports only itself and `node:` modules. Nothing from the Narrowbit runtime. Paths come in as a plain `MemoryPaths {root, memory, runtime, extraDirs?}`.
- Notes are plain Markdown with frontmatter, one per entry; types: fact, decision, constraint, convention, failure, bug, command, environment.
- Store automatically, inject only on demonstrated relevance (handoff or an explicit `recall`). Never pre-inject by default.
- A note stores `fileHashes` for the files it is about; recall marks it "may be out of date" when one changed or is gone. Notes without hashes are never judged.
- Everything written passes through `redact.ts` first. Add patterns there when a new secret shape appears.
- Forking (`fork.ts`) must never carry provider session ids, session cost or token figures into the copy.

## Commands

```bash
npm install
npm test        # build + 6 tests: boundary rule, public API, remember/recall/stale/resolve, stdio MCP handshake, CLI, fork
node bin/narrowbit-memory.js help
```

Needs Node >= 22.13. Dev dependencies: `typescript`, `@types/node`.

## Status

0.1.0, `private: true`, not published to npm. Only the protocol has been tested against MCP; no real Claude Code or Codex session has used the server yet, and the memory handoff's token benefit is unmeasured (needs a provider-switch A/B).
