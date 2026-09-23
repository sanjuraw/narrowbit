import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixture } from "./fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "narrowbit.js");
const dist = (m) => import(join(here, "..", "dist", m));

const { parseSource } = await dist("parser.js");
const { IgnoreMatcher } = await dist("files.js");
const { compressOutput } = await dist("compress.js");
const { redact } = await dist("redact.js");
const { paths, ensureDirs, loadConfig } = await dist("config.js");
const { Store } = await dist("store.js");
const { indexRepo } = await dist("indexer.js");
const { buildPackage } = await dist("package.js");
const { parseTask } = await dist("taskparse.js");
const { Memory, toMarkdown, fromMarkdown } = await dist("memory.js");
const { refsText, symbolText, expandTask, grepText } = await dist("query.js");
const { parseStream } = await dist("bench.js");
const { termsOf } = await dist("terms.js");
const { appendEvent, readEvents, fold } = await dist("events.js");
const { writeEvidence, readEvidence } = await dist("evidence.js");
const { project } = await dist("context.js");
const { parseDecision, capSummary, safeAbsPath } = await dist("runtime.js");
const { resolveSelection, DEFAULT_TIERS } = await dist("providers/models.js");

const nb = (cwd, ...args) => execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

describe("parser", () => {
  test("extracts symbols, methods, routes, tests and imports", () => {
    const src = `
import { a as bee, c } from "./x";
import * as ns from "../y";
import type { T } from "./types";
export { z } from "./z";
const r = require("./legacy");
/** Does the thing. */
export async function doThing(x: number): Promise<number> { return bee(x) + c; }
export const arrow = (s: string) => s.trim();
export class Svc { run() { return doThing(1); } private helper = () => 2; }
interface I { x: number }
app.post("/webhooks/pay", handler);
describe("suite", () => { it("works", () => {}); });
const lazy = await import("./lazy");
`;
    const pf = parseSource("src/f.ts", src);
    const q = pf.symbols.map((s) => `${s.kind}:${s.qualified}`);
    for (const e of ["function:doThing", "function:arrow", "class:Svc", "method:Svc.run", "method:Svc.helper", "interface:I", "route:POST /webhooks/pay", "suite:suite", "test:suite > works"])
      assert.ok(q.includes(e), `missing ${e} in ${q.join(", ")}`);
    const doThing = pf.symbols.find((s) => s.name === "doThing");
    assert.equal(doThing.doc, "Does the thing.");
    assert.match(doThing.signature, /^export async function doThing\(x: number\): Promise<number>$/);
    assert.ok(doThing.refs.includes("bee"));
    const specs = pf.imports.map((i) => `${i.kind}:${i.spec}`);
    for (const e of ["import:./x", "import:../y", "import:./types", "reexport:./z", "require:./legacy", "dynamic:./lazy"]) assert.ok(specs.includes(e), `missing ${e}`);
    assert.deepEqual(pf.imports[0].bindings, [
      { imported: "a", local: "bee" },
      { imported: "c", local: "c" },
    ]);
    assert.equal(pf.imports.find((i) => i.spec === "./types").typeOnly, true);
  });

  test("identifier splitting and stemming", () => {
    const t = termsOf("verifyPaymentSignature HTTPServer user_sessions");
    for (const e of ["verify", "payment", "signature", "verifypaymentsignature", "http", "server", "user", "session"]) assert.ok(t.includes(e), `missing ${e}`);
  });
});

describe("ignore + redaction", () => {
  test("gitignore-style matcher", () => {
    const m = new IgnoreMatcher("node_modules/\n*.pem\n/build\n.env.*\n!keep.pem\nsecret/**/x.ts");
    assert.ok(m.ignores("node_modules/a/b.js"));
    assert.ok(m.ignores("pkg/node_modules/a.js"));
    assert.ok(m.ignores("certs/a.pem"));
    assert.ok(!m.ignores("keep.pem"));
    assert.ok(m.ignores("build/out.js"));
    assert.ok(!m.ignores("src/build.ts"));
    assert.ok(m.ignores(".env.local"));
    assert.ok(m.ignores("secret/a/b/x.ts"));
    assert.ok(!m.ignores("src/app.ts"));
  });

  test("redacts common secrets", () => {
    const s = redact(`const apiKey = "abcd1234efgh5678";\nAKIAABCDEFGHIJKLMNOP\npostgres://user:hunter22@db/x\nconst k = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";\nconst label = "not a secret";`);
    assert.ok(!s.includes("abcd1234efgh5678"));
    assert.ok(!s.includes("AKIAABCDEFGHIJKLMNOP"));
    assert.ok(!s.includes("hunter22"));
    assert.ok(!s.includes("sk-ant-abcdefghijklmnopqrstuvwxyz0123"));
    assert.ok(s.includes("not a secret"));
  });
});

describe("compression", () => {
  test("vitest-style output keeps summary + failures, drops passing noise", () => {
    const passing = Array.from({ length: 400 }, (_, i) => ` ✓ tests/mod${i}.test.ts > case ${i} 3ms`).join("\n");
    const raw = `\x1b[32m RUN  v2.0.5 /repo\x1b[0m
${passing}
 FAIL  tests/payments/verify.test.ts > verifyPaymentSignature > accepts a valid signature
AssertionError: expected false to be true
 - Expected: true
 + Received: false
    at /repo/tests/payments/verify.test.ts:9:52
    at file:///repo/node_modules/vitest/dist/runner.js:10:1

 Test Files  1 failed | 40 passed (41)
      Tests  1 failed | 400 passed (401)`;
    const c = compressOutput(raw, 1);
    assert.equal(c.kind, "tests");
    assert.match(c.text, /Tests\s+1 failed \| 400 passed/);
    assert.match(c.text, /AssertionError: expected false to be true/);
    assert.match(c.text, /verify\.test\.ts:9:52/);
    assert.ok(!c.text.includes("node_modules"));
    assert.ok(c.text.split("\n").length < 20, c.text);
  });

  test("tsc errors grouped by file", () => {
    const raw = `src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/a.ts(9,1): error TS2304: Cannot find name 'foo'.
src/b.ts:4:10 - error TS7006: Parameter 'x' implicitly has an 'any' type.
Found 3 errors in 2 files.`;
    const c = compressOutput(raw, 2);
    assert.equal(c.kind, "tsc");
    assert.equal(c.errorCount, 3);
    assert.match(c.text, /^3 type error\(s\) in 2 file\(s\)/);
    assert.match(c.text, /L9 TS2304: Cannot find name 'foo'/);
  });

  test("git diff is condensed; fail-safe never returns something larger than the input", () => {
    const diff = "diff --git a/src/a.ts b/src/a.ts\nindex 83db48f..bf2a3c1 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@ function foo() {\n context\n-old line\n+new line\n context";
    const c = compressOutput(diff.repeat(1), 0);
    assert.ok(c.text.length <= diff.length);
    assert.match(c.text, /FILE src\/a\.ts/);
    assert.ok(!c.text.includes("index 83db48f"));
    const tiny = "ok";
    assert.equal(compressOutput(tiny, 0).text, "ok");
  });

  test("successful noisy command collapses", () => {
    const raw = Array.from({ length: 3000 }, (_, i) => `compiled module ${i}`).join("\n") + "\nDone in 3.2s";
    const c = compressOutput(raw, 0);
    assert.ok(c.text.split("\n").length <= 40);
    assert.match(c.text, /Done in 3\.2s/);
  });
});

describe("stream-json parsing (benchmark)", () => {
  test("counts tools, reads and usage once per message", () => {
    const lines = [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Read", input: { file_path: "/r/a.ts" } }], usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 50 } } },
      { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Grep", input: {} }], usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 50 } } },
      { type: "assistant", message: { id: "m2", content: [{ type: "tool_use", name: "Read", input: { file_path: "/r/a.ts" } }], usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 20 } } },
      { type: "result", subtype: "success", is_error: false, num_turns: 3, duration_ms: 1234, total_cost_usd: 0.05 },
    ].map((l) => JSON.stringify(l)).join("\n");
    const s = parseStream(lines);
    assert.equal(s.toolCalls.Read, 2);
    assert.equal(s.toolCalls.Grep, 1);
    assert.equal(s.filesRead, 1);
    assert.equal(s.usage.cacheCreate, 1000);
    assert.equal(s.usage.cacheRead, 1000);
    assert.equal(s.usage.input, 15);
    assert.equal(s.turns, 3);
    assert.equal(s.costUsd, 0.05);
    assert.equal(s.isError, false);
  });
});

describe("fixture repository", () => {
  let root, p, store, cfg;
  before(() => {
    root = makeFixture();
    p = paths(root);
    ensureDirs(p);
    cfg = loadConfig(p);
    store = new Store(p.db);
    indexRepo(p, store);
  });
  after(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("index excludes secrets and resolves imports incl. tsconfig paths", () => {
    assert.equal(store.fileByPath(".env"), undefined);
    const alias = store.get(
      "SELECT t.path FROM imports i JOIN files f ON f.id=i.file_id JOIN files t ON t.id=i.target_id WHERE f.path='src/server.ts' AND i.spec='@/auth/session'",
    );
    assert.equal(alias?.path, "src/auth/session.ts");
    const links = store.all("SELECT t.path test, s.path src FROM tests_map m JOIN files t ON t.id=m.test_id JOIN files s ON s.id=m.source_id");
    assert.ok(links.some((l) => l.test === "tests/payments/verify.test.ts" && l.src === "src/payments/verify.ts"));
    assert.ok(links.some((l) => l.test === "tests/auth/session.test.ts" && l.src === "src/auth/session.ts"));
  });

  test("incremental re-index only parses changed files", () => {
    const s1 = indexRepo(p, store);
    assert.equal(s1.parsed, 0);
    const f = join(root, "src/utils/time.ts");
    writeFileSync(f, readFileSync(f, "utf8") + "\nexport function tomorrowUtc(): number { return Date.now() + 86400000; }\n");
    const s2 = indexRepo(p, store);
    assert.equal(s2.parsed, 1);
    assert.ok(store.get("SELECT 1 x FROM symbols WHERE name='tomorrowUtc'"));
  });

  test("brief example: Razorpay task selects payment files, not unrelated features", () => {
    const b = buildPackage(store, p, cfg, "Fix Razorpay signature verification failing after payment callback");
    const top3 = b.ranking.files.slice(0, 3).map((f) => f.path);
    assert.ok(top3.includes("src/payments/verify.ts"), top3.join());
    assert.ok(top3.includes("src/payments/callback.ts"), top3.join());
    assert.ok(!b.ranking.files.slice(0, 8).some((f) => f.path.startsWith("src/features/")));
    assert.ok(b.record.tests.includes("tests/payments/verify.test.ts"));
    assert.match(b.text, /export function verifyPaymentSignature/);
    assert.ok(b.record.packageTokens < b.record.stats.repoCodeTokens / 5, "package should be a small fraction of the repo");
    assert.ok(!b.text.includes("super_secret_value"));
  });

  test("stack trace pins the failing function", () => {
    const b = buildPackage(store, p, cfg, "TypeError: session expired\n    at refreshSession (src/auth/session.ts:11:45)");
    assert.equal(b.ranking.files[0].path, "src/auth/session.ts");
    assert.equal(b.ranking.files[0].symbols[0].name, "refreshSession");
    assert.equal(b.record.confidence, "high");
  });

  test("vague symptom still reaches auth/session code", () => {
    const b = buildPackage(store, p, cfg, "users are logged out too early after the token refresh");
    const top4 = b.ranking.files.slice(0, 4).map((f) => f.path);
    assert.ok(top4.includes("src/auth/session.ts") || top4.includes("src/auth/token.ts"), top4.join());
  });

  test("memory: failed approaches surface for related tasks", () => {
    const m = new Memory(p);
    m.add({ type: "failure", text: "Increasing cookie TTL did not fix server-side session expiration", attempt: "raise cookie maxAge", result: "still expired", files: ["src/auth/session.ts"] });
    m.add({ type: "decision", text: "Webhook signature verification must use the raw request body", reason: "re-serialising JSON changes bytes" });
    const b = buildPackage(store, p, cfg, "session expires after refresh, fix expiration");
    assert.match(b.text, /FAILED APPROACH .*cookie TTL/);
    assert.ok(!b.text.includes("raw request body"), "unrelated decision should not be included");
  });

  test("memory is Obsidian-compatible Markdown; hand-written notes and external dirs are read", () => {
    const m = new Memory(p);
    const e = m.add({ type: "decision", text: "Store all timestamps in UTC", reason: "avoid regional drift: \"quoted\"", files: ["src/utils/time.ts"] });
    assert.match(e.file, /memory\/decisions\/store-all-timestamps-in-utc\.md$/);
    const md = readFileSync(e.file, "utf8");
    assert.match(md, /^---\nid: "dec-/);
    assert.match(md, /## Reason\navoid regional drift/);
    const back = fromMarkdown(md, { id: "x" });
    assert.equal(back.reason, 'avoid regional drift: "quoted"');
    assert.deepEqual(back.files, ["src/utils/time.ts"]);
    // A note written by hand in Obsidian: minimal frontmatter, type from folder.
    writeFileSync(join(p.memory, "constraints", "no-schema-changes.md"), "---\ntags: [db, payments]\n---\n# No schema changes\nDo not modify the database schema without a migration review.\n");
    const hand = m.load("constraint").find((x) => x.id === "no-schema-changes");
    assert.ok(hand, "hand-written note loaded");
    assert.deepEqual(hand.tags, ["db", "payments"]);
    assert.equal(hand.text, "Do not modify the database schema without a migration review.");
    assert.equal(m.setStatus(e.id, "superseded").status, "superseded");
    assert.match(readFileSync(e.file, "utf8"), /status: "superseded"/);
  });

  test("nb_grep tags matches with the enclosing symbol and skips ignored files", () => {
    const g = grepText(p, store, "markPaid");
    assert.match(g, /src\/payments\/service\.ts \(\d+ lines\)\n\s+L\d+ \[PaymentService\.markPaid\]/);
    assert.match(g, /src\/payments\/callback\.ts[\s\S]*\[handleWebhook\]/);
    assert.ok(!grepText(p, store, "super_secret_value").includes(".env"), "ignored files never appear");
    assert.match(grepText(p, store, "zzz-nothing-here"), /^no matches/);
  });

  test("symbol and refs lookups", () => {
    assert.match(symbolText(p, store, "PaymentService.retryPayment"), /async retryPayment\(orderId: string, attempts = 3\)/);
    const refs = refsText(store, "verifyPaymentSignature");
    assert.match(refs, /defined: src\/payments\/verify\.ts:6/);
    assert.match(refs, /src\/payments\/callback\.ts:\d+-\d+ function handleWebhook/);
    assert.match(refs, /verifyOrderSignature/);
  });

  test("expansion returns new material only", () => {
    const b = buildPackage(store, p, cfg, "Fix Razorpay signature verification failing after payment callback", { budget: 1200 });
    const e1 = expandTask(p, cfg, store, b.record, 1500);
    assert.ok(e1.given.length > 0);
    for (const g of e1.given) assert.ok(!b.record.given.includes(g), `re-delivered ${g}`);
  });

  test("CLI task/inspect/close and hook", () => {
    nb(root, "task", "Fix Razorpay signature verification failing after payment callback");
    const insp = nb(root, "inspect");
    assert.match(insp, /CONTEXT SELECTED/);
    assert.match(insp, /✓ src\/payments\/verify\.ts/);
    // Simulate the agent fixing the bug, then close: recall should be 100%.
    const f = join(root, "src/payments/callback.ts");
    writeFileSync(f, readFileSync(f, "utf8").replace("JSON.stringify(req.body)", 'req.rawBody ?? ""'));
    const closed = nb(root, "close", "--success");
    assert.match(closed, /selection recall 100%/);

    const hookOut = execFileSync(process.execPath, [BIN, "hook", "prompt"], {
      cwd: root,
      input: JSON.stringify({ session_id: "s1", prompt: "Why does refreshSession throw session expired for valid users?", hook_event_name: "UserPromptSubmit" }),
      encoding: "utf8",
    });
    const j = JSON.parse(hookOut);
    assert.equal(j.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(j.hookSpecificOutput.additionalContext, /refreshSession/);
    const general = execFileSync(process.execPath, [BIN, "hook", "prompt"], {
      cwd: root,
      input: JSON.stringify({ session_id: "s2", prompt: "how do I test this and see what it saves in tokens overall?" }),
      encoding: "utf8",
    });
    assert.equal(general.trim(), "", "general questions with no code anchor get no injection");
    const short = execFileSync(process.execPath, [BIN, "hook", "prompt"], { cwd: root, input: JSON.stringify({ session_id: "s1", prompt: "yes do it" }), encoding: "utf8" });
    assert.equal(short.trim(), "", "short follow-ups get no injection");
  });

  test("MCP server speaks JSON-RPC over stdio", async () => {
    const child = spawn(process.execPath, [BIN, "mcp", "--root", root], { stdio: ["pipe", "pipe", "pipe"] });
    const responses = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        responses.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nb_symbol", arguments: { name: "verifyPaymentSignature" } } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nb_run", arguments: { command: "node -e \"console.log('x\\n'.repeat(500)); process.exit(3)\"" } } });
    send({ jsonrpc: "2.0", id: 5, method: "nope" });
    const deadline = Date.now() + 15000;
    while (responses.length < 5 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    child.stdin.end();
    const byId = Object.fromEntries(responses.map((r) => [r.id, r]));
    assert.equal(byId[1].result.serverInfo.name, "narrowbit");
    assert.ok(byId[2].result.tools.some((t) => t.name === "nb_expand"));
    assert.match(byId[3].result.content[0].text, /createHmac\("sha256", secret\)/);
    assert.match(byId[4].result.content[0].text, /exit 3/);
    assert.ok(byId[4].result.content[0].text.split("\n").length < 45);
    assert.equal(byId[5].error.code, -32601);
  });
});

describe("owned-runtime ledger (events, evidence, context projection)", () => {
  let root, p, taskId;
  before(() => {
    root = makeFixture();
    p = paths(root);
    ensureDirs(p);
    taskId = "rt-test-task";
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("events append in order and fold deterministically from the same log", () => {
    appendEvent(p, taskId, { actor: "system", type: "decision", summary: "goal set", meta: { goal: "fix the webhook signature check" } });
    appendEvent(p, taskId, { actor: "model", type: "plan", summary: "plan drafted", meta: { steps: [{ text: "read verify()", status: "done" }, { text: "add HMAC check", status: "active" }] } });
    appendEvent(p, taskId, { actor: "model", type: "model_call", summary: "planning turn", tokens: { model: "claude-sonnet-5", role: "planning", inputTokens: 300, cacheCreationTokens: 200, cacheReadTokens: 0, outputTokens: 120, costUsd: 0.01 } });
    for (let i = 0; i < 10; i++) appendEvent(p, taskId, { actor: "system", type: "tool_call", summary: `nb_grep call ${i}`, tokens: { model: "claude-sonnet-5", role: "retrieval", inputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 40, outputTokens: 10, costUsd: 0.001 } });
    appendEvent(p, taskId, { actor: "system", type: "edit", summary: "edited payments/verify.ts", meta: { path: "src/payments/verify.ts" } });
    appendEvent(p, taskId, { actor: "system", type: "blocker", summary: "focused tests need a fixture secret" });
    appendEvent(p, taskId, { actor: "model", type: "decision", summary: "blocker resolved", meta: { resolvesBlocker: true } });
    appendEvent(p, taskId, { actor: "system", type: "verify", summary: "1 focused test passed", meta: { ok: true } });

    const events = readEvents(p, taskId);
    assert.equal(events.length, 17);
    assert.ok(new Set(events.map((e) => e.id)).size === events.length, "event ids are unique");

    const state1 = fold(taskId, events);
    const state2 = fold(taskId, readEvents(p, taskId));
    assert.deepEqual(state1, state2, "folding the same log twice must be deterministic");

    assert.equal(state1.goal, "fix the webhook signature check");
    assert.equal(state1.plan.length, 2);
    assert.equal(state1.lastVerify.ok, true);
    assert.equal(state1.blocker, null, "a later resolvesBlocker decision clears the blocker");
    assert.deepEqual(state1.filesTouched, ["src/payments/verify.ts"]);
    assert.ok(!state1.recent.some((e) => e.type === "model_call"), "model_call events never enter the recent-action window");
    assert.equal(state1.recent.length, 8, "recent window is capped at recentLimit");
    assert.equal(state1.ledgerByRole.planning.calls, 1);
    assert.equal(state1.ledgerByRole.planning.inputTokens, 300);
    assert.equal(state1.ledgerByRole.planning.cacheCreationTokens, 200);
    assert.equal(state1.ledgerByRole.retrieval.calls, 10);
    assert.equal(state1.ledgerByRole.retrieval.cacheReadTokens, 400, "fresh vs cached stays separable per role, not collapsed into one number");
    assert.ok(Math.abs(state1.ledgerByRole.retrieval.costUsd - 0.01) < 1e-9);
  });

  test("projection is bounded and never drops goal/plan/blocker/last-verify", () => {
    const state = fold(taskId, readEvents(p, taskId));
    const full = project(state, { budget: 10_000 });
    assert.match(full, /GOAL: fix the webhook signature check/);
    assert.match(full, /PLAN:/);
    assert.match(full, /LAST VERIFY: PASSED/);
    assert.match(full, /RECENT:/);

    const tight = project(state, { budget: 5 });
    assert.match(tight, /GOAL: fix the webhook signature check/, "goal survives even a tiny budget");
    assert.match(tight, /LAST VERIFY: PASSED/, "last verify survives even a tiny budget");
    assert.ok(tight.length < full.length, "a tight budget trims recent-action lines");
  });

  test("evidence is redacted, handle-addressed, and never re-enters context directly", () => {
    const secretish = "token = ghp_abcdefghijklmnopqrstuvwxyz012345\nsome file content here";
    const handle = writeEvidence(p, taskId, "file", secretish, "src/config.ts, 2 lines", "src/config.ts");
    assert.ok(handle.id);
    assert.equal(handle.kind, "file");
    assert.equal(handle.path, "src/config.ts");
    assert.ok(handle.tokens > 0);
    const back = readEvidence(p, taskId, handle.id);
    assert.doesNotMatch(back, /ghp_abcdefghijklmnopqrstuvwxyz012345/, "evidence on disk is redacted like every other emitted text");
    assert.throws(() => readEvidence(p, taskId, "does-not-exist"));
  });
});

describe("runtime loop helpers (no model calls — keeps npm test free of Claude quota)", () => {
  test("parseDecision accepts bare JSON and JSON wrapped in prose/fences, rejects garbage", () => {
    assert.deepEqual(parseDecision('{"action":"done","summary":"ok"}'), { action: "done", summary: "ok" });
    assert.deepEqual(parseDecision('sure, here:\n```json\n{"action":"read","path":"a.ts"}\n```'), { action: "read", path: "a.ts" });
    assert.equal(parseDecision("not json at all"), null);
    assert.equal(parseDecision('{"summary":"missing action field"}'), null);
  });

  test("capSummary passes short text through and truncates long text with a pointer to ask again", () => {
    assert.equal(capSummary("short"), "short");
    const long = "x".repeat(10_000);
    const capped = capSummary(long, 100);
    assert.ok(capped.length < long.length);
    assert.match(capped, /truncated/);
  });

  test("safeAbsPath refuses paths that escape the repo root", () => {
    const root = "/tmp/nb-safepath-test";
    const p = { root };
    assert.equal(safeAbsPath(p, "src/x.ts"), resolve(root, "src/x.ts"));
    assert.equal(safeAbsPath(p, "../../etc/passwd"), null);
    assert.equal(safeAbsPath(p, "/etc/passwd"), null);
    assert.equal(safeAbsPath(p, "."), null);
  });
});

describe("model selection (providers/models.ts)", () => {
  test("defaults per provider when nothing is saved or passed", () => {
    assert.deepEqual(resolveSelection(undefined), { provider: "claude", tiers: DEFAULT_TIERS.claude, effort: "medium" });
    assert.deepEqual(resolveSelection(undefined, { provider: "codex" }).tiers, { explore: "gpt-5.6-luna", execute: "gpt-5.6-terra", escalate: "gpt-5.6-sol" });
  });

  test("precedence: per-slot flag > --model > saved config > default", () => {
    const saved = { provider: "claude", effort: "high", models: { claude: { explore: "sonnet", escalate: "fable" } } };
    assert.deepEqual(resolveSelection(saved).tiers, { explore: "sonnet", execute: "sonnet", escalate: "fable" });
    assert.equal(resolveSelection(saved).effort, "high");
    assert.deepEqual(resolveSelection(saved, { model: "opus" }).tiers, { explore: "opus", execute: "opus", escalate: "opus" });
    assert.deepEqual(resolveSelection(saved, { model: "opus", explore: "haiku" }).tiers, { explore: "haiku", execute: "opus", escalate: "opus" });
    assert.equal(resolveSelection(saved, { effort: "low" }).effort, "low");
  });

  test("saved models are per provider, and switching provider doesn't leak them", () => {
    const saved = { provider: "codex", models: { claude: { explore: "sonnet" } } };
    assert.equal(resolveSelection(saved).provider, "codex");
    assert.equal(resolveSelection(saved).tiers.explore, "gpt-5.6-luna");
    assert.equal(resolveSelection(saved, { provider: "claude" }).tiers.explore, "sonnet");
  });

  test("unknown provider is an error, not a silent fallback", () => {
    assert.throws(() => resolveSelection({ provider: "gemini" }), /unknown provider/);
    assert.throws(() => resolveSelection(undefined, { provider: "gemini" }), /unknown provider/);
  });
});

test("task parser picks up locations, identifiers, errors", () => {
  const t = parseTask("TypeError: Cannot read properties of undefined\n  at PaymentService.retryPayment (src/payments/service.ts:14:20)\nfix `verifySignature()` in payments/verify");
  assert.deepEqual(t.locations[0], { path: "src/payments/service.ts", line: 14 });
  assert.ok(t.identifiers.includes("PaymentService.retryPayment") || t.identifiers.includes("retryPayment"));
  assert.ok(t.identifiers.includes("verifySignature"));
  assert.ok(t.paths.includes("payments/verify"));
  assert.ok(t.errors.length >= 1);
});

test("app server (ui.ts): refuses calls without the launch token or from a non-loopback Host", async () => {
  const { startUi } = await dist("ui.js");
  const root = makeFixture();
  let url;
  const server = startUi({ root, port: 0, onListening: (u) => (url = u) });
  await new Promise((r) => server.once("listening", r));
  try {
    const u = new URL(url);
    const token = u.searchParams.get("t");
    const api = `${u.origin}/api/state`;
    assert.equal((await fetch(api)).status, 401);
    assert.equal((await fetch(api, { headers: { "x-narrowbit-token": "wrong" } })).status, 401);
    const ok = await fetch(api, { headers: { "x-narrowbit-token": token } });
    assert.equal(ok.status, 200);
    // realpath: macOS tmp dirs live under /private, which git reports as the toplevel.
    assert.equal((await ok.json()).name, root.split("/").pop());
    // A page elsewhere reaching the port via DNS rebinding carries its own Host header.
    const rebind = await new Promise((resolve) => {
      import("node:http").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port: u.port, path: "/api/state", headers: { host: `evil.example:${u.port}`, "x-narrowbit-token": token } }, (res) => resolve(res.statusCode));
        req.end();
      });
    });
    assert.equal(rebind, 403);
    assert.equal((await fetch(`${u.origin}/api/run`, { method: "POST", body: "{}" })).status, 401);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
