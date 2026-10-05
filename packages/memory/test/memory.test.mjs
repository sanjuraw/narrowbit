import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("branching a conversation", () => {
  test("a branch is the log before the chosen message, without the provider session or the cost, plus its evidence", () => {
    const root = project();
    try {
      const p = api.memoryPaths(root);
      const t = "rt-orig";
      const first = api.appendEvent(p, t, { actor: "user", type: "decision", summary: "task received", meta: { goal: "find the greeting" } });
      api.appendEvent(p, t, { actor: "model", type: "model_call", summary: "step 0", tokens: { model: "m", role: "execution", inputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 5, costUsd: 0.01 }, meta: { sessionId: "provider-session-1", sessionCost: 0.01, contextTokens: 900 } });
      const handle = api.writeEvidence(p, t, "file", "the whole file\n", "the whole file");
      api.appendEvent(p, t, { actor: "system", type: "tool_result", summary: "read a.txt", evidenceRef: handle.id });
      api.appendEvent(p, t, { actor: "model", type: "decision", summary: "done: it is in a.txt", meta: {} });
      const second = api.appendEvent(p, t, { actor: "user", type: "decision", summary: "follow-up", meta: { followUp: "which line?" } });
      api.appendEvent(p, t, { actor: "model", type: "decision", summary: "done: line 3", meta: {} });

      const r = api.forkTask(p, t, second.id);
      assert.ok(r.taskId && r.taskId !== t, JSON.stringify(r));
      const copy = api.readEvents(p, r.taskId);
      assert.equal(copy.length, 5, "four events from before the message, plus the branch marker");
      assert.deepEqual(copy.slice(0, 4).map((e) => e.id), api.readEvents(p, t).slice(0, 4).map((e) => e.id), "same events, same order");
      assert.ok(copy.every((e) => e.taskId === r.taskId));
      assert.ok(!copy.some((e) => e.meta?.sessionId || e.meta?.sessionCost || e.tokens), "no provider session and no spend carried over");
      assert.ok(copy.at(-1).meta.forkOf === t, "the branch says where it came from");
      assert.equal(api.readEvidence(p, r.taskId, handle.id)?.includes("the whole file"), true, "evidence the log points at came along");
      assert.equal(api.readEvents(p, t).length, 6, "the original is untouched");

      assert.match(api.forkTask(p, t, first.id).error, /first message/);
      assert.match(api.forkTask(p, t, "nope").error, /isn't in this conversation/);
      assert.match(api.forkTask(p, t, api.readEvents(p, t)[3].id).error, /one of your messages/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("notes that a cloned repository ships inside .narrowbit/memory", () => {
  const dirs = [];
  const tmp = () => { const d = realpathSync(project()); dirs.push(d); return d; };
  const cleanup = () => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); };

  test("an old-format notes file can't choose where its notes are written, or which folder", () => {
    const root = tmp(), outside = tmp();
    try {
      const p = api.memoryPaths(root);
      mkdirSync(p.memory, { recursive: true });
      const target = join(outside, "target.txt");
      writeFileSync(target, "ORIGINAL CONTENT\n");
      writeFileSync(join(p.memory, "facts.json"), JSON.stringify([
        { id: "fac-1", type: "fact", text: "echo OWNED", date: "2026-01-01T00:00:00Z", status: "active", file: target },
        { id: "fac-2", type: "../../escape", text: "wrong folder", date: "2026-01-01T00:00:00Z", status: "active" },
      ]));
      const m = api.openMemory(p);
      assert.equal(readFileSync(target, "utf8"), "ORIGINAL CONTENT\n", "the file the entry named was not overwritten");
      assert.ok(!existsSync(join(root, "escapes")) && !existsSync(join(root, "escape")), "an entry can't pick a folder outside the notes");
      const migrated = m.load().find((e) => e.text === "echo OWNED");
      assert.ok(migrated, "the valid entry is still migrated");
      assert.ok(migrated.file.startsWith(p.memory + "/"), "to a path the notes folder chose itself");
    } finally { cleanup(); }
  });

  test("a note that is a symlink is never read, and a symlinked notes folder is not followed or written through", () => {
    const root = tmp(), outside = tmp();
    try {
      const p = api.memoryPaths(root);
      mkdirSync(join(p.memory, "facts"), { recursive: true });
      writeFileSync(join(outside, "secret.txt"), "aws_secret_access_key = CANARY-OUTSIDE-FILE-8812\n");
      symlinkSync(join(outside, "secret.txt"), join(p.memory, "facts", "leak.md"));
      mkdirSync(join(outside, "vault"));
      writeFileSync(join(outside, "vault", "diary.md"), "# Diary\nCANARY-OUTSIDE-DIR-5521\n");
      symlinkSync(join(outside, "vault"), join(p.memory, "decisions"));
      const texts = () => JSON.stringify(api.openMemory(p).load());
      assert.doesNotMatch(texts(), /CANARY-OUTSIDE/, "nothing outside the project is read through a link");

      // The whole notes folder pointing elsewhere.
      const root2 = tmp();
      const p2 = api.memoryPaths(root2);
      mkdirSync(join(root2, ".narrowbit"), { recursive: true });
      symlinkSync(join(outside, "vault"), p2.memory);
      const m2 = api.openMemory(p2);
      assert.doesNotMatch(JSON.stringify(m2.load()), /CANARY-OUTSIDE/, "a symlinked notes folder isn't read");
      const before = readdirSync(join(outside, "vault")).sort();
      try { m2.add({ type: "fact", text: "must not land outside" }); } catch { /* refusing is fine */ }
      assert.deepEqual(readdirSync(join(outside, "vault")).sort(), before, "and nothing is written through it");
    } finally { cleanup(); }
  });

  test("a folder the user listed as extra notes may still hold links: they chose that folder", () => {
    const root = tmp(), vault = tmp(), elsewhere = tmp();
    try {
      writeFileSync(join(elsewhere, "linked.md"), "# Linked\nVAULT-LINK-OK\n");
      symlinkSync(join(elsewhere, "linked.md"), join(vault, "linked.md"));
      const p = { ...api.memoryPaths(root), extraDirs: [vault] };
      assert.match(JSON.stringify(api.openMemory(p).load()), /VAULT-LINK-OK/);
    } finally { cleanup(); }
  });
});

describe("writes never follow a link out of the project", () => {
  const dirs = [];
  const tmp = () => { const d = realpathSync(project()); dirs.push(d); return d; };
  const cleanup = () => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); };

  test("a notes sub-folder that is a symlink is refused, and a link squatting on a note's file name isn't written through", () => {
    const root = tmp(), outside = tmp(), scratch = tmp();
    try {
      const p = api.memoryPaths(root);
      mkdirSync(p.memory, { recursive: true });
      symlinkSync(outside, join(p.memory, "facts"));
      assert.throws(() => api.openMemory(p).add({ type: "fact", text: "must not land outside" }));
      assert.deepEqual(readdirSync(outside), [], "nothing was created through the linked folder");

      // The file names a note will get are predictable; a link on each must not be followed.
      const p2 = api.memoryPaths(tmp());
      const learned = api.openMemory(p2).add({ type: "fact", text: "same words" }).file;
      const primary = learned.split("/").pop();
      const root3 = tmp();
      const p3 = api.memoryPaths(root3);
      mkdirSync(join(p3.memory, "facts"), { recursive: true });
      const victim = join(outside, "victim.txt");
      writeFileSync(victim, "VICTIM ORIGINAL\n");
      writeFileSync(join(p3.memory, "facts.json"), JSON.stringify([{ id: "fac-evil", type: "fact", text: "same words", date: "2026-01-01T00:00:00Z", status: "active" }]));
      symlinkSync(victim, join(p3.memory, "facts", primary));
      symlinkSync(victim, join(p3.memory, "facts", primary.replace(/\.md$/, "-evil.md")));
      api.openMemory(p3);
      assert.equal(readFileSync(victim, "utf8"), "VICTIM ORIGINAL\n", "the file behind the links was not overwritten");
    } finally { cleanup(); }
  });

  test("a runtime folder (or task folder) that is a symlink gets no events or evidence, and a linked events file is not read", () => {
    const root = tmp(), outside = tmp();
    try {
      const p = api.memoryPaths(root);
      mkdirSync(join(root, ".narrowbit"), { recursive: true });
      symlinkSync(outside, p.runtime);
      assert.throws(() => api.appendEvent(p, "rt-x", { actor: "user", type: "decision", summary: "WRITTEN-THROUGH-LINK" }));
      assert.throws(() => api.writeEvidence(p, "rt-x", "other", "WRITTEN-THROUGH-LINK", "s"));
      assert.deepEqual(readdirSync(outside), [], "nothing was created through the linked folder");

      const root2 = tmp(), elsewhere = tmp();
      const p2 = api.memoryPaths(root2);
      mkdirSync(join(p2.runtime, "rt-y"), { recursive: true });
      writeFileSync(join(elsewhere, "log.jsonl"), JSON.stringify({ actor: "user", type: "decision", summary: "FORGED-FROM-OUTSIDE", id: "e1", taskId: "rt-y", at: "2026-01-01T00:00:00Z" }) + "\n");
      symlinkSync(join(elsewhere, "log.jsonl"), join(p2.runtime, "rt-y", "events.jsonl"));
      assert.deepEqual(api.readEvents(p2, "rt-y"), [], "a linked log is not history");
      assert.throws(() => api.appendEvent(p2, "rt-y", { actor: "user", type: "decision", summary: "must not append through the link" }));
      assert.doesNotMatch(readFileSync(join(elsewhere, "log.jsonl"), "utf8"), /must not append/);
    } finally { cleanup(); }
  });

  test("a task id that isn't a plain name is refused", () => {
    const root = tmp();
    try {
      const p = api.memoryPaths(root);
      assert.throws(() => api.appendEvent(p, "../../escape", { actor: "user", type: "decision", summary: "x" }), /task id/);
      assert.throws(() => api.taskDir(p, "a/b"), /task id/);
    } finally { cleanup(); }
  });
});

describe("the automatic task note carries what is expensive to re-derive", () => {
  test("it names the exact change and the command that passed", () => {
    const root = project();
    try {
      const p = api.memoryPaths(root);
      api.ensureMemoryDirs(p);
      api.appendEvent(p, "rt-n", { actor: "model", type: "decision", summary: "goal", meta: { goal: "fix the accept header parser" } });
      api.appendEvent(p, "rt-n", { actor: "system", type: "edit", summary: "edited", meta: { path: "src/accept.ts", old: "split(',')", new: "split(/,(?=[^;]*)/)" } });
      api.appendEvent(p, "rt-n", { actor: "system", type: "command", summary: "ok", meta: { command: "npm test -- accept", exit: 1 } });
      api.appendEvent(p, "rt-n", { actor: "system", type: "command", summary: "ok", meta: { command: "npm test -- accept.test", exit: 0 } });
      api.appendEvent(p, "rt-n", { actor: "model", type: "decision", summary: "done: the parser split on commas inside quoted parameters; now it splits only at top level" });
      const n = api.recordTaskNote(p, "rt-n");
      assert.match(n.text, /Change: src\/accept\.ts: `split\(','\)` -> `split\(\/,\(\?=\[\^;\]\*\)\/\)`/);
      assert.match(n.text, /Passing check: npm test -- accept\.test\./);
      assert.doesNotMatch(n.text, /Passing check: npm test -- accept\.$/m);
      api.appendEvent(p, "rt-n", { actor: "system", type: "command", summary: "ok", meta: { command: "cat package.json", exit: 0 } });
      assert.match(api.recordTaskNote(p, "rt-n").text, /Passing check: npm test -- accept\.test\./, "a command that is not a check (cat) is never reported as one");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("migration and set-up never follow a link out of the project", () => {
  test("a legacy facts.json that is a symlink to a file outside is not imported", () => {
    const root = project(), outside = project();
    try {
      const p = api.memoryPaths(root);
      mkdirSync(p.memory, { recursive: true });
      writeFileSync(join(outside, "private.json"), JSON.stringify([{ id: "x1", type: "fact", text: "PRIVATE-OUTSIDE-NOTE" }]));
      symlinkSync(join(outside, "private.json"), join(p.memory, "facts.json"));
      const all = api.openMemory(p).load();
      assert.ok(!all.some((e) => /PRIVATE-OUTSIDE-NOTE/.test(e.text)), "nothing from the linked file became a note");
      assert.ok(!existsSync(join(p.memory, "facts.json.migrated")), "and it was not renamed away either");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  test("a dangling .gitignore symlink in .narrowbit/ does not make set-up create a file elsewhere", () => {
    const root = project(), outside = project();
    try {
      const p = api.memoryPaths(root);
      mkdirSync(join(root, ".narrowbit"), { recursive: true });
      const target = join(outside, "created-by-init");
      symlinkSync(target, join(root, ".narrowbit", ".gitignore"));
      api.ensureMemoryDirs(p);
      assert.ok(!existsSync(target), "the link's target was not created");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
});

describe("the automatic task note does not imply an edit was checked when it wasn't", () => {
  test("a check that passed before the last edit is not reported as passing", () => {
    const root = project();
    try {
      const p = api.memoryPaths(root);
      api.ensureMemoryDirs(p);
      const ev = (type, summary, meta) => api.appendEvent(p, "rt-u", { actor: "system", type, summary, meta });
      ev("decision", "goal", { goal: "fix the parser" });
      ev("edit", "e1", { path: "src/a.ts", old: "a", new: "b" });
      ev("command", "ok", { command: "npm test", exit: 0 });
      ev("edit", "e2", { path: "src/a.ts", old: "b", new: "c" });
      api.appendEvent(p, "rt-u", { actor: "model", type: "decision", summary: "done: changed the parser to handle quoted values properly" });
      const t = api.recordTaskNote(p, "rt-u").text;
      assert.doesNotMatch(t, /Passing check/);
      assert.match(t, /Not verified after the last edit/);
      ev("command", "ok", { command: "npm test", exit: 0 });
      const t2 = api.recordTaskNote(p, "rt-u").text;
      assert.match(t2, /Passing check: npm test\./);
      assert.doesNotMatch(t2, /Not verified/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
