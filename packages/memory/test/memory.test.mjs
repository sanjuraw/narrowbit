import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(PKG, "bin", "narrowbit-memory.js");
const api = await import(join(PKG, "dist", "index.js"));
const project = () => mkdtempSync(join(tmpdir(), "nbmem-"));

describe("the package stands on its own", () => {
  test("it imports nothing outside its own folder except node: modules", () => {
    const dir = join(PKG, "src");
    const bad = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
        const spec = m[1];
        if (!spec.startsWith("node:") && !spec.startsWith("./")) bad.push(`${f} imports ${spec}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test("the public surface offers save, recall, staleness, task notes and the hand-over summary", () => {
    for (const name of ["Memory", "openMemory", "memoryPaths", "ensureMemoryDirs", "renderMemory", "recordTaskNote", "proposeNotes", "digestWithMemory", "fold", "appendEvent", "project", "suggestNotes", "redact", "serveMemoryMcp", "callMemoryTool"]) {
      assert.equal(typeof api[name], "function", name);
    }
    for (const m of ["add", "relevant", "staleFilesOf", "setStatus", "load"]) assert.equal(typeof api.Memory.prototype[m], "function", m);
  });
});

describe("notes through the tool functions", () => {
  test("remember → recall → stale → resolve, with secrets scrubbed and the folder kept out of git", () => {
    const root = project();
    try {
      const p = api.memoryPaths(root);
      writeFileSync(join(root, "pay.ts"), "export const fee = 2;\n");
      const secret = "gh" + "p_" + "a".repeat(36);
      const saved = api.callMemoryTool(p, "memory_remember", { type: "decision", text: `Fees are flat, never percentage. token ${secret}`, files: ["pay.ts"] });
      assert.match(saved, /^recorded /);
      const noteFiles = readdirSync(join(p.memory, "decisions"));
      assert.ok(!readFileSync(join(p.memory, "decisions", noteFiles[0]), "utf8").includes(secret), "the secret never reached disk");
      assert.match(api.callMemoryTool(p, "memory_recall", { query: "how are fees charged" }), /Fees are flat/);
      assert.match(api.callMemoryTool(p, "memory_recall", { files: ["pay.ts"] }), /Fees are flat/, "found by file too");
      writeFileSync(join(root, "pay.ts"), "export const fee = 3;\n");
      assert.match(api.callMemoryTool(p, "memory_recall", { query: "fees" }), /may be out of date: pay\.ts/);
      const id = /recorded (\S+)/.exec(saved)[1];
      assert.match(api.callMemoryTool(p, "memory_resolve", { id }), /resolved/);
      assert.equal(api.callMemoryTool(p, "memory_recall", { query: "fees" }), "no matching memory");
      assert.equal(readFileSync(join(root, ".narrowbit", ".gitignore"), "utf8"), "*\n", "notes stay out of git");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("the MCP server", () => {
  test("speaks MCP over stdio: handshake, tool list, remember and recall", async () => {
    const root = project();
    const child = spawn(process.execPath, [BIN, "serve", "--root", root], { stdio: ["pipe", "pipe", "inherit"] });
    const lines = [];
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const rpc = async (id, method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      for (let i = 0; i < 100; i++) { const hit = lines.find((l) => l.id === id); if (hit) return hit; await new Promise((r) => setTimeout(r, 50)); }
      throw new Error("no reply to " + method);
    };
    try {
      const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      assert.equal(init.result.serverInfo.name, "narrowbit-memory");
      const tools = await rpc(2, "tools/list", {});
      assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), ["memory_list", "memory_recall", "memory_remember", "memory_resolve"]);
      const rem = await rpc(3, "tools/call", { name: "memory_remember", arguments: { type: "failure", text: "Tried a global lock; it deadlocked the queue", attempt: "global lock", result: "deadlock" } });
      assert.match(rem.result.content[0].text, /^recorded /);
      const rec = await rpc(4, "tools/call", { name: "memory_recall", arguments: { query: "queue lock" } });
      assert.match(rec.result.content[0].text, /FAILED APPROACH[\s\S]*global lock/);
      const bad = await rpc(5, "tools/call", { name: "nope", arguments: {} });
      assert.equal(bad.result.isError, true);
    } finally { child.stdin.end(); child.kill(); rmSync(root, { recursive: true, force: true }); }
  });

  test("the command line can save, list and recall without a server", () => {
    const root = project();
    try {
      const run = (...a) => spawnSync(process.execPath, [BIN, ...a, "--root", root], { encoding: "utf8" });
      assert.match(run("remember", "constraint", "Never", "call", "the", "payments", "API", "from", "tests").stdout, /^recorded /);
      assert.match(run("list").stdout, /CONSTRAINT[\s\S]*payments API/);
      assert.match(run("recall", "payments").stdout, /payments API/);
      assert.equal(run("bogus").status, 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
