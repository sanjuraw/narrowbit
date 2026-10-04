import { spawn } from "node:child_process";
import type { Connector } from "./connectors.js";
import { openHttpSession } from "./mcpHttp.js";

/**
 * A minimal MCP client over stdio: spawn a connector, do the initialize handshake, then either list
 * its tools or call one, and exit. One-shot per call rather than a kept-alive connection — simplest
 * correct thing for v1 (matches how providers/claude-cli.ts already spawns a fresh process per model
 * call before session persistence was added there too); the cost is a subprocess start per connector
 * action, acceptable for how infrequently a task reaches for an external tool. Speaks the same
 * newline-delimited JSON-RPC framing mcp.ts already implements as a server, just as a client instead.
 */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface ToolCallResult {
  text: string;
  isError: boolean;
}

function withConnector<T>(c: Connector, timeoutMs: number, onReady: (send: (msg: object) => void, onMessage: (fn: (msg: any) => void) => void, done: (v: T | PromiseLike<T>) => void, fail: (e: Error) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(c.command, c.args, { stdio: ["pipe", "pipe", "pipe"], detached: true, env: { ...process.env, ...c.env } });
    let settled = false;
    let stderr = "";
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        fn();
      } finally {
        // The whole process group: a connector started through a wrapper (npx, uvx) would otherwise outlive it.
        try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill(); }
      }
    };
    const done = (v: T | PromiseLike<T>) => finish(() => resolve(v));
    const fail = (e: Error) => finish(() => reject(e));
    const timer = setTimeout(() => fail(new Error(`${c.name}: timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    child.on("error", (e) => fail(new Error(`${c.name}: couldn't start "${c.command}" (${e.message}) — is it installed?`)));
    child.stderr.on("data", (d) => {
      stderr = (stderr + String(d)).slice(-2000);
    });
    child.on("exit", (code) => {
      if (!settled) fail(new Error(`${c.name}: exited before responding${code ? ` (code ${code})` : ""}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}`));
    });
    let buf = "";
    const handlers: ((msg: any) => void)[] = [];
    child.stdout.on("data", (d) => {
      buf += String(d);
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        for (const h of handlers) h(msg);
      }
    });
    const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + "\n");
    const onMessage = (fn: (msg: any) => void) => handlers.push(fn);
    onReady(send, onMessage, done, fail);
  });
}

function initialize(send: (msg: object) => void, onMessage: (fn: (msg: any) => void) => void, next: () => void, fail: (e: Error) => void) {
  onMessage((m) => {
    if (m.id === 1) {
      if (m.error) return fail(new Error(String(m.error.message ?? "initialize failed")));
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      next();
    }
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "narrowbit", version: "0.1.0" } } });
}

export async function listConnectorTools(c: Connector, timeoutMs = 15_000): Promise<McpTool[]> {
  if (c.url) {
    const s = await openHttpSession(c, timeoutMs);
    return ((await s.request("tools/list"))?.tools ?? []) as McpTool[];
  }
  return listStdioTools(c, timeoutMs);
}

function listStdioTools(c: Connector, timeoutMs: number): Promise<McpTool[]> {
  return withConnector<McpTool[]>(c, timeoutMs, (send, onMessage, done, fail) => {
    initialize(send, onMessage, () => send({ jsonrpc: "2.0", id: 2, method: "tools/list" }), fail);
    onMessage((m) => {
      if (m.id === 2) {
        if (m.error) return fail(new Error(String(m.error.message ?? "tools/list failed")));
        done((m.result?.tools ?? []) as McpTool[]);
      }
    });
  });
}

export async function callConnectorTool(c: Connector, tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<ToolCallResult> {
  if (c.url) {
    const s = await openHttpSession(c, timeoutMs);
    const r = await s.request("tools/call", { name: tool, arguments: args });
    const content = Array.isArray(r?.content) ? r.content : [];
    const text = content.map((part: any) => (typeof part?.text === "string" ? part.text : JSON.stringify(part))).join("\n");
    return { text: text || "(no output)", isError: !!r?.isError };
  }
  return callStdioTool(c, tool, args, timeoutMs);
}

function callStdioTool(c: Connector, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolCallResult> {
  return withConnector<ToolCallResult>(c, timeoutMs, (send, onMessage, done, fail) => {
    initialize(send, onMessage, () => send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }), fail);
    onMessage((m) => {
      if (m.id === 2) {
        if (m.error) return fail(new Error(String(m.error.message ?? `tool "${tool}" failed`)));
        const content = Array.isArray(m.result?.content) ? m.result.content : [];
        const text = content.map((part: any) => (typeof part?.text === "string" ? part.text : JSON.stringify(part))).join("\n");
        done({ text: text || "(no output)", isError: !!m.result?.isError });
      }
    });
  });
}
