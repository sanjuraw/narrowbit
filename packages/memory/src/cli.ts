import { resolve } from "node:path";
import { callMemoryTool, serveMemoryMcp } from "./server.js";
import { memoryPaths } from "./paths.js";

const HELP = `narrowbit-memory — project memory for coding agents

  narrowbit-memory serve [--root <dir>]            run as an MCP server (stdio) for one project
  narrowbit-memory recall <topic> [--root <dir>]   print notes relevant to a topic
  narrowbit-memory list [--all] [--root <dir>]     print the project's notes
  narrowbit-memory remember <type> <text> [--root <dir>]
                                                   save a note (types: fact, decision, constraint, convention, failure, bug, command, environment)

Notes live in <root>/.narrowbit/memory/ as Markdown (opens as an Obsidian vault) and are kept out of git.`;

export async function main(argv: string[]): Promise<number> {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--root") flags.root = argv[++i] ?? "";
    else if (a === "--all") flags.all = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else pos.push(a);
  }
  const root = resolve(typeof flags.root === "string" && flags.root ? flags.root : process.cwd());
  const [cmd, ...rest] = pos;
  if (flags.help || !cmd) {
    console.log(HELP);
    return cmd || flags.help ? 0 : 2;
  }
  const p = memoryPaths(root);
  switch (cmd) {
    case "serve":
      await serveMemoryMcp(root);
      return 0;
    case "recall":
      console.log(callMemoryTool(p, "memory_recall", { query: rest.join(" ") }));
      return 0;
    case "list":
      console.log(callMemoryTool(p, "memory_list", { all: flags.all === true }));
      return 0;
    case "remember": {
      const [type, ...text] = rest;
      if (!type || !text.length) {
        console.error("usage: narrowbit-memory remember <type> <text>");
        return 2;
      }
      console.log(callMemoryTool(p, "memory_remember", { type, text: text.join(" ") }));
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}
