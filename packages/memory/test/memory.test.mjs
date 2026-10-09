import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("set-up never writes through a linked .narrowbit/", () => {
  test("with .narrowbit linked to a folder outside, ensureMemoryDirs creates nothing there", () => {
    const root = project(), outside = project();
    try {
      symlinkSync(outside, join(root, ".narrowbit"));
      api.ensureMemoryDirs(api.memoryPaths(root));
      assert.deepEqual(readdirSync(outside), [], "nothing was created in the linked folder");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
});

describe("the saved verification status is the latest result, failures included", () => {
  test("edit, passing check, then a failing check is not 'verified'", () => {
    const root = project();
    try {
      const p = api.memoryPaths(root);
      api.ensureMemoryDirs(p);
      const ev = (type, summary, meta) => api.appendEvent(p, "rt-f", { actor: "system", type, summary, meta });
      ev("decision", "goal", { goal: "fix it" });
      ev("edit", "e", { path: "src/a.ts", old: "a", new: "b" });
      ev("verify", "VERIFICATION PASSED", { ok: true });
      ev("command", "FAILED", { command: "npm test", exit: 1 });
      api.appendEvent(p, "rt-f", { actor: "model", type: "decision", summary: "done: changed the thing in a way that matters here" });
      const t = api.recordTaskNote(p, "rt-f").text;
      assert.doesNotMatch(t, /Verified after|Passing check/);
      assert.match(t, /Last check failed after the last edit/);
      ev("verify", "VERIFICATION FAILED", { ok: false });
      assert.match(api.recordTaskNote(p, "rt-f").text, /Last check failed/);
      ev("verify", "VERIFICATION PASSED", { ok: true });
      assert.match(api.recordTaskNote(p, "rt-f").text, /Verified after the last edit/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("hard links, a notes folder replaced later, and migration backups", () => {
  test("an event log or a note that is also another file is neither appended to, rewritten nor read", () => {
    const root = project(), outside = project();
    try {
      const p = api.memoryPaths(root);
      api.ensureMemoryDirs(p);
      api.appendEvent(p, "rt-h", { actor: "user", type: "decision", summary: "first" });
      const log = join(p.runtime, "rt-h", "events.jsonl");
      const logTwin = join(outside, "log-twin");
      linkSync(log, logTwin);
      const before = readFileSync(logTwin, "utf8");
      assert.throws(() => api.appendEvent(p, "rt-h", { actor: "user", type: "decision", summary: "second" }), /hard link/);
      assert.equal(readFileSync(logTwin, "utf8"), before, "the other name was not appended to");
      assert.deepEqual(api.readEvents(p, "rt-h"), [], "and it is not read as this task's history");

      const mem = api.openMemory(p);
      const n = mem.add({ type: "fact", text: "the widget uses base 10", files: [] });
      const noteTwin = join(outside, "note-twin");
      linkSync(n.file, noteTwin);
      const noteBefore = readFileSync(noteTwin, "utf8");
      assert.equal(mem.setStatus(n.id, "resolved"), null, "a note that is also another file is not one of this project's notes");
      assert.equal(readFileSync(noteTwin, "utf8"), noteBefore, "resolving did not rewrite the other name");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  test("a notes folder swapped for a link after the store was opened is not followed", () => {
    const root = project(), outside = project();
    try {
      const p = api.memoryPaths(root);
      api.ensureMemoryDirs(p);
      const mem = api.openMemory(p);
      mem.add({ type: "fact", text: "made while the folder was real", files: [] });
      renameSync(p.memory, p.memory + ".real");
      symlinkSync(outside, p.memory);
      assert.throws(() => mem.add({ type: "fact", text: "must not land outside", files: [] }), /symlink/);
      assert.deepEqual(mem.load(), [], "and nothing is read through it");
      assert.deepEqual(readdirSync(outside), []);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  test("migrating an old notes file never replaces an earlier backup", () => {
    const root = project();
    try {
      const p = api.memoryPaths(root);
      mkdirSync(p.memory, { recursive: true });
      writeFileSync(join(p.memory, "facts.json.migrated"), "EARLIER BACKUP");
      writeFileSync(join(p.memory, "facts.json"), JSON.stringify([{ id: "fac-1", type: "fact", text: "a newer old-format note" }]));
      api.openMemory(p).load();
      assert.equal(readFileSync(join(p.memory, "facts.json.migrated"), "utf8"), "EARLIER BACKUP");
      assert.ok(existsSync(join(p.memory, "facts.json.migrated-2")), "the new backup took the next free name");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("a note's file fingerprints are never taken through a link", () => {
  test("a file under a linked folder gets no hash", () => {
    const root = project(), outside = project();
    try {
      const p = api.memoryPaths(root);
      api.ensureMemoryDirs(p);
      writeFileSync(join(outside, "a.ts"), "export const outside = 1;\n");
      writeFileSync(join(root, "real.ts"), "export const real = 1;\n");
      symlinkSync(outside, join(root, "linked"));
      const n = api.openMemory(p).add({ type: "fact", text: "about two files", files: ["linked/a.ts", "real.ts"] });
      const hashed = Object.keys(n.fileHashes ?? {}).length ? Object.keys(n.fileHashes) : (n.fileHashes ?? []).map((h) => h.file ?? h.path ?? h[0]);
      assert.ok(JSON.stringify(n.fileHashes).includes("real.ts"), "the real file is fingerprinted");
      assert.ok(!JSON.stringify(n.fileHashes).includes("linked/a.ts"), `the linked one is not (${JSON.stringify(hashed)})`);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
});

describe("secrets that are not token-shaped", () => {
  test("NAME=value lines with a secret-looking name are redacted; ordinary settings are not", () => {
    const out = api.redact("DB_PASSWORD=hunter2hunter2\nexport SESSION_SECRET=7f3a9c1e5b8d2f4a\nMAX_TOKENS=4096\nNEXT_PUBLIC_X=1\nconst password = 'in code';\nAPI_TOKEN=change-me");
    assert.match(out, /DB_PASSWORD=\[redacted value\]/);
    assert.match(out, /SESSION_SECRET=\[redacted value\]/);
    assert.match(out, /MAX_TOKENS=4096/, "a short number under a TOKEN-ish name stays");
    assert.match(out, /NEXT_PUBLIC_X=1/);
    assert.match(out, /const password = 'in code';/, "ordinary code is left alone");
    assert.doesNotMatch(out, /hunter2hunter2|7f3a9c1e5b8d2f4a/);
    // a placeholder is only a hint to the commit check, never a "certain" credential
    assert.equal(api.findSecrets("API_TOKEN=change-me-please").some((f) => f.certain), false);
  });

  test("a private key is redacted line for line, so a window in the middle of it shows nothing", () => {
    const key = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMx", "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTK", "-----END RSA PRIVATE KEY-----"].join("\n");
    const text = `line one\n${key}\nline six`;
    const out = api.redactBlocksKeepingLines(text);
    assert.equal(out.split("\n").length, text.split("\n").length, "line numbers are unchanged");
    assert.doesNotMatch(out.split("\n").slice(2, 4).join("\n"), /MIIEow|VTLw7o/);
    assert.match(out, /^line one\n/); assert.match(out, /\nline six$/);
    assert.doesNotMatch(api.redactBlocksKeepingLines("-----BEGIN PRIVATE KEY-----\nABCDEF123456\n"), /ABCDEF123456/, "a cut-off block is redacted to the end");
  });
});

describe("twentieth audit, part 3: what the memory layer lets through", () => {
  const T = "sk-abcdefghijklmnopqrstuvwxyz123456";

  test("a secret assignment is redacted whether or not its name has a prefix, and short values count", () => {
    for (const line of ["PASSWORD=abcdefgh", "TOKEN=abcdefgh", "API_KEY=abcdefgh", "SECRET=abcdefgh", "DB_PASSWORD=abcdef", "DB_PASSWORD=[abcdefgh]"]) {
      assert.match(api.redact(line), /=\[redacted value\]$/, line);
    }
    // settings that only look like secrets stay readable
    for (const line of ["MAX_TOKENS=4096", "MAX_TOKENS=100000", "TOKEN=true", "API_KEY=[redacted value]", "NEXT_PUBLIC_X=1"]) assert.equal(api.redact(line), line, line);
  });

  test("a note on disk is scrubbed when it is loaded, whoever wrote it", () => {
    const root = project();
    const dir = join(root, ".narrowbit", "memory", "conventions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hand-written.md"), `---\ntype: convention\n---\n\nDeploy with token ${T} and the password is hunter2hunter2\n`);
    const mem = api.openMemory(api.memoryPaths(root));
    const loaded = mem.load();
    assert.equal(loaded.length, 1);
    assert.doesNotMatch(JSON.stringify(loaded), /abcdefghijklmnopqrstuvwxyz123456|hunter2hunter2/);
    assert.doesNotMatch(api.renderMemory(loaded[0]), /abcdefghijklmnopqrstuvwxyz123456|hunter2hunter2/);
  });

  test("event metadata is scrubbed on the way in and on the way out", () => {
    const root = project();
    const p = api.memoryPaths(root);
    const id = "rt-20261008-abcde";
    api.appendEvent(p, id, { actor: "model", type: "tool_call", summary: `read ${T}`, meta: { note: T, nested: { list: [T] }, n: 3 } });
    const raw = readFileSync(join(p.runtime, id, "events.jsonl"), "utf8");
    assert.doesNotMatch(raw, /abcdefghijklmnopqrstuvwxyz123456/);
    assert.equal(api.readEvents(p, id)[0].meta.n, 3, "other values are kept");
    // a log written before this scrubbing existed
    const old = join(p.runtime, id, "events.jsonl");
    writeFileSync(old, JSON.stringify({ id: "e1", taskId: id, at: new Date().toISOString(), actor: "model", type: "tool_call", summary: "x", meta: { note: T } }) + "\n");
    assert.doesNotMatch(JSON.stringify(api.readEvents(p, id)), /abcdefghijklmnopqrstuvwxyz123456/);
  });
});

describe("twentieth audit, second pass (Codex on 0ceeeff): labelled values, key blocks, metadata, damaged logs", () => {
  const T = "sk-abcdefghijklmnopqrstuvwxyz123456";

  test("labelled credentials are hidden in YAML, ini, .env and JSON styles, whatever their case, length or digits", () => {
    for (const [line, secret] of [
      ["password: OPAQUE_AUDIT_CREDENTIAL_8472", "OPAQUE_AUDIT"], ["TOKEN: OPAQUE_AUDIT_CREDENTIAL_8472", "OPAQUE_AUDIT"], ["db_password = hunter2hunter2", "hunter2"],
      ["PASSWORD=1234", "1234"], ['{"password":"1234","token":"abcd"}', "1234"], ['{"password":"1234","token":"abcd"}', "abcd"], ["client_secret: s3cr3tvalue", "s3cr3t"],
    ]) assert.ok(!api.redact(line).includes(secret), line);
    // code and settings that only look similar stay readable
    for (const line of ["password: string;", "  token: this.token,", "max_tokens: 4096", "MAX_TOKENS=4096", "TOKEN=true", "const password = getPassword();", "  apiKey: process.env.KEY,", "NEXT_PUBLIC_X=1"]) {
      assert.equal(api.redact(line), line, line);
    }
  });

  test("a password-labelled value is hidden whatever its type or length, while counts and types stay readable", () => {
    for (const [line, want] of [
      ['{"password":123456}', '{"password":[redacted value]}'], ['{"password":"ab"}', '{"password":"[redacted value]"}'], ["password: ab", "password: [redacted value]"],
      ["secret = x", "secret = [redacted value]"], ["PASSWORD=1", "PASSWORD=[redacted value]"], ['{"api_key":"abcd"}', '{"api_key":"[redacted value]"}'],
    ]) assert.equal(api.redact(line), want, line);
    for (const line of ['{"max_tokens":4096}', "password: string;", "token: this.token,", "max_tokens: 4096"]) assert.equal(api.redact(line), line, line);
  });

  test("a private key with no END line is hidden to the end, in text and in a saved note", () => {
    assert.doesNotMatch(api.redact("Key: -----BEGIN PRIVATE KEY-----\nPRIVATE_BODY_CANARY"), /PRIVATE_BODY_CANARY/);
    const root = project();
    const mem = api.openMemory(api.memoryPaths(root));
    const e = mem.add({ type: "fact", text: "copied by hand: -----BEGIN PRIVATE KEY-----\nPRIVATE_BODY_CANARY" });
    assert.doesNotMatch(JSON.stringify(mem.load()), /PRIVATE_BODY_CANARY/);
    assert.doesNotMatch(readFileSync(e.file, "utf8"), /PRIVATE_BODY_CANARY/);
  });

  test("metadata nested deeper than the scrubber looks is removed, not passed through", () => {
    const root = project(); const p = api.memoryPaths(root); const id = "rt-20261008-deepx";
    let deep = { a: T }; for (let i = 0; i < 12; i++) deep = { nested: deep };
    api.appendEvent(p, id, { actor: "model", type: "tool_call", summary: "x", meta: deep });
    assert.doesNotMatch(readFileSync(join(p.runtime, id, "events.jsonl"), "utf8"), /abcdefghijklmnopqrstuvwxyz123456/);
    assert.doesNotMatch(JSON.stringify(api.readEvents(p, id)), /abcdefghijklmnopqrstuvwxyz123456/);
  });

  test("one damaged line in an event log does not hide the rest of the history", () => {
    const root = project(); const p = api.memoryPaths(root); const id = "rt-20261008-badln";
    api.appendEvent(p, id, { actor: "model", type: "decision", summary: "first" });
    writeFileSync(join(p.runtime, id, "events.jsonl"), readFileSync(join(p.runtime, id, "events.jsonl"), "utf8") + '{"truncated":');
    api.appendEvent(p, id, { actor: "model", type: "decision", summary: "second" });
    assert.deepEqual(api.readEvents(p, id).map((e) => e.summary), ["first", "second"]);
  });
});

describe("twentieth audit, third pass (Codex on 7f48284): credential formats and code that only looks like one", () => {
  const C = "OPAQUE_CANARY_84267";
  test("credentials are hidden in XML, Dockerfile, compose, block scalars, escaped JSON keys, auth headers, Terraform, Kubernetes Secrets and PGP blocks", () => {
    for (const input of [
      `<password>${C}</password>`, `ENV PASSWORD=${C}`, `environment:\n  - PASSWORD=${C}`, `password: |\n  ${C}\n`, `{"pass\\u0077ord":"${C}"}`,
      `{"Authorization":"Bearer ${C}"}`, `Cookie: session=${C}`, `Authorization: Bearer ${C}`, `variable "password" { default = "${C}" }`,
      `apiVersion: v1\nkind: Secret\ndata:\n  db: ${Buffer.from(C).toString("base64")}`,
      `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${C}\n-----END PGP PRIVATE KEY BLOCK-----`,
    ]) {
      const out = api.redact(input);
      assert.ok(!out.includes(C) && !out.includes(Buffer.from(C).toString("base64")), input.split("\n")[0]);
    }
    assert.doesNotMatch(api.redactBlocksKeepingLines(`a\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n${C}\n-----END PGP PRIVATE KEY BLOCK-----\nb`), /OPAQUE/);
  });

  test("a call expression after a credential name is code and stays readable", () => {
    for (const line of ["password: validatePassword(input)", "password: getPass()", "token: this.token", "token: loadToken(config)"]) assert.equal(api.redact(line), line, line);
    // and a Secret's metadata is not its data
    assert.match(api.redact("kind: Secret\nmetadata:\n  name: db\ndata:\n  pw: aGVsbG8="), /name: db/);
  });
});

describe("twentieth audit, fourth pass (Codex on c661506): neighbouring formats, scoping, and the detector agreeing with the scrubber", () => {
  const C = "OPAQUE_CANARY_97531";
  const b64 = Buffer.from(C).toString("base64");

  test("connection strings, XML with attributes or on several lines, quoted and nested YAML, TOML blocks, Dockerfile forms, escaped keys, nested Kubernetes Secrets and short URL passwords are hidden", () => {
    for (const input of [
      `Server=db;User ID=u;Password=${C};Database=app`, `<password encoding="plain">${C}</password>`, `<password>\n${C}\n</password>`, `"password": |\n  ${C}`,
      `password:\n  value: ${C}`, `password: | # secret value\n  ${C}`, `{"Author\\u0069zation":"Bearer ${C}"}`, `password = """\n${C}\n"""`, `ENV PASSWORD ${C}`,
      `ENV A=one PASSWORD=${C}`, `db.pass\\u0077ord=${C}`, `items:\n  - kind: Secret\n    data:\n      db: ${b64}`, "postgres://user:ab@db/app",
    ]) {
      const out = api.redact(input);
      assert.ok(!out.includes(C) && !out.includes(b64) && !out.includes(":ab@"), input.split("\n")[0]);
    }
  });

  test("a block value is scoped by indentation (siblings and what follows stay readable), and a Secret's data is scoped to its own document", () => {
    const yaml = api.redact("auth:\n  password: |\n    secret\n  retries: 3\n  public: hello\nname: keep");
    assert.match(yaml, /retries: 3/); assert.match(yaml, /public: hello/); assert.match(yaml, /name: keep/); assert.doesNotMatch(yaml, /\bsecret$/m);
    assert.match(api.redact("password: |\n  x\n"), /password: \|/, "the block indicator is kept");
    const kube = api.redact("kind: Secret\n---\nkind: ConfigMap\ndata:\n  public: hello world");
    assert.match(kube, /public: hello world/);
    assert.match(api.redact("kind: Secret\ndata:\n  db: aGVsbG8=\n---\nkind: ConfigMap\ndata:\n  public: hi"), /public: hi/);
  });

  test("calls with a space before the parenthesis or type arguments are code and stay readable", () => {
    for (const line of ["password: validatePassword (input)", "password: factory<string>(input)", "secret: makeSecret<Options>(x)"]) assert.equal(api.redact(line), line, line);
  });

  test("findSecrets reports what redact hides, on the same lines", () => {
    for (const [text, line] of [[`variable "password" { default = "${C}" }`, 1], [`{"pass\\u0077ord":"${C}"}`, 1], ["kind: Secret\ndata:\n  db: aGVsbG8=", 3], [`a\npassword: |\n  ${C}`, 3]]) {
      const found = api.findSecrets(text);
      assert.ok(found.some((f) => f.line === line), `${JSON.stringify(text).slice(0, 40)} -> ${JSON.stringify(found)}`);
    }
  });
});

describe("own audit (2026-10-09): hostile text cannot make redaction slow", () => {
  const within = (ms, f) => { const t = performance.now(); f(); const took = performance.now() - t; assert.ok(took < ms, `took ${Math.round(took)} ms (limit ${ms})`); };

  test("a long run of spaces or tabs next to a credential-looking word is handled in well under a second (it took 93 s)", () => {
    const sp = " ".repeat(100000), tb = "\t".repeat(100000);
    for (const text of ["password" + sp + ":", "password" + sp + "=", sp + "password: x", tb + "password: x", '"password"' + sp + ":", "<password" + sp + ">", "authorization" + sp + ":", "ENV a=b" + sp, "ENV PASSWORD" + sp, "Server=x;" + "Password=a;".repeat(20000), "kind: Secret" + sp]) {
      within(3000, () => api.redact(text));
      within(3000, () => api.findSecrets(text));
    }
  });

  test("thousands of key markers with no end, and thousands of Terraform variables, stay linear", () => {
    within(2000, () => api.redact("-----BEGIN RSA PRIVATE KEY-----\n".repeat(30000)));
    within(2000, () => api.redactBlocksKeepingLines("-----BEGIN RSA PRIVATE KEY-----\n".repeat(30000)));
    within(2000, () => api.redact('variable "password" { default = '.repeat(8000)));
    assert.match(api.redact("a\n-----BEGIN RSA PRIVATE KEY-----\nBODY\n-----END RSA PRIVATE KEY-----\nb"), /^a\n\[REDACTED PRIVATE KEY\]\nb$/);
    assert.doesNotMatch(api.redact("x -----BEGIN PRIVATE KEY-----\nBODY_CANARY"), /BODY_CANARY/);
  });

  test("findSecrets on a big file with many matches does not slow down quadratically", () => {
    within(3000, () => assert.ok(api.findSecrets("password=abcdefgh\n".repeat(40000)).length >= 40000));
  });
});

describe("twentieth audit, fifth pass (Codex on 30671b0): JSON escapes and subtrees, nested XML, Kubernetes field order", () => {
  const C = "OPAQUE_NEW_CANARY";
  test("a JSON string with an escaped quote, a signed or decimal number, and a whole object or array under a credential key are hidden", () => {
    for (const input of [`{"password":"abc\\"${C}"}`, `{"password":-123.45}`, `{"password":1e5}`, `{"password":{"value":"${C}"}}`, `{"credentials":["${C}", 1234]}`, `{"Authorization":"Bearer a\\"${C}"}`]) {
      const out = api.redact(input);
      assert.ok(!out.includes(C) && !/-123\.45|1e5|1234/.test(out) && !/"abc\\"/.test(out), input);
      assert.ok(api.findSecrets(input).length > 0, `findSecrets: ${input}`);
    }
    const siblings = api.redact(`{"user":"keep","password":{"a":"x"},"retries":3}`);
    assert.match(siblings, /"user":"keep"/); assert.match(siblings, /"retries":3/);
    assert.equal(api.redact(`{"password":"abc\\"def"}`), `{"password":"[redacted value]"}`, "the whole string, escape included");
  });

  test("an XML element named for a credential that holds other elements hides the text inside them", () => {
    assert.doesNotMatch(api.redact(`<password><value>${C}</value></password>`), /OPAQUE/);
    assert.match(api.redact(`<config><name>keep</name><password><value>x1</value></password></config>`), /<name>keep<\/name>/);
  });

  test("a Kubernetes Secret's data is hidden whichever order the object's fields are written in, in lists too, and neighbours are untouched", () => {
    for (const input of [`items:\n  - data:\n      db: ${C}\n    kind: Secret`, `items:\n  - name: x\n    data:\n      db: ${C}\n    kind: Secret`, `data:\n  db: ${C}\nkind: Secret`, `items:\n  - kind: Secret\n    data:\n      db: ${C}\n  - data:\n      b: ${C}\n    kind: Secret`]) {
      assert.doesNotMatch(api.redact(input), /OPAQUE/, input.replace(/\n/g, "|"));
      assert.ok(api.findSecrets(input).length > 0, `findSecrets: ${input.replace(/\n/g, "|")}`);
    }
    assert.match(api.redact(`items:\n  - data:\n      db: ${C}\n    kind: Secret\n  - kind: ConfigMap\n    data:\n      pub: keepme`), /pub: keepme/);
  });
});

describe("twenty-ninth audit (Codex on 675c71b): long credential containers", () => {
  test("a JSON credentials object or an XML password element stays hidden however long it is, and one that never closes is hidden to the end", () => {
    const J = `{ "credentials": {\n"padding":"${"a".repeat(250000)}",\n"entry":"NESTED_JSON_CANARY"\n}}`;
    const X = `<password>\n<pad>${"a".repeat(9000)}</pad>\n<value>NESTED_XML_CANARY</value>\n</password>`;
    const open = `{ "credentials": {\n"padding":"${"a".repeat(250000)}",\n"entry":"OPEN_JSON_CANARY"\n`;
    const openX = `<password>\n<pad>x</pad>\n<value>OPEN_XML_CANARY</value>\n`;
    for (const [text, canary] of [[J, "NESTED_JSON_CANARY"], [X, "NESTED_XML_CANARY"], [open, "OPEN_JSON_CANARY"], [openX, "OPEN_XML_CANARY"]]) {
      assert.ok(!api.redact(text).includes(canary), canary);
      assert.ok(api.findSecrets(text).length > 0, `${canary} is also reported by the detector`);
      assert.equal(api.redact(text).split("\n").length, text.split("\n").length, "line count kept");
    }
    const t0 = Date.now();
    api.redact(`<password>` .repeat(2000) + "x".repeat(200000));
    assert.ok(Date.now() - t0 < 5000, "no blow-up on many unclosed elements");
  });
});
