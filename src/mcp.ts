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

export const TOOLS: Tool[] = [
  {
    name: "nb_context",
    description:
      "Build a task-specific context package (relevant code sections, tests, project memory, git signals) from the local Narrowbit index. Call once at the start of a task if no Narrowbit context was provided.",
    inputSchema: { type: "object", properties: { task: str("The task description, including any error text or stack trace.") }, required: ["task"] },
  },
  {
    name: "nb_symbol",
    description: "Source of a function/class/method/type by name (e.g. `verifySignature` or `PaymentService.retry`). Cheaper than grepping and reading whole files.",
    inputSchema: { type: "object", properties: { name: str("Symbol name or Class.method") }, required: ["name"] },
  },
  {
    name: "nb_refs",
    description: "Where a symbol is defined and which functions/methods use it (import-aware).",
    inputSchema: { type: "object", properties: { name: str("Symbol name") }, required: ["name"] },
  },
  {
    name: "nb_outline",
    description: "Map of one file: symbols with line ranges and signatures, imports, importers, and related tests. Use before reading a large file.",
    inputSchema: { type: "object", properties: { path: str("Repo-relative file path") }, required: ["path"] },
  },
  {
    name: "nb_search",
    description: "Ranked search over files and symbols using the Narrowbit index (identifiers, paths, comments). Returns files with matching symbol signatures and line ranges.",
    inputSchema: { type: "object", properties: { query: str("What you are looking for"), limit: num("Max results (default 10)") }, required: ["query"] },
  },
  {
    name: "nb_expand",
    description: "Next most relevant context for the current task that has not been delivered yet. Use when the initial context was not enough.",
    inputSchema: { type: "object", properties: { budget: num("Approximate token budget for the expansion (default 4000)") } },
  },
  {
    name: "nb_grep",
    description:
      "Grep the repo (case-insensitive, literal by default) with results grouped by file and tagged with the enclosing function/method, so you rarely need to open the file. Prefer over the Grep tool.",
    inputSchema: {
      type: "object",
      properties: { pattern: str("Text to find (or a regex if regex=true)"), glob: str("Optional pathspec, e.g. 'src/**/*.ts'"), regex: { type: "boolean" }, limit: num("Max matches shown (default 40)") },
      required: ["pattern"],
    },
  },
  {
    name: "nb_tests",
    description: "Test files mapped to a source file (by imports and naming).",
    inputSchema: { type: "object", properties: { path: str("Repo-relative source file path") }, required: ["path"] },
  },
  {
    name: "nb_lines",
    description: "Exact lines of a file (redacted for secrets).",
    inputSchema: { type: "object", properties: { path: str("file path"), start: num("first line"), end: num("last line") }, required: ["path", "start", "end"] },
  },
  {
    name: "nb_run",
    description:
      "Run a shell command in the repo (tests, type-check, lint, build) and get COMPRESSED output: summaries, failing tests with assertion messages, type errors grouped by file. Raw output is saved locally. Prefer this over Bash for noisy commands.",
    inputSchema: { type: "object", properties: { command: str("Shell command"), timeout_s: num("Timeout in seconds (default 600)") }, required: ["command"] },
  },
  {
    name: "nb_verify",
    description: "Run the project's configured checks (type-check, lint, tests focused on changed files) and return only failures.",
    inputSchema: { type: "object", properties: { full: { type: "boolean", description: "Run the full test suite instead of focused tests" } } },
  },
  {
    name: "nb_remember",
    description:
      "Record durable project knowledge outside the conversation: a decision (with reason), a constraint, a convention, a fact, or a FAILED approach (attempt + result) so future tasks do not retry it.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...MEMORY_TYPES] },
        text: str("The knowledge, one or two sentences"),
        reason: str("Why (for decisions/constraints)"),
        attempt: str("What was tried (for failures)"),
        result: str("What happened (for failures)"),
        files: { type: "array", items: { type: "string" }, description: "Related repo paths" },
      },
      required: ["type", "text"],
    },
  },
  {
    name: "nb_memory",
    description: "Active project memory relevant to a query (decisions, constraints, failed approaches).",
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
        return hits.length ? hits.map(renderMemory).join("\n") : "no matching memory";
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
