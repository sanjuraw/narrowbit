# narrowbit-memory

Project memory for coding agents. It remembers the things that aren't in the code — a decision and its reason, a constraint, a convention, an approach that already failed — as plain Markdown notes in the project, and gives them back when an agent asks.

- **Local, no model calls.** Nothing is sent anywhere and nothing is summarised by an AI; notes are stored exactly as saved (with secrets scrubbed first) and found by plain keyword and file matching.
- **Notes know when they may be out of date.** A note about `src/pay.ts` stores a fingerprint of that file; if the file has changed since, recall says so instead of presenting the note as current.
- **It's just files.** `<project>/.narrowbit/memory/` — one `.md` per note, grouped by type; open it as an Obsidian vault, edit by hand, commit nothing (the folder is kept out of git).
- **Works with any agent that speaks MCP**, and ships as a library too.

## Use it with an agent (MCP)

Run it from the project folder (or pass `--root`):

```bash
node packages/memory/bin/narrowbit-memory.js serve
```

Claude Code:

```bash
claude mcp add narrowbit-memory -- node /path/to/narrowbit/packages/memory/bin/narrowbit-memory.js serve
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.narrowbit-memory]
command = "node"
args = ["/path/to/narrowbit/packages/memory/bin/narrowbit-memory.js", "serve"]
```

Tools: `memory_recall` (by topic and/or files), `memory_remember`, `memory_list`, `memory_resolve`.

Narrowbit itself uses the same notes folder, so what an agent saves through MCP is there for Narrowbit's tasks too, and the other way round.

## Command line

```bash
narrowbit-memory remember decision "Fees are flat, never a percentage"
narrowbit-memory recall fees
narrowbit-memory list --all
```

## As a library

```js
import { memoryPaths, openMemory, renderMemory } from "narrowbit-memory";
const mem = openMemory(memoryPaths("/path/to/project"));
mem.add({ type: "decision", text: "Fees are flat", files: ["src/pay.ts"] });
mem.relevant(["fees"], []).map(({ entry }) => renderMemory(entry, mem.staleFilesOf(entry)));
```

Also exported: the per-task event log and the summary a new model starts from when it takes a task over (`fold`, `appendEvent`, `digestWithMemory`), automatic per-task notes (`recordTaskNote`), and the secret scrubber (`redact`).

## Status

Early. It is developed inside the Narrowbit repository (`packages/memory`) and not published to npm. Everything in `src/` imports only from `src/` and `node:` — a test enforces this, so the package can be lifted out on its own.
