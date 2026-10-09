import { createInterface } from "node:readline";
import { MEMORY_TYPES, openMemory, renderMemory, type MemoryType } from "./notes.js";
import { ensureMemoryDirs, memoryPaths, type MemoryPaths } from "./paths.js";
import { termsOf } from "./terms.js";
import { redact } from "./redact.js";

const VERSION = "0.1.0";

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const str = (description: string) => ({ type: "string", description });

// Short on purpose: every word here is sent to the model on each session.
export const MEMORY_TOOLS: Tool[] = [
  {
    name: "memory_recall",
    description: "Project notes relevant to a topic or files (decisions, constraints, failed approaches). Notes whose files changed since are flagged.",
    inputSchema: { type: "object", properties: { query: str("Topic, in plain words"), files: { type: "array", items: { type: "string" }, description: "Paths you are working on" } } },
  },
  {
    name: "memory_remember",
    description: "Save a decision, constraint, convention, fact or FAILED approach for future sessions. Secrets are scrubbed.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...MEMORY_TYPES] },
        text: str("The knowledge"),
        reason: str("Why"),
        attempt: str("What was tried (for failures)"),
        result: str("What happened (for failures)"),
        files: { type: "array", items: { type: "string" }, description: "Related paths; the note is flagged if they change" },
      },
      required: ["type", "text"],
    },
  },
  {
    name: "memory_list",
    description: "List project notes (active ones by default).",
    inputSchema: { type: "object", properties: { type: { type: "string", enum: [...MEMORY_TYPES] }, all: { type: "boolean", description: "Include resolved and superseded" } } },
  },
  {
    name: "memory_resolve",
    description: "Retire a note that is no longer true. It stays on disk but is never recalled.",
    inputSchema: { type: "object", properties: { id: str("Note id"), status: { type: "string", enum: ["resolved", "superseded"] } }, required: ["id"] },
  },
];

/** Runs one memory tool. Pure and synchronous apart from the file system, so it is easy to test and to call from elsewhere. */
export function callMemoryTool(p: MemoryPaths, name: string, a: Record<string, any>): string {
  ensureMemoryDirs(p);
  const memory = openMemory(p);
  switch (name) {
    case "memory_recall": {
      const q = String(a.query ?? "");
      const files = Array.isArray(a.files) ? a.files.map(String) : [];
      const hits = q || files.length ? memory.relevant(termsOf(q), files, 8).map((h) => h.entry) : memory.load().filter((e) => e.status === "active").slice(-8);
      return hits.length ? hits.map((h) => renderMemory(h, memory.staleFilesOf(h))).join("\n") : "no matching memory";
    }
    case "memory_remember": {
      const type = String(a.type) as MemoryType;
      const e = memory.add({
        type,
        text: String(a.text ?? ""),
        reason: a.reason ? String(a.reason) : undefined,
        attempt: a.attempt ? String(a.attempt) : undefined,
        result: a.result ? String(a.result) : undefined,
        files: Array.isArray(a.files) ? a.files.map(String) : undefined,
        source: "mcp",
      });
      return `recorded ${e.id}`;
    }
    case "memory_list": {
      const type = a.type && MEMORY_TYPES.includes(a.type) ? (a.type as MemoryType) : undefined;
      const list = memory.load(type).filter((e) => a.all === true || e.status === "active");
      return list.length ? list.map((e) => renderMemory(e, memory.staleFilesOf(e))).join("\n") : "no memory entries";
    }
    case "memory_resolve": {
      const status = a.status === "superseded" ? "superseded" : "resolved";
      const e = memory.setStatus(String(a.id ?? ""), status);
      return e ? `${e.id} → ${e.status}` : `no editable note ${a.id}`;
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

/** A stdio MCP server exposing the memory tools for one project folder. */
export async function serveMemoryMcp(root: string): Promise<void> {
  const p = memoryPaths(root);
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
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
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
            serverInfo: { name: "narrowbit-memory", version: VERSION },
            instructions: "Project memory: call memory_recall before starting work on a topic or file, and memory_remember to save decisions, constraints and failed approaches worth keeping.",
          };
        } else if (method === "ping") result = {};
        else if (method === "tools/list") result = { tools: MEMORY_TOOLS };
        else if (method === "tools/call") {
          try {
            result = { content: [{ type: "text", text: redact(callMemoryTool(p, String(params?.name), params?.arguments ?? {})) }] };
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
}
