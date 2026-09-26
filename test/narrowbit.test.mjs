import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixture } from "./fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "narrowbit.js");
const dist = (m) => import(join(here, "..", "dist", m));

const { parseSource } = await dist("parser.js");
const { IgnoreMatcher } = await dist("files.js");
const { compressOutput, groupSimilar, capOutput } = await dist("compress.js");
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
const { parseDecision, parseDecisions, capSummary, safeAbsPath } = await dist("runtime.js");
const { parseCodexStream } = await dist("providers/codex-cli.js");
const { parseClaudeAuth } = await dist("readiness.js");
const { classifyModelError, isPermanentModelError } = await dist("errors.js");
const { publicConnector } = await dist("connectors.js");
const { auditRepo } = await dist("audit.js");
const { listSkills, getSkill, saveSkill, removeSkill, renameSkill, slugify } = await dist("skills.js");
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
    const s = redact(`const apiKey = "abcd1234efgh5678";\nAKIAABCDEFGHIJKLMNOP\npostgres://user:hunter22@db/x\nconst k = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";\nconst label = "not a secret";`); // narrowbit-audit-ignore: deliberately fake fixtures
    assert.ok(!s.includes("abcd1234efgh5678"));
    assert.ok(!s.includes("AKIAABCDEFGHIJKLMNOP")); // narrowbit-audit-ignore: fake fixture
    assert.ok(!s.includes("hunter22"));
    assert.ok(!s.includes("sk-ant-abcdefghijklmnopqrstuvwxyz0123")); // narrowbit-audit-ignore: fake fixture
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

describe("skills (reusable task templates)", () => {
  let root, p;
  before(() => {
    root = makeFixture();
    p = paths(root);
    ensureDirs(p);
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("save, list, get, rename and remove round-trip through Markdown files on disk", () => {
    const mine = () => listSkills(p).filter((s) => !s.builtin).map((s) => s.name);
    assert.deepEqual(mine(), []);
    saveSkill(p, "Release notes", "How we write release notes", "1. Group by user impact.\n2. Link the PRs.\n3. Proofread.");
    saveSkill(p, "Deploy steps", "", "Tag, build, publish — one step at a time.");
    assert.deepEqual(mine(), ["Deploy steps", "Release notes"]);

    const rn = getSkill(p, "Release notes");
    assert.equal(rn.description, "How we write release notes");
    assert.match(rn.body, /Group by user impact/);
    assert.equal(rn.file, "release-notes.md");
    assert.equal(getSkill(p, "release NOTES").name, "Release notes", "lookup ignores case");

    // Saving again by the same name overwrites the same file rather than creating a second one.
    saveSkill(p, "Release notes", "Updated", "New body.");
    assert.equal(mine().length, 2);
    assert.equal(getSkill(p, "Release notes").body, "New body.");

    renameSkill(p, "Release notes", "Release process");
    assert.equal(getSkill(p, "Release notes"), null);
    assert.equal(getSkill(p, "Release process").body, "New body.");
    assert.equal(getSkill(p, "Release process").file, "release-process.md");
    assert.ok(!existsSync(join(p.skills, "release-notes.md")));

    assert.equal(removeSkill(p, "Deploy steps"), true);
    assert.equal(removeSkill(p, "Deploy steps"), false);
    assert.deepEqual(mine(), ["Release process"]);
  });

  test("every project starts with the built-in skills, each with real instructions", () => {
    const names = listSkills(p).filter((s) => s.builtin).map((s) => s.name);
    for (const n of ["Bug fix", "Code review", "Write tests", "Refactor", "Explain this code", "Security review"]) assert.ok(names.includes(n), `missing ${n}: ${names.join()}`);
    for (const s of listSkills(p).filter((x) => x.builtin)) assert.ok(s.body.length > 300 && s.description, `${s.name} looks empty`);
    assert.match(getSkill(p, "Bug fix").body, /never in the tests/);
  });

  test("the built-in security skill can't be removed or renamed, but saving one with the same name overrides it", () => {
    const b = getSkill(p, "Security review");
    assert.equal(b.builtin, true);
    assert.match(b.body, /narrowbit audit/);
    assert.equal(removeSkill(p, "Security review"), false);
    assert.throws(() => renameSkill(p, "Security review", "Mine"), /built in/);
    saveSkill(p, "Security review", "custom", "Only check for secrets.");
    assert.equal(getSkill(p, "Security review").builtin, undefined);
    assert.equal(getSkill(p, "Security review").body, "Only check for secrets.");
    assert.equal(removeSkill(p, "Security review"), true, "removing the override restores the built-in");
    assert.equal(getSkill(p, "Security review").builtin, true);
  });

  test("saveSkill rejects an empty name or empty body", () => {
    assert.throws(() => saveSkill(p, "", "d", "body"));
    assert.throws(() => saveSkill(p, "name", "d", "   "));
  });

  test("slugify makes filesystem-safe, collision-resistant filenames", () => {
    assert.equal(slugify("Bug Fix!"), "bug-fix");
    assert.equal(slugify("  ---  "), "skill");
    assert.equal(slugify("API/Endpoint Review"), "api-endpoint-review");
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

  test("secrets in event summaries and command text are redacted before they are written", () => {
    const secret = "ghp_" + "A".repeat(36);
    appendEvent(p, "rt-redact-test", { actor: "model", type: "tool_call", summary: `run curl -H "Authorization: Bearer ${secret}" x`, meta: { command: `curl -H "Authorization: ${secret}" x` } });
    const raw = readFileSync(join(p.runtime, "rt-redact-test", "events.jsonl"), "utf8");
    assert.ok(!raw.includes(secret));
    assert.match(raw, /REDACTED/);
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
    const secretish = "token = ghp_abcdefghijklmnopqrstuvwxyz012345\nsome file content here"; // narrowbit-audit-ignore: fake fixture
    const handle = writeEvidence(p, taskId, "file", secretish, "src/config.ts, 2 lines", "src/config.ts");
    assert.ok(handle.id);
    assert.equal(handle.kind, "file");
    assert.equal(handle.path, "src/config.ts");
    assert.ok(handle.tokens > 0);
    const back = readEvidence(p, taskId, handle.id);
    assert.doesNotMatch(back, /ghp_abcdefghijklmnopqrstuvwxyz012345/, "evidence on disk is redacted like every other emitted text"); // narrowbit-audit-ignore: fake fixture
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

  test("parseDecisions accepts a batched array, falls back to a single object, caps oversized batches, and skips malformed entries", () => {
    assert.deepEqual(parseDecisions('[{"action":"read","path":"a.ts"},{"action":"verify"}]'), [{ action: "read", path: "a.ts" }, { action: "verify" }]);
    assert.deepEqual(parseDecisions('{"action":"done","summary":"ok"}'), [{ action: "done", summary: "ok" }]);
    const oversized = JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ action: "read", path: `f${i}.ts` })));
    assert.equal(parseDecisions(oversized).length, 5);
    assert.deepEqual(parseDecisions('[{"action":"read","path":"a.ts"},{"no":"action field"},{"action":"verify"}]'), [{ action: "read", path: "a.ts" }, { action: "verify" }]);
    assert.equal(parseDecisions("not json at all"), null);
    assert.equal(parseDecisions("[]"), null);
    // A model can echo Claude Code's own <function_calls> wrapping around the array; a naive
    // greedy {...} match would grab across both objects and fail to parse — the array regex must win.
    assert.deepEqual(
      parseDecisions('<function_calls>\n[{"action":"read","path":"a.ts"},{"action":"read","path":"b.ts"}]\n</function_calls>'),
      [{ action: "read", path: "a.ts" }, { action: "read", path: "b.ts" }],
    );
  });

  test("capSummary passes short text through and truncates long text with a pointer to ask again", () => {
    assert.equal(capSummary("short"), "short");
    const long = "x".repeat(10_000);
    const capped = capSummary(long, 100);
    assert.ok(capped.length < long.length);
    assert.match(capped, /truncated/);
  });

  test("safeAbsPath refuses symlinks that lead outside the repo, even dangling ones, but allows links that stay inside", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "nb-sl-")));
    const repo = join(base, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(base, "outside.txt"), "secret");
    writeFileSync(join(repo, "src", "a.ts"), "x");
    symlinkSync(join(base, "outside.txt"), join(repo, "leak.txt"));
    symlinkSync(join(base, "nowhere.txt"), join(repo, "dangling.txt"));
    symlinkSync(join(base, "outdir"), join(repo, "outdir-link"));
    symlinkSync(join(repo, "src", "a.ts"), join(repo, "inside-link.ts"));
    const p = { root: repo };
    assert.equal(safeAbsPath(p, "leak.txt"), null);
    assert.equal(safeAbsPath(p, "dangling.txt"), null);
    assert.equal(safeAbsPath(p, "outdir-link/new.ts"), null);
    assert.equal(safeAbsPath(p, "inside-link.ts"), join(repo, "inside-link.ts"));
    assert.equal(safeAbsPath(p, "src/a.ts"), join(repo, "src", "a.ts"));
    assert.equal(safeAbsPath(p, "src/brand-new-file.ts"), join(repo, "src", "brand-new-file.ts"));
    rmSync(base, { recursive: true, force: true });
  });

  test("publicConnector never exposes environment values (they are often tokens)", () => {
    const pc = publicConnector({ name: "gh", command: "npx", args: ["-y", "srv"], env: { GITHUB_TOKEN: "ghp_secretvalue", OTHER: "x" } }); // narrowbit-audit-ignore: fake fixture
    assert.deepEqual(pc.envKeys, ["GITHUB_TOKEN", "OTHER"]);
    assert.ok(!JSON.stringify(pc).includes("ghp_secretvalue"));
  });

  test("safeAbsPath refuses paths that escape the repo root", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "nb-safepath-")));
    const p = { root };
    assert.equal(safeAbsPath(p, "src/x.ts"), resolve(root, "src/x.ts"));
    assert.equal(safeAbsPath(p, "../../etc/passwd"), null);
    assert.equal(safeAbsPath(p, "/etc/passwd"), null);
    assert.equal(safeAbsPath(p, "."), null);
  });
});

describe("codex stream parsing (providers/codex-cli.ts — no model calls, no codex login needed)", () => {
  test("extracts text, thread id and usage from a well-formed successful turn", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "01a0-thread-id" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking…" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: '{"action":"done","summary":"ok"}' } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 500, output_tokens: 42, cached_input_tokens: 100 } }),
    ].join("\n");
    const r = parseCodexStream(lines);
    assert.equal(r.sessionId, "01a0-thread-id");
    assert.equal(r.text, '{"action":"done","summary":"ok"}');
    assert.equal(r.isError, false);
    assert.deepEqual(r.usage, { input: 500, cacheCreate: 0, cacheRead: 100, output: 42 });
  });

  test("a real observed auth failure (turn.failed, 401) is reported as an error, not silently empty", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "01a0-thread-id" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "error", message: "Reconnecting... 1/5 (unexpected status 401 Unauthorized...)" }),
      JSON.stringify({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header" } }),
    ].join("\n");
    const r = parseCodexStream(lines);
    assert.equal(r.isError, true);
    assert.match(r.errorMessage, /401 Unauthorized/);
    assert.equal(r.text, "");
  });

  test("an item-level error is captured even without a turn.failed", () => {
    const lines = [JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "something broke" } })].join("\n");
    const r = parseCodexStream(lines);
    assert.equal(r.isError, true);
    assert.match(r.errorMessage, /something broke/);
  });

  test("empty or garbage output is an error, not a silent empty success", () => {
    assert.equal(parseCodexStream("").isError, true);
    assert.equal(parseCodexStream("not json\nalso not json").isError, true);
  });
});

describe("readiness parsing (readiness.ts — no subprocess, no login needed)", () => {
  test("parseClaudeAuth reads loggedIn from `claude auth status` JSON and treats anything else as logged out", () => {
    assert.equal(parseClaudeAuth('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}'), true);
    assert.equal(parseClaudeAuth('{"loggedIn": false}'), false);
    assert.equal(parseClaudeAuth("Not logged in"), false);
    assert.equal(parseClaudeAuth(""), false);
  });
});

describe("model error classification (errors.ts)", () => {
  test("recognises usage limits (with reset time), sign-in problems and network errors", () => {
    const l = classifyModelError("You've hit your session limit · resets 1am (Asia/Calcutta)");
    assert.equal(l.kind, "limit");
    assert.match(l.resets, /1am/);
    assert.equal(classifyModelError("Groq 429: rate limit exceeded").kind, "limit");
    assert.equal(classifyModelError("codex CLI is not logged in to your ChatGPT subscription").kind, "auth");
    assert.equal(classifyModelError("OpenRouter 401: invalid api key").kind, "auth");
    assert.equal(classifyModelError("couldn't reach Ollama at http://127.0.0.1:11434 (ECONNREFUSED)").kind, "network");
    assert.equal(classifyModelError("unparseable model response").kind, "other");
    assert.equal(classifyModelError(undefined).kind, "other");
  });

  test("limits and sign-in problems are permanent (never retried); network glitches are not", () => {
    assert.equal(isPermanentModelError("You've hit your usage limit"), true);
    assert.equal(isPermanentModelError("not logged in"), true);
    assert.equal(isPermanentModelError("model call timed out"), false);
    assert.equal(isPermanentModelError(""), false);
  });
});

describe("security audit (audit.ts — model-free checkpoint)", () => {
  const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const repoWith = (files, ignore = "node_modules\n") => {
    const dir = mkdtempSync(join(tmpdir(), "nb-audit-"));
    sh(dir, "init", "-q");
    sh(dir, "config", "user.email", "a@b.c");
    sh(dir, "config", "user.name", "t");
    writeFileSync(join(dir, ".gitignore"), ignore);
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "init");
    return dir;
  };

  test("flags committed secret files, token-shaped strings (incl. Stripe) and browser-exposed secrets", () => {
    const dir = repoWith({
      ".env": "X=1\n",
      "src/a.ts": 'const t = "ghp_' + "a".repeat(36) + '";\nconst s = "sk_live_' + "b".repeat(24) + '";\nconst u = process.env.NEXT_PUBLIC_SERVICE_ROLE_KEY;\n', // narrowbit-audit-ignore: fake
    });
    const checks = auditRepo(dir, { history: false }).map((f) => `${f.severity}:${f.check}`);
    assert.ok(checks.includes("high:secret file"), checks.join());
    assert.ok(checks.filter((c) => c === "high:hardcoded secret").length >= 2, "github token and stripe key: " + checks.join());
    assert.ok(checks.includes("high:secret exposed to the browser"), checks.join());
    rmSync(dir, { recursive: true, force: true });
  });

  test("a clean project passes, .env.example is fine, an unignored .env is flagged, an ignored one is not", () => {
    const clean = repoWith({ ".env.example": "API_KEY=\n", "src/a.ts": "export const a = 1;\n" }, ".env\nnode_modules\n");
    assert.deepEqual(auditRepo(clean, { history: false }), []);
    writeFileSync(join(clean, ".env"), "SECRET=1\n");
    assert.deepEqual(auditRepo(clean, { history: false }), [], "ignored .env is fine");
    const risky = repoWith({ "src/a.ts": "x" });
    writeFileSync(join(risky, ".env.production"), "SECRET=1\n");
    assert.ok(auditRepo(risky, { history: false }).some((f) => f.check === "secret file not ignored"));
    rmSync(clean, { recursive: true, force: true });
    rmSync(risky, { recursive: true, force: true });
  });

  test("the audit-ignore marker silences a deliberate fixture, and a file list limits the scan", () => {
    const dir = repoWith({ "t.js": 'const k = "ghp_' + "c".repeat(36) + '"; // narrowbit-audit-ignore\n', "u.js": 'const k = "ghp_' + "d".repeat(36) + '";\n' }); // narrowbit-audit-ignore: fake
    const all = auditRepo(dir, { history: false });
    assert.equal(all.filter((f) => f.file === "t.js").length, 0);
    assert.equal(all.filter((f) => f.file === "u.js").length, 1);
    assert.equal(auditRepo(dir, { files: ["t.js"] }).length, 0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("model selection (providers/models.ts)", () => {
  test("defaults per provider when nothing is saved or passed", () => {
    assert.deepEqual(resolveSelection(undefined), { provider: "claude", tiers: DEFAULT_TIERS.claude, effort: "medium" });
    assert.deepEqual(resolveSelection(undefined, { provider: "codex" }).tiers, { explore: "gpt-6-luna", execute: "gpt-6-sol", escalate: "gpt-6-sol" });
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
    assert.equal(resolveSelection(saved).tiers.explore, "gpt-6-luna");
    assert.equal(resolveSelection(saved, { provider: "claude" }).tiers.explore, "sonnet");
  });

  test("unknown provider is an error, not a silent fallback", () => {
    assert.throws(() => resolveSelection({ provider: "nosuchai" }), /unknown provider/);
    assert.throws(() => resolveSelection(undefined, { provider: "nosuchai" }), /unknown provider/);
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

test("openai-compat adapter: keeps the conversation per session, cumulative cost, fatal vs retryable errors", async () => {
  const { callOpenAICompat } = await dist("providers/openai-compat.js");
  const { createServer } = await import("node:http");
  const seen = [];
  let status = 200;
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = JSON.parse(b);
      seen.push({ auth: req.headers.authorization, messages: body.messages });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200
        ? JSON.stringify({ choices: [{ message: { content: `{"action":"done","n":${seen.length}}` } }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 }, cost: 0.01 } })
        : JSON.stringify({ error: { message: "nope" } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ep = { provider: "openrouter", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k-test", needsKey: true };
  const base = { cwd: ".", role: "execution", model: "some/model:free", sessionId: "s1" };
  try {
    const a = await callOpenAICompat(ep, { ...base, systemPrompt: "SYS", prompt: "first" });
    const b = await callOpenAICompat(ep, { ...base, resume: true, prompt: "second" });
    assert.equal(a.isError, false);
    assert.deepEqual(a.usage, { input: 60, cacheCreate: 0, cacheRead: 40, output: 10 });
    assert.deepEqual(seen[0].messages.map((m) => m.role), ["system", "user"]);
    // The resumed call resends the whole conversation, including the model's own reply.
    assert.deepEqual(seen[1].messages.map((m) => m.content), ["SYS", "first", '{"action":"done","n":1}', "second"]);
    assert.equal(seen[0].auth, "Bearer k-test");
    assert.ok(Math.abs(b.costUsd - 0.02) < 1e-9, "costUsd is cumulative per session, like claude-cli");
    status = 401;
    const bad = await callOpenAICompat(ep, { ...base, resume: true, prompt: "third" });
    assert.equal(bad.isError, true);
    assert.equal(bad.fatal, true);
    status = 503;
    const flaky = await callOpenAICompat(ep, { ...base, resume: true, prompt: "fourth" });
    assert.equal(flaky.fatal, false, "a 5xx is worth retrying");
    // A failed call must not leave its prompt in the history (the retry would duplicate it).
    status = 200;
    await callOpenAICompat(ep, { ...base, resume: true, prompt: "fifth" });
    assert.deepEqual(seen.at(-1).messages.map((m) => m.content).slice(-2), ['{"action":"done","n":2}', "fifth"]);
    const noKey = await callOpenAICompat({ ...ep, apiKey: undefined }, { ...base, prompt: "x" });
    assert.equal(noKey.fatal, true);
  } finally {
    server.close();
  }
});

test("limits: reads both windows from Claude Code's rate_limit_event", async () => {
  const { parseClaudeLimits } = await dist("limits.js");
  // Shape captured from Claude Code 2.1.278's stream-json output.
  const raw = [
    '{"type":"system","subtype":"init"}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1790632800,"rateLimitType":"seven_day","utilization":0.56,"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.67,"resetsAt":1790172600},"seven_day":{"utilization":0.56,"resetsAt":1790632800}}}}',
    '{"type":"result","subtype":"success"}',
  ].join("\n");
  const l = parseClaudeLimits(raw);
  assert.deepEqual(l.fiveHour, { usedPercent: 67, resetsAt: 1790172600 });
  assert.deepEqual(l.weekly, { usedPercent: 56, resetsAt: 1790632800 });
  assert.equal(l.status, "allowed_warning");
  // Older output with a single window still yields that window.
  const old = parseClaudeLimits('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":5,"rateLimitType":"five_hour","utilization":0.1}}');
  assert.deepEqual(old.fiveHour, { usedPercent: 10, resetsAt: 5 });
  assert.equal(old.weekly, null);
  assert.equal(parseClaudeLimits('{"type":"result"}'), null);
});

// --- a stand-in `claude` so the real loop can run in tests without a model ---
const { runTask } = await dist("runtime.js");
const { initProject } = await dist("project.js");

/** Writes an executable that answers each call with the next scripted reply (as stream-json). */
function fakeClaude(replies) {
  const dir = mkdtempSync(join(tmpdir(), "nb-fake-"));
  writeFileSync(join(dir, "replies.json"), JSON.stringify(replies));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const f = ${JSON.stringify(join(dir, "replies.json"))}, c = ${JSON.stringify(join(dir, "count"))};
const n = fs.existsSync(c) ? Number(fs.readFileSync(c, "utf8")) : 0; fs.writeFileSync(c, String(n + 1));
fs.appendFileSync(${JSON.stringify(join(dir, "models.log"))}, (process.argv[process.argv.indexOf("--model") + 1] || "?") + "\\n");
const r = JSON.parse(fs.readFileSync(f, "utf8")); const text = r[Math.min(n, r.length - 1)];
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
console.log(JSON.stringify({ type: "assistant", message: { id: "m" + n, content: [{ type: "text", text }], usage } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, usage, total_cost_usd: 0, num_turns: 1, session_id: "s" }));
`, { mode: 0o755 });
  return { bin, dir, calls: () => Number(readFileSync(join(dir, "count"), "utf8")), models: () => readFileSync(join(dir, "models.log"), "utf8").trim().split("\n") };
}
function tinyRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nb-rt-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  writeFileSync(join(root, "a.txt"), "hello\n");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: root });
  const p = paths(root);
  ensureDirs(p);
  initProject(p, { index: false });
  return { root, p };
}

describe("ask action", () => {
  test("the model's question reaches the user, and their answer comes back into the loop", async () => {
    const { root, p } = tinyRepo();
    const fake = fakeClaude([
      JSON.stringify({ action: "ask", question: "Which name?", options: ["alpha", "beta"] }),
      JSON.stringify({ action: "done", summary: "used the name you chose" }),
    ]);
    const asked = [];
    try {
      const r = await runTask(p, "pick a name for the thing", { claudeBin: fake.bin, boss: false, maxSteps: 6, ask: async (q, o) => { asked.push([q, o]); return "beta"; } });
      assert.equal(r.outcome, "done");
      assert.deepEqual(asked, [["Which name?", ["alpha", "beta"]]]);
      const ev = readEvents(p, r.taskId);
      assert.ok(ev.some((e) => e.type === "tool_result" && /The user answered: beta/.test(e.summary)), "answer logged");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
  });

  test("every model call records an itemised breakdown of what it was sent (for the app's 'why is this in context?')", async () => {
    const { root, p } = tinyRepo();
    writeFileSync(join(root, "b.txt"), "some text to read\n");
    const fake = fakeClaude([
      JSON.stringify({ action: "read", path: "b.txt" }),
      JSON.stringify({ action: "done", summary: "read it" }),
    ]);
    try {
      const r = await runTask(p, "read b.txt", { claudeBin: fake.bin, boss: false, maxSteps: 6 });
      const calls = readEvents(p, r.taskId).filter((e) => e.type === "model_call");
      const first = calls[0].meta.context, second = calls[1].meta.context;
      assert.deepEqual(first.parts.map((x) => x.kind), ["task", "instructions"], "first call: the request and Narrowbit's rules");
      assert.ok(first.parts.find((x) => x.kind === "instructions").tokens > 200);
      assert.ok(second.parts.some((x) => x.kind === "result" && x.label === "read b.txt"), "second call: the read result, labelled");
      assert.ok(!second.parts.some((x) => x.kind === "instructions"), "rules are not resent on a resumed turn");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
  });

  test("with nobody to ask, the model is told to assume and continue instead of blocking", async () => {
    const { root, p } = tinyRepo();
    const fake = fakeClaude([
      JSON.stringify({ action: "ask", question: "Which name?" }),
      JSON.stringify({ action: "done", summary: "assumed alpha" }),
    ]);
    try {
      const r = await runTask(p, "pick a name for the thing", { claudeBin: fake.bin, boss: false, maxSteps: 6 });
      assert.equal(r.outcome, "done");
      assert.ok(readEvents(p, r.taskId).some((e) => /nobody is available to answer/.test(e.summary)));
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
  });
});

// --- remote MCP: HTTP transport + OAuth sign-in against a mock server ---
const { createServer: createHttp } = await import("node:http");
const { createHash } = await import("node:crypto");
const { startSignIn, completeSignIn, isSignedIn, accessToken, signOut } = await dist("oauth.js");
const { saveConnector, getConnector } = await dist("connectors.js");
const { listConnectorTools, callConnectorTool } = await dist("mcpClient.js");

function mockMcpWorld() {
  const state = { challenge: "", tokens: new Set(["tok1"]), refreshes: 0, calls: [], sse: true };
  const srv = createHttp((req, res) => {
    const url = new URL(req.url, "http://x");
    const base = `http://127.0.0.1:${srv.address().port}`;
    const json = (o, code = 200, h = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(JSON.stringify(o)); };
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (url.pathname === "/.well-known/oauth-protected-resource") return json({ authorization_servers: [base] });
      if (url.pathname === "/.well-known/oauth-authorization-server") return json({ authorization_endpoint: base + "/authorize", token_endpoint: base + "/token", registration_endpoint: base + "/register" });
      if (url.pathname === "/register") return json({ client_id: "cid" });
      if (url.pathname === "/authorize") {
        state.challenge = url.searchParams.get("code_challenge");
        res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?code=abc&state=${url.searchParams.get("state")}` });
        return res.end();
      }
      if (url.pathname === "/token") {
        const f = new URLSearchParams(body);
        if (f.get("grant_type") === "authorization_code") {
          const ok = f.get("code") === "abc" && createHash("sha256").update(f.get("code_verifier")).digest("base64url") === state.challenge;
          if (!ok) return json({ error: "invalid_grant" }, 400);
          return json({ access_token: "tok1", refresh_token: "ref1", expires_in: 3600 });
        }
        if (f.get("grant_type") === "refresh_token" && f.get("refresh_token") === "ref1") { state.refreshes++; state.tokens.add("tok2"); return json({ access_token: "tok2", expires_in: 3600 }); }
        return json({ error: "bad" }, 400);
      }
      if (url.pathname === "/mcp") {
        const auth = req.headers.authorization ?? "";
        if (!state.tokens.has(auth.replace(/^Bearer /, "")) && auth !== "Bearer static-token") return json({ error: "unauthorized" }, 401);
        const m = JSON.parse(body);
        state.calls.push(m.method);
        if (m.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
        if (m.method === "initialize") return json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock" } } }, 200, { "mcp-session-id": "sess-1" });
        if (req.headers["mcp-session-id"] !== "sess-1") return json({ error: "no session" }, 400);
        const reply = m.method === "tools/list" ? { tools: [{ name: "create_issue" }, { name: "list_issues" }] } : { content: [{ type: "text", text: `ran ${m.params.name} ${JSON.stringify(m.params.arguments)}` }] };
        if (state.sse && m.method === "tools/list") { res.writeHead(200, { "content-type": "text/event-stream" }); return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: reply })}\n\n`); }
        return json({ jsonrpc: "2.0", id: m.id, result: reply });
      }
      json({ error: "nope" }, 404);
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, state, base: `http://127.0.0.1:${srv.address().port}` })));
}

describe("remote MCP servers", () => {
  const realHome = process.env.HOME;
  let home, world;
  before(async () => { home = mkdtempSync(join(tmpdir(), "nb-mcphome-")); process.env.HOME = home; world = await mockMcpWorld(); });
  after(() => { process.env.HOME = realHome; world.srv.close(); rmSync(home, { recursive: true, force: true }); });

  test("full sign-in: discovery, registration, PKCE via the browser redirect, token stored 0600 and never public", async () => {
    saveConnector("mock", "", [], undefined, { url: world.base + "/mcp" });
    assert.equal(publicConnector(getConnector("mock")).signedIn, false);
    const authUrl = await startSignIn("mock", world.base + "/mcp", "http://127.0.0.1:1/oauth/callback");
    const back = await fetch(authUrl, { redirect: "manual" }); // what the browser does
    const cb = new URL(back.headers.get("location"));
    assert.equal(cb.searchParams.get("code"), "abc");
    assert.equal(await completeSignIn(cb.searchParams.get("state"), cb.searchParams.get("code")), "mock");
    assert.equal(isSignedIn("mock"), true);
    const mode = (await import("node:fs")).statSync(join(home, ".narrowbit", "oauth.json")).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.ok(!JSON.stringify(publicConnector(getConnector("mock"))).includes("tok1"), "the token never appears in what the page sees");
    await assert.rejects(() => completeSignIn(cb.searchParams.get("state"), "abc"), /unknown or expired/, "a state can be used once");
  });

  test("lists tools (from an event stream) and calls one (plain JSON), with the session id echoed", async () => {
    const c = getConnector("mock");
    assert.deepEqual((await listConnectorTools(c)).map((t) => t.name), ["create_issue", "list_issues"]);
    const r = await callConnectorTool(c, "create_issue", { title: "hi" });
    assert.match(r.text, /ran create_issue {"title":"hi"}/);
  });

  test("an expired access token is refreshed once and the call succeeds", async () => {
    world.state.tokens.delete("tok1"); // the server no longer accepts the first token
    const c = getConnector("mock");
    const r = await callConnectorTool(c, "list_issues", {});
    assert.match(r.text, /ran list_issues/);
    assert.equal(world.state.refreshes, 1);
    assert.equal(await accessToken("mock"), "tok2");
  });

  test("signed out: a clear 'sign in' message, and a static Authorization header works without OAuth", async () => {
    signOut("mock");
    await assert.rejects(() => listConnectorTools(getConnector("mock")), /sign-in required/);
    saveConnector("token-based", "", [], undefined, { url: world.base + "/mcp", headers: { Authorization: "Bearer static-token" } });
    assert.equal((await listConnectorTools(getConnector("token-based"))).length, 2);
    assert.deepEqual(publicConnector(getConnector("token-based")).headerKeys, ["Authorization"]);
    assert.ok(!JSON.stringify(publicConnector(getConnector("token-based"))).includes("static-token"));
  });
});

const { readIsolated, isolatedPatch, applyIsolated, discardIsolated } = await dist("isolate.js");

describe("isolated runs (throwaway git worktree)", () => {
  test("the agent edits a separate copy; the folder is untouched until Apply, and Discard removes the copy", async () => {
    const { root, p } = tinyRepo();
    writeFileSync(join(root, "a.txt"), "hello\nuncommitted line\n"); // the copy must start from the folder as it is now
    writeFileSync(join(root, "notes.txt"), "an untracked file\n");
    const fake = fakeClaude([
      JSON.stringify({ action: "read", path: "notes.txt" }),
      JSON.stringify([{ action: "edit", path: "a.txt", old: "hello", new: "goodbye" }, { action: "run", command: "echo ran-in-copy > proof.txt" }]),
      JSON.stringify({ action: "done", summary: "edited" }),
    ]);
    try {
      const r = await runTask(p, "change hello to goodbye", { claudeBin: fake.bin, boss: false, maxSteps: 8, isolate: true });
      assert.equal(r.outcome, "done");
      assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "hello\nuncommitted line\n", "the real folder is untouched");
      assert.ok(!existsSync(join(root, "proof.txt")), "commands ran in the copy, not the folder");
      const m = readIsolated(p, r.taskId);
      assert.ok(m && existsSync(join(m.dir, "proof.txt")));
      assert.equal(readFileSync(join(m.dir, "a.txt"), "utf8"), "goodbye\nuncommitted line\n", "edited on top of the uncommitted work");
      const patch = isolatedPatch(m);
      assert.match(patch, /-hello/); assert.match(patch, /\+goodbye/);
      assert.ok(!/uncommitted line/.test(patch.split("\n").filter((l) => /^[+-][^+-]/.test(l)).join("\n")), "the patch holds only the agent's work");
      const applied = applyIsolated(p, r.taskId);
      assert.equal(applied.ok, true, applied.message);
      assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "goodbye\nuncommitted line\n");
      assert.ok(existsSync(join(root, "proof.txt")));
      discardIsolated(p, r.taskId);
      assert.equal(readIsolated(p, r.taskId), null);
      assert.ok(!existsSync(m.dir), "the copy is gone");
      assert.ok(!execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" }).includes("worktrees"), "and git forgot it");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
  });

  test("Apply refuses cleanly when the folder changed in the same place meanwhile", async () => {
    const { root, p } = tinyRepo();
    const fake = fakeClaude([
      JSON.stringify({ action: "edit", path: "a.txt", old: "hello", new: "from the agent" }),
      JSON.stringify({ action: "done", summary: "edited" }),
    ]);
    try {
      const r = await runTask(p, "edit it", { claudeBin: fake.bin, boss: false, maxSteps: 8, isolate: true });
      writeFileSync(join(root, "a.txt"), "the user edited this line too\n");
      const applied = applyIsolated(p, r.taskId);
      assert.equal(applied.ok, false);
      assert.match(applied.message, /doesn't apply cleanly/);
      assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "the user edited this line too\n", "nothing was overwritten");
      discardIsolated(p, r.taskId);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
  });
});

const { findSkills, parseGithubUrl, parseSkillFile } = await dist("skillimport.js");

describe("importing skills from GitHub", () => {
  let srv, base;
  const files = {
    "/repos/o/r/contents/": [{ name: "README.md", type: "file", path: "README.md" }, { name: "skills", type: "dir", path: "skills" }],
    "/repos/o/r/contents/skills": [{ name: "deploy", type: "dir", path: "skills/deploy" }, { name: "review", type: "dir", path: "skills/review" }],
    "/repos/o/r/contents/skills/deploy": [{ name: "SKILL.md", type: "file", path: "skills/deploy/SKILL.md" }],
    "/repos/o/r/contents/skills/review": [{ name: "SKILL.md", type: "file", path: "skills/review/SKILL.md" }],
    "/repos/o/r/contents/README.md": null,
  };
  const raws = {
    "/o/r/HEAD/skills/deploy/SKILL.md": '---\nname: deploy-checklist\ndescription: "Before you ship"\n---\n\nRun the tests, then tag.\n',
    "/o/r/HEAD/skills/review/SKILL.md": "Review the diff carefully.\n",
    "/o/r/main/notes/one.md": "---\nname: One\n---\nDo one thing.\n",
  };
  before(async () => {
    srv = createHttp((req, res) => {
      const path = new URL(req.url, "http://x").pathname.replace(/\/$/, "") || "/";
      const api = Object.keys(files).find((k) => k.replace(/\/$/, "") === path.replace(/^\/api/, ""));
      if (path.startsWith("/api/") && api && files[api]) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(files[api])); }
      if (path.startsWith("/raw/") && raws[path.slice(4)]) { res.writeHead(200); return res.end(raws[path.slice(4)]); }
      res.writeHead(404); res.end("no");
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${srv.address().port}`;
    process.env.NARROWBIT_GITHUB_API = base + "/api";
    process.env.NARROWBIT_GITHUB_RAW = base + "/raw";
  });
  after(() => { srv.close(); delete process.env.NARROWBIT_GITHUB_API; delete process.env.NARROWBIT_GITHUB_RAW; });

  test("understands blob, tree, raw and bare-repo links; refuses other hosts", () => {
    assert.deepEqual(parseGithubUrl("https://github.com/o/r/blob/main/skills/x/SKILL.md"), { owner: "o", repo: "r", ref: "main", path: "skills/x/SKILL.md" });
    assert.deepEqual(parseGithubUrl("https://github.com/o/r/tree/dev/skills"), { owner: "o", repo: "r", ref: "dev", path: "skills" });
    assert.deepEqual(parseGithubUrl("https://raw.githubusercontent.com/o/r/main/a.md"), { owner: "o", repo: "r", ref: "main", path: "a.md" });
    assert.deepEqual(parseGithubUrl("https://github.com/o/r.git"), { owner: "o", repo: "r", ref: null, path: "" });
    assert.throws(() => parseGithubUrl("https://evil.example.com/o/r"), /Only github.com/);
  });

  test("a repository is searched for SKILL.md files one level down; frontmatter names and descriptions are kept", async () => {
    const found = await findSkills("https://github.com/o/r");
    assert.deepEqual(found.map((c) => c.name).sort(), ["Deploy checklist", "Review"]);
    const d = found.find((c) => c.name === "Deploy checklist");
    assert.equal(d.description, "Before you ship");
    assert.match(d.body, /Run the tests, then tag/);
  });

  test("a single file link works, and an empty result is a clear error", async () => {
    const one = await findSkills("https://github.com/o/r/blob/main/notes/one.md");
    assert.equal(one[0].name, "One");
    assert.equal(parseSkillFile("", "x.md"), null);
    await assert.rejects(() => findSkills("https://github.com/o/r/blob/main/missing.md"), /answered 404/);
  });
});

describe("connector tools are described on demand, not listed in full every turn", () => {
  const realHome = process.env.HOME;
  let home;
  before(() => { home = mkdtempSync(join(tmpdir(), "nb-dhome-")); process.env.HOME = home; saveConnector("nb", "node", [join(here, "..", "bin", "narrowbit.js"), "mcp"]); });
  after(() => { process.env.HOME = realHome; rmSync(home, { recursive: true, force: true }); });

  test("the prompt lists tool names only; 'describe' returns a tool's arguments when the model asks", async () => {
    const { root, p } = tinyRepo();
    const fake = fakeClaude([
      JSON.stringify({ action: "describe", server: "nb", tool: "nb_symbol" }),
      JSON.stringify({ action: "describe", server: "nb", tool: "nope" }),
      JSON.stringify({ action: "done", summary: "looked" }),
    ]);
    try {
      const r = await runTask(p, "see what the nb connector offers", { claudeBin: fake.bin, boss: false, maxSteps: 8 });
      const ev = readEvents(p, r.taskId);
      const results = ev.filter((e) => e.type === "tool_result").map((e) => e.summary);
      assert.ok(results.some((t) => /^nb\.nb_symbol:/.test(t) && /JSON schema/.test(t) && /properties/.test(t)), "schema returned on request");
      assert.ok(results.some((t) => /no tool "nope"/.test(t) && /nb_symbol/.test(t)), "an unknown tool lists the real ones");
      const first = ev.find((e) => e.type === "model_call").meta.context.parts.find((x) => x.kind === "instructions");
      assert.ok(first.tokens < 3500, "the fixed instructions stay small (names only: " + first.tokens + " est. tokens)");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
  });
});

describe("experimental decider routing", () => {
  const tiers = { explore: "m-explore", execute: "m-execute", escalate: "m-escalate" };
  const script = () => [JSON.stringify({ action: "read", path: "a.txt" }), JSON.stringify({ action: "done", summary: "ok" })];
  let srv, url, asked = [];
  before(async () => {
    srv = createHttp((req, res) => {
      let b = ""; req.on("data", (d) => (b += d));
      req.on("end", () => {
        const body = JSON.parse(b); asked.push(body.state);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ answers: { tier: { choice: "escalate", probabilities: { explore: 0.1, execute: 0.2, escalate: 0.7 }, confidence: 0.7 } } }));
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${srv.address().port}`;
  });
  after(() => srv.close());

  test("rules (the default) route reading to the explore tier", async () => {
    const { root, p } = tinyRepo(); const fake = fakeClaude(script());
    try {
      await runTask(p, "read a.txt", { claudeBin: fake.bin, boss: false, maxSteps: 6, models: tiers });
      assert.equal(fake.models()[0], "m-explore");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
  });

  test("with the decider router, its choice picks the tier, and only compact metadata is sent to it", async () => {
    asked = [];
    const { root, p } = tinyRepo(); writeFileSync(join(root, "a.txt"), "SECRET-CONTENT-OF-A-FILE\n");
    const fake = fakeClaude(script());
    try {
      const r = await runTask(p, "read a.txt", { claudeBin: fake.bin, boss: false, maxSteps: 6, models: tiers, router: { kind: "decider", url } });
      assert.equal(fake.models()[0], "m-escalate", "the decider said escalate");
      const route = readEvents(p, r.taskId).find((e) => e.meta?.route)?.meta.route;
      assert.equal(route.chosen, "escalate"); assert.equal(route.rules, "explore"); assert.equal(route.used, true);
      assert.ok(asked.length >= 1 && asked.every((st) => /Task: read a\.txt/.test(st) && /step \d+ of/.test(st)));
      assert.ok(!asked.some((st) => st.includes("SECRET-CONTENT")), "file contents never leave the runtime — only metadata");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
  });

  test("an unreachable decider falls back to the rules instead of failing the task", async () => {
    const { root, p } = tinyRepo(); const fake = fakeClaude(script());
    try {
      const r = await runTask(p, "read a.txt", { claudeBin: fake.bin, boss: false, maxSteps: 6, models: tiers, router: { kind: "decider", url: "http://127.0.0.1:1" } });
      assert.equal(r.outcome, "done");
      assert.equal(fake.models()[0], "m-explore");
      assert.match(readEvents(p, r.taskId).find((e) => e.meta?.route).summary, /decider unavailable/);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(fake.dir, { recursive: true, force: true }); }
  });
});

describe("output compression ideas borrowed from OmniRoute", () => {
  test("near-identical lines collapse into one with a count; error lines are never grouped", () => {
    const lines = ["start", ...Array.from({ length: 40 }, (_, i) => `progress ${i}/40 at 2026-09-25T10:00:${String(i).padStart(2, "0")}Z id=${(i * 7919).toString(16).padStart(8, "a")}`), "error TS2304 a.ts(12,3): Cannot find name x", "error TS2304 a.ts(15,3): Cannot find name y", "error TS2304 a.ts(18,3): Cannot find name z", "done"];
    const g = groupSimilar(lines);
    assert.ok(g.length < 10, `collapsed (${g.length} lines)`);
    assert.ok(g.some((l) => /\[\+39 similar lines\]/.test(l)));
    assert.equal(g.filter((l) => /error TS2304/.test(l)).length, 3, "all three distinct errors survive");
  });

  test("a long output keeps its start, its end and the error lines from the middle (the old cut kept only the start)", () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i} some ordinary output text that takes up room`);
    lines[300] = "FAIL src/middle.test.ts: expected 1 received 2";
    lines[599] = "Tests: 1 failed, 599 passed";
    const out = capOutput(lines.join("\n"), 400);
    assert.match(out, /line 0 /); assert.match(out, /Tests: 1 failed, 599 passed/); assert.match(out, /FAIL src\/middle\.test\.ts/);
    assert.match(out, /lines omitted/);
    assert.ok(out.length < 400 * 3.6 + 400, `stays near its budget (${out.length} chars)`);
    assert.equal(capOutput("short", 400), "short", "small output is untouched");
  });

  test("the fidelity gate falls back to the raw output when a condenser would lose the reported errors", () => {
    const raw = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts(${i + 1},1): error TS${2300 + i}: Something is wrong ${i}`).join("\n");
    const c = compressOutput(raw, 1);
    const have = [...raw.matchAll(/TS23\d\d/g)].slice(0, 20).filter((m) => c.text.includes(m[0])).length;
    assert.ok(have >= 17, `at least 85% of the first 20 error codes are still present (${have}/20)`);
  });
});

describe("fallback provider (idea from OmniRoute's failover)", () => {
  test("when the main model hits a usage limit, a configured backup takes over mid-task instead of the task ending", async () => {
    const { root, p } = tinyRepo();
    const dir = mkdtempSync(join(tmpdir(), "nb-limit-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/usr/bin/env node
console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "You've hit your session limit · resets 1am", usage: {}, session_id: "s" }));
`, { mode: 0o755 });
    let hits = 0;
    const srv = createHttp((req, res) => {
      let b = ""; req.on("data", (d) => (b += d));
      req.on("end", () => { hits++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ action: "done", summary: "finished on the backup" }) } }], usage: { prompt_tokens: 20, completion_tokens: 5 } })); });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const cfg = loadConfig(p);
      cfg.agent = { fallback: "custom", endpoints: { custom: { baseUrl: `http://127.0.0.1:${srv.address().port}/v1` } }, models: { custom: { explore: "m", execute: "m", escalate: "m" } } };
      (await dist("config.js")).saveConfig(p, cfg);
      const r = await runTask(p, "say hello", { claudeBin: bin, boss: false, maxSteps: 6 });
      assert.equal(r.outcome, "done");
      assert.match(r.summary, /finished on the backup/);
      const ev = readEvents(p, r.taskId);
      assert.ok(ev.some((e) => /^fallback: .*session limit.*continuing on custom/.test(e.summary)), "the switch is logged with its reason");
      assert.ok(hits >= 1);
    } finally { srv.close(); rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
  });

  test("without a fallback, the same limit ends the task with a clear error (nothing changes for people who don't opt in)", async () => {
    const { root, p } = tinyRepo();
    const dir = mkdtempSync(join(tmpdir(), "nb-limit-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/usr/bin/env node
console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "You've hit your session limit · resets 1am", usage: {}, session_id: "s" }));
`, { mode: 0o755 });
    try {
      const r = await runTask(p, "say hello", { claudeBin: bin, boss: false, maxSteps: 6 });
      assert.equal(r.outcome, "error");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("working-style hints are for non-Claude models only", () => {
  async function systemPromptSeen(provider) {
    const { root, p } = tinyRepo();
    let seen = "";
    const srv = createHttp((req, res) => {
      let b = ""; req.on("data", (d) => (b += d));
      req.on("end", () => {
        const j = JSON.parse(b); seen = seen || JSON.stringify(j.messages);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ action: "done", summary: "ok" }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const cfg = loadConfig(p);
      cfg.agent = { endpoints: { custom: { baseUrl: `http://127.0.0.1:${srv.address().port}/v1` } }, models: { custom: { explore: "m", execute: "m", escalate: "m" } } };
      (await dist("config.js")).saveConfig(p, cfg);
      await runTask(p, "say hi", { provider, models: { explore: "m", execute: "m", escalate: "m" }, boss: false, maxSteps: 4 });
    } finally { srv.close(); rmSync(root, { recursive: true, force: true }); }
    return seen;
  }
  test("an API provider is told to batch actions; the text is absent for Claude (its prompt is unchanged)", async () => {
    assert.match(await systemPromptSeen("custom"), /Working style for this model: send a JSON ARRAY/);
    const claude = readFileSync(join(here, "..", "dist", "runtime.js"), "utf8");
    assert.match(claude, /provider === "claude" \? ""/, "the hint is conditional on the provider");
  });
});

describe("lenient action parsing (failures seen from DeepSeek V4.1 Flash on Hono)", () => {
  test("prose before the array, and a stray echoed tag with brackets after it, still parse", () => {
    const t = 'Let me look at the failing test.\n\n[{"action":"read","path":"a.ts","start":1,"end":20},{"action":"grep","pattern":"x"}]\n\n<system>[1/2] read a.ts:1-20\nfoo</system>';
    assert.deepEqual(parseDecisions(t)?.map((d) => d.action), ["read", "grep"]);
  });
  test("a string containing brackets and braces inside an edit does not confuse the scanner", () => {
    const t = 'Fixing it.\n[{"action":"edit","path":"a.ts","old":"const a = [1, 2];\\nif (x) { y() }","new":"const a = [1, 2, 3];"}] trailing ] }';
    const d = parseDecisions(t);
    assert.equal(d?.length, 1);
    assert.equal(d?.[0].new, "const a = [1, 2, 3];");
  });
  test("DeepSeek's native tool-call markup is read as the same actions", () => {
    const t = 'I\'ll start by exploring.\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="grep">\n<｜｜DSML｜｜ parameter name="pattern" string="true">expandIPv6</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n<｜｜DSML｜｜ invoke name="read">\n<｜｜DSML｜｜ parameter name="path" string="true">src/utils/ipaddr.ts</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="start" string="false">11</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
    const d = parseDecisions(t);
    assert.deepEqual(d?.map((x) => x.action), ["grep", "read"]);
    assert.equal(d?.[0].pattern, "expandIPv6");
    assert.equal(d?.[1].path, "src/utils/ipaddr.ts");
    assert.equal(d?.[1].start, 11);
  });
  test("plain nonsense still fails so the corrective retry happens", () => {
    assert.equal(parseDecisions("I think we should look at the tests first."), null);
  });
});

describe("DeepSeek effort mapping", () => {
  async function bodyFor(effort) {
    let body = null;
    const srv = createHttp((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { body = JSON.parse(b); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: {} })); }); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const { callOpenAICompat } = await dist("providers/openai-compat.js");
    try { await callOpenAICompat({ provider: "deepseek", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", needsKey: true }, { prompt: "x", model: "deepseek-flash", role: "t", effort }); } finally { srv.close(); }
    return body;
  }
  test("low turns thinking off; high/max map to reasoning_effort; medium changes nothing", async () => {
    assert.deepEqual((await bodyFor("low")).thinking, { type: "disabled" });
    assert.equal((await bodyFor("medium")).reasoning_effort, undefined, "the default effort leaves DeepSeek's own default alone");
    assert.equal((await bodyFor("medium")).thinking, undefined);
    assert.equal((await bodyFor("high")).reasoning_effort, "high");
    assert.equal((await bodyFor("max")).reasoning_effort, "max");
  });
});

describe("JSON-mode replies and the output split (experiment)", () => {
  test('an {"actions": [...]} object parses like a bare array', () => {
    assert.deepEqual(parseDecisions('{"actions":[{"action":"read","path":"a.ts"},{"action":"verify"}]}')?.map((d) => d.action), ["read", "verify"]);
  });
  test("jsonActions asks the API for json_object and records reasoning tokens and prose per call", async () => {
    const { root, p } = tinyRepo();
    let seen = null;
    const srv = createHttp((req, res) => {
      let b = ""; req.on("data", (d) => (b += d));
      req.on("end", () => {
        seen = seen || JSON.parse(b);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Sure. {"actions":[{"action":"done","summary":"ok"}]}' } }], usage: { prompt_tokens: 10, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 40 } } }));
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const cfg = loadConfig(p);
      cfg.agent = { endpoints: { custom: { baseUrl: `http://127.0.0.1:${srv.address().port}/v1` } } };
      (await dist("config.js")).saveConfig(p, cfg);
      const r = await runTask(p, "say hi", { provider: "custom", models: { explore: "m", execute: "m", escalate: "m" }, boss: false, maxSteps: 4, jsonActions: true });
      assert.deepEqual(seen.response_format, { type: "json_object" });
      assert.match(seen.messages[0].content, /"actions": \[/);
      const out = readEvents(p, r.taskId).find((e) => e.type === "model_call").meta.out;
      assert.equal(out.reasoning, 40);
      assert.equal(out.proseChars, "Sure. ".length, "the prose around the JSON is measured");
    } finally { srv.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Codex adapter usage accounting", () => {
  test("running thread totals from `codex exec resume` become per-call usage, and cached tokens are not counted twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-codex-"));
    const bin = join(dir, "codex");
    // Like codex-cli 0.156: each call reports the thread's cumulative usage; input_tokens include the cached ones.
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"); const c = ${JSON.stringify(join(dir, "n"))};
const n = fs.existsSync(c) ? Number(fs.readFileSync(c, "utf8")) + 1 : 1; fs.writeFileSync(c, String(n));
fs.appendFileSync(${JSON.stringify(join(dir, "args.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({ type: "thread.started", thread_id: "th-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7000 * n, cached_input_tokens: 5000 * n, output_tokens: 10 * n, reasoning_output_tokens: 4 * n } }));
`, { mode: 0o755 });
    const { callCodex } = await dist("providers/codex-cli.js");
    process.env.NARROWBIT_CODEX = bin;
    try {
      const a = await callCodex({ cwd: dir, prompt: "hi", systemPrompt: "RULES", model: "gpt-6-luna", role: "t" });
      const b = await callCodex({ cwd: dir, prompt: "again", model: "gpt-6-luna", role: "t", sessionId: "th-1", resume: true });
      assert.deepEqual(a.usage, { input: 2000, cacheCreate: 0, cacheRead: 5000, output: 10 });
      assert.deepEqual(b.usage, { input: 2000, cacheCreate: 0, cacheRead: 5000, output: 10 }, "the second call is its own share, not the running total");
      assert.equal(b.reasoningTokens, 4);
      const calls = readFileSync(join(dir, "args.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(calls[0].includes("features.shell_tool=false"), "Codex's own tools are switched off");
      assert.ok(calls[0].some((x) => x.startsWith("model_instructions_file=")), "our rules replace Codex's base instructions");
      assert.ok(!calls[0].some((x) => x.includes("RULES")), "…instead of being pasted into the prompt");
      assert.ok(calls[1].some((x) => x.startsWith("model_instructions_file=")), "and stay the same on resumed calls");
    } finally { delete process.env.NARROWBIT_CODEX; rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("compaction ignores the provider's own per-call overhead", () => {
  test("a CLI that adds 20k tokens of its own to every call doesn't make every step compact", async () => {
    const { root, p } = tinyRepo();
    const dir = mkdtempSync(join(tmpdir(), "nb-heavy-"));
    const bin = join(dir, "claude");
    // Every call reports ~20k of context the runtime never sent (like Codex's own instructions and tools), growing a little.
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"); const c = ${JSON.stringify(join(dir, "n"))};
const n = fs.existsSync(c) ? Number(fs.readFileSync(c, "utf8")) + 1 : 1; fs.writeFileSync(c, String(n));
const replies = [${JSON.stringify(JSON.stringify({ action: "read", path: "a.txt" }))}, ${JSON.stringify(JSON.stringify({ action: "read", path: "a.txt" }))}, ${JSON.stringify(JSON.stringify({ action: "read", path: "a.txt" }))}, ${JSON.stringify(JSON.stringify({ action: "done", summary: "read it" }))}];
const text = replies[Math.min(n - 1, replies.length - 1)];
const usage = { input_tokens: 500, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 20000 + n * 300 };
console.log(JSON.stringify({ type: "assistant", message: { id: "m" + n, content: [{ type: "text", text }], usage } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, usage, total_cost_usd: 0, num_turns: 1, session_id: "s" }));
`, { mode: 0o755 });
    try {
      const r = await runTask(p, "read a.txt", { claudeBin: bin, boss: false, maxSteps: 8, compactThreshold: 5000 });
      assert.equal(r.outcome, "done");
      assert.equal(r.compactions, 0, "20k of provider overhead alone must not trigger compaction at a 5k threshold");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
  });
});

test("Codex's usage-limit message is a limit with its reset time", async () => {
  const { classifyModelError } = await dist("errors.js");
  assert.deepEqual(classifyModelError("You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:06 PM."), { kind: "limit", resets: "4:06 PM" });
});

test("benchmark waits for a usage limit's stated reset time (capped, with a fallback)", async () => {
  const { msUntilReset } = await dist("bench.js");
  const now = new Date(2026, 8, 26, 13, 0, 0);
  assert.equal(msUntilReset("4:06 PM", now), (3 * 60 + 6) * 60_000 + 60_000);
  assert.equal(msUntilReset("1am (Asia/Calcutta)", now), 12 * 3600_000 > 6 * 3600_000 ? 6 * 3600_000 : 0, "next-day resets are capped at 6h");
  assert.equal(msUntilReset("in 30 minutes", now), 31 * 60_000);
  assert.equal(msUntilReset(undefined, now), 30 * 60_000);
  assert.equal(msUntilReset("whenever", now), 30 * 60_000);
});
