import { createInterface } from "node:readline";
import { loadConfig, type Paths } from "./config.js";
import { runCommand } from "./compress.js";
import { indexRepo, openStore } from "./indexer.js";
import { Memory, openMemory, MEMORY_TYPES, renderMemory, type MemoryType } from "./memory.js";
import { buildPackage } from "./package.js";
import { expandTask, fileRangeText, grepText, outlineText, refsText, searchText, symbolText, testsText } from "./query.js";
import { Tasks } from "./tasks.js";
import { estimateTokens, now } from "./util.js";
import { verify, verifyRecord } from "./verify.js";

const VERSION = "0.1.0";

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

// Descriptions are kept to one short clause: every word here is sent fresh (uncached) on
// every task, since each benchmark/CLI session starts cold. See CLAUDE.md "fresh-token tax".
export const TOOLS: Tool[] = [
  {
    name: "nb_context",
    description: "Build task context from the local index (once, if none was injected).",
    inputSchema: { type: "object", properties: { task: str("Task description") }, required: ["task"] },
  },
  {
    name: "nb_symbol",
    description: "Source of a function/class/method by name.",
    inputSchema: { type: "object", properties: { name: str("Symbol name or Class.method") }, required: ["name"] },
  },
  {
    name: "nb_refs",
    description: "Definition + callers of a symbol.",
    inputSchema: { type: "object", properties: { name: str("Symbol name") }, required: ["name"] },
  },
  {
    name: "nb_outline",
    description: "File map: symbols, imports, importers, tests.",
    inputSchema: { type: "object", properties: { path: str("File path") }, required: ["path"] },
  },
  {
    name: "nb_search",
    description: "Ranked file/symbol search over the index.",
    inputSchema: { type: "object", properties: { query: str("Query"), limit: num("Max results") }, required: ["query"] },
  },
  {
    name: "nb_expand",
    description: "More context for the current task, not yet delivered.",
    inputSchema: { type: "object", properties: { budget: num("Token budget") } },
  },
  {
    name: "nb_grep",
    description: "Grep tagged with enclosing function; prefer over Grep.",
    inputSchema: {
      type: "object",
      properties: { pattern: str("Text/regex"), glob: str("Pathspec"), regex: { type: "boolean" }, limit: num("Max matches") },
      required: ["pattern"],
    },
  },
  {
    name: "nb_tests",
    description: "Tests mapped to a source file.",
    inputSchema: { type: "object", properties: { path: str("Source path") }, required: ["path"] },
  },
  {
    name: "nb_lines",
    description: "Exact file lines, redacted.",
    inputSchema: { type: "object", properties: { path: str("Path"), start: num("First line"), end: num("Last line") }, required: ["path", "start", "end"] },
  },
  {
    name: "nb_run",
    description: "Run a command; compressed output. Prefer over Bash for noisy commands.",
    inputSchema: { type: "object", properties: { command: str("Command"), timeout_s: num("Timeout") }, required: ["command"] },
  },
  {
    name: "nb_verify",
    description: "Type-check/lint/focused tests; failures only.",
    inputSchema: { type: "object", properties: { full: { type: "boolean", description: "Full suite" } } },
  },
  {
    name: "nb_remember",
    description: "Record a decision, constraint, fact, or FAILED approach.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...MEMORY_TYPES] },
        text: str("Knowledge"),
        reason: str("Why"),
        attempt: str("What was tried"),
        result: str("Outcome"),
        files: { type: "array", items: { type: "string" }, description: "Related paths" },
      },
      required: ["type", "text"],
    },
  },
  {
    name: "nb_memory",
    description: "Active project memory relevant to a query.",
    inputSchema: { type: "object", properties: { query: str("Topic") } },
  },
];

export async function serveMcp(p: Paths): Promise<void> {
  const cfg = loadConfig(p);
  const store = openStore(p);
  const tasks = new Tasks(p);
  const memory = openMemory(p);
  let lastIndex = 0;
  const refresh = () => {
    // The agent edits files between calls; keep line ranges honest with a cheap incremental re-index.
    if (Date.now() - lastIndex < 1500) return;
    indexRepo(p, store);
    lastIndex = Date.now();
  };

  const log = (tool: string, args: Record<string, unknown>, text: string) => {
    const id = tasks.current();
    if (!id) return;
    tasks.update(id, (t) => t.events.push({ at: now(), tool, args, tokens: estimateTokens(text) }));
  };

  const call = async (name: string, a: any): Promise<string> => {
    switch (name) {
      case "nb_context": {
        refresh();
        const b = buildPackage(store, p, cfg, String(a.task), { source: "mcp", withProtocol: false });
        tasks.save(b.record);
        tasks.setCurrent(b.record.id);
        return `${b.text}\n\n(narrowbit task ${b.record.id}; ~${b.record.packageTokens} tokens est.)`;
      }
      case "nb_symbol":
        refresh();
        return symbolText(p, store, String(a.name));
      case "nb_refs":
        refresh();
        return refsText(store, String(a.name));
      case "nb_outline":
        refresh();
        return outlineText(store, String(a.path));
      case "nb_search":
        refresh();
        return searchText(p, store, String(a.query), Number(a.limit ?? 10));
      case "nb_grep":
        refresh();
        return grepText(p, store, String(a.pattern), { glob: a.glob, regex: !!a.regex, limit: a.limit ? Number(a.limit) : undefined });
      case "nb_tests":
        refresh();
        return testsText(store, String(a.path));
      case "nb_lines":
        return fileRangeText(p, String(a.path), Number(a.start), Number(a.end));
      case "nb_expand": {
        refresh();
        const id = tasks.current();
        const t = id ? tasks.load(id) : null;
        if (!t) return "no active narrowbit task; call nb_context first";
        const r = expandTask(p, cfg, store, t, Number(a.budget ?? 4000));
        tasks.update(t.id, (x) => x.given.push(...r.given));
        return r.text;
      }
      case "nb_run": {
        const r = await runCommand(p, String(a.command), { timeoutMs: Number(a.timeout_s ?? 600) * 1000 });
        const id = tasks.current();
        if (id)
          tasks.update(id, (t) =>
            t.runs.push({ at: now(), command: r.command, exit: r.exit, rawLog: r.rawLog, rawTokens: r.rawTokens, compressedTokens: r.compressedTokens, kind: r.compressed.kind }),
          );
        return r.rendered;
      }
      case "nb_verify": {
        refresh();
        const id = tasks.current();
        const t = id ? tasks.load(id) : null;
        const v = await verify(p, cfg, store, t, { full: !!a.full });
        if (t) tasks.update(t.id, (x) => (x.verify = verifyRecord(v)));
        return v.report;
      }
      case "nb_remember": {
        const type = String(a.type) as MemoryType;
        const e = memory.add({
          type,
          text: String(a.text),
          reason: a.reason,
          attempt: a.attempt,
          result: a.result,
          files: Array.isArray(a.files) ? a.files.map(String) : undefined,
          source: tasks.current() ?? "mcp",
        });
        return `recorded ${e.id}`;
      }
      case "nb_memory": {
        const q = String(a.query ?? "");
        const { termsOf } = await import("./terms.js");
        const hits = q ? memory.relevant(termsOf(q), [], 15).map((h) => h.entry) : memory.load().filter((e) => e.status === "active").slice(-20);
        return hits.length ? hits.map((h) => renderMemory(h, memory.staleFilesOf(h))).join("\n") : "no matching memory";
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  };

  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        return;
      }
      const { id, method, params } = msg;
      if (id === undefined || id === null) return; // notification
      try {
        let result: unknown;
        if (method === "initialize") {
          result = {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "narrowbit", version: VERSION },
            instructions:
              "Narrowbit serves task-relevant repository context from a local index. Prefer nb_symbol/nb_refs/nb_outline/nb_search over broad Glob/Grep and whole-file reads; prefer nb_run for tests/builds; record decisions and failed approaches with nb_remember.",
          };
        } else if (method === "ping") result = {};
        else if (method === "tools/list") result = { tools: TOOLS };
        else if (method === "tools/call") {
          const name = params?.name;
          const args = params?.arguments ?? {};
          try {
            const text = await call(name, args);
            log(name, args, text);
            result = { content: [{ type: "text", text }] };
          } catch (e: any) {
            result = { content: [{ type: "text", text: `error: ${e?.message ?? e}` }], isError: true };
          }
        } else if (method === "resources/list") result = { resources: [] };
        else if (method === "prompts/list") result = { prompts: [] };
        else {
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
          return;
        }
        send({ jsonrpc: "2.0", id, result });
      } catch (e: any) {
        send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message ?? e) } });
      }
    });
  });
  await new Promise<void>((r) => rl.on("close", () => r()));
  await queue;
  store.close();
}
