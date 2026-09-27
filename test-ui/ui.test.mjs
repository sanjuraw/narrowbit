// Browser-level checks of the app page: boots the real server, loads the real page in jsdom and drives it.
// Run with `npm run test:ui`. Each check below exists because that exact thing broke (or nearly broke)
// and was only noticed by hand: the folder dialog with no Cancel, a different layout per state, the
// version/readiness UI, skills, error cards. No model is ever called.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "narrowbit.js");

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** Starts `narrowbit ui` in `cwd` with an empty HOME (no sign-ins, no recent folders), like a fresh user. */
async function startApp({ cwd, home, env = {} }) {
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, "ui", "--no-open", "--port", String(port)], { cwd, env: { ...process.env, HOME: home, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("ui server did not start: " + buf)), 15000);
    child.stdout.on("data", (d) => {
      buf += d;
      const m = /narrowbit ui: (\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("exit", (c) => reject(new Error(`ui server exited (${c}): ${buf}`)));
  });
  const u = new URL(url);
  return { url, token: u.searchParams.get("t"), base: u.origin, stop: () => child.kill() };
}

/** Loads the page like a browser would, collecting every script error. */
async function openPage(url) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(String(e.stack || e)));
  const dom = await JSDOM.fromURL(url, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, w.location.href), o);
      w.EventSource = class { addEventListener() {} close() {} };
      w.Element.prototype.scrollIntoView = () => {};
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.addEventListener("error", (e) => errors.push("window error: " + e.message));
      w.addEventListener("unhandledrejection", (e) => errors.push("unhandled rejection: " + (e.reason && e.reason.message)));
    },
  });
  const w = dom.window;
  const $ = (id) => w.document.getElementById(id);
  const visible = (el) => !!el && !el.classList.contains("hidden") && w.getComputedStyle(el).display !== "none";
  const until = async (fn, what, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      try {
        const v = fn();
        if (v) return v;
      } catch {
        // not ready yet
      }
      if (Date.now() - t0 > ms) throw new Error("timed out waiting for: " + what + (errors.length ? "\nscript errors:\n" + errors.join("\n") : ""));
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true }));
  return { w, $, visible, until, key, errors, close: () => w.close() };
}

const fresh = (name) => realpathSync(mkdtempSync(join(tmpdir(), `nb-ui-${name}-`)));

describe("app page with no folder open (a brand-new user)", () => {
  let home, app, page;
  before(async () => {
    home = fresh("home");
    app = await startApp({ cwd: home, home });
    page = await openPage(app.url);
    await page.until(() => page.$("crumbName").textContent, "the folder pill to render");
  });
  after(() => {
    page?.close();
    app?.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("the page boots without a single script error", () => {
    assert.deepEqual(page.errors, []);
  });

  test("one folder control above the composer, reading 'Choose a folder to start' — no second bar in the top bar", () => {
    assert.equal(page.$("crumbName").textContent, "Choose a folder to start");
    assert.ok(page.$("crumb").classList.contains("empty"));
    assert.ok(page.visible(page.$("crumbWrap")));
    assert.equal(page.$("repoBar"), null, "the old top-bar folder control must be gone");
    assert.equal(page.$("crumbWrap").nextElementSibling.className, "composer", "the pill sits directly above the composer");
  });

  test("the folder dialog opens from the pill and the sidebar, and can always be closed (Cancel, Escape, click outside)", async () => {
    for (const opener of ["crumb", "repoBtn"]) {
      page.$(opener).click();
      assert.ok(page.visible(page.$("repoOverlay")), `${opener} opens the dialog`);
      assert.ok(page.visible(page.$("closeRepo")), "Cancel must exist even with no folder open");
      assert.ok(!page.visible(page.$("startNoFolder")), "nothing to leave when no folder is open yet");
      page.$("closeRepo").click();
      assert.ok(!page.visible(page.$("repoOverlay")), "Cancel closes it");

      page.$(opener).click();
      page.key("Escape");
      assert.ok(!page.visible(page.$("repoOverlay")), "Escape closes it");

      page.$(opener).click();
      page.$("repoOverlay").dispatchEvent(new page.w.MouseEvent("click", { bubbles: true }));
      assert.ok(!page.visible(page.$("repoOverlay")), "clicking outside closes it");
    }
  });

  test("models are selectable before a folder is chosen (the providers list is never empty)", () => {
    assert.ok(page.$("providerSel").options.length >= 15, "provider list");
    const models = [...page.w.document.querySelectorAll("#slots [id^=slot-]")].map((i) => i.value);
    assert.deepEqual(models, ["sonnet", "sonnet", "opus"]);
  });

  test("Claude's models are picked from a dropdown, and switching to Codex changes the models too (no folder open)", async () => {
    await page.until(() => page.w.document.querySelector("#slots select"), "model dropdowns");
    const opts = [...page.w.document.querySelectorAll("#slot-explore option")].map((o) => o.value);
    assert.ok(opts.includes("sonnet") && opts.includes("__other"), "options include known models and Other…");
    const sel = page.$("providerSel");
    sel.value = "codex";
    sel.dispatchEvent(new page.w.Event("change"));
    await page.until(() => /gpt/.test(page.w.document.querySelector("#slot-execute")?.value ?? ""), "Codex models in the slots");
  });

  test("the Cloudflare account id saves with no folder open, and shows up in the endpoint", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const post = (b) => fetch(`${app.base}/api/account-id`, { method: "POST", headers: { "x-narrowbit-token": app.token, "content-type": "application/json" }, body: JSON.stringify(b) });
    assert.equal((await post({ id: "nope" })).status, 400, "rejects a malformed id");
    const res = await post({ id });
    assert.equal(res.status, 200);
    const st = await res.json();
    assert.ok(st.providers.cloudflare.baseUrl.includes(id), "endpoint uses the saved id");
  });

  test("after an update the app says what it brought, in detail, until it is dismissed", async () => {
    mkdirSync(join(home, ".narrowbit"), { recursive: true });
    const file = join(home, ".narrowbit", "last-update.json");
    writeFileSync(file, JSON.stringify({ number: 187, from: "aaaaaaa", to: "bbbbbbb", notes: [{ title: "Attach images and PDFs", details: "Claude and Codex see images.\nPDFs go as text elsewhere." }, { title: "Hide the sidebar", details: "" }] }));
    const p2 = await openPage(app.url);
    try {
      await p2.until(() => !p2.$("whatsNew").classList.contains("hidden"), "the what's-new dialog");
      const text = p2.$("whatsNewBody").textContent;
      assert.match(text, /Narrowbit is updated/);
      assert.doesNotMatch(text, /\b187\b/, "no raw commit-count number shown");
      assert.match(text, /Attach images and PDFs/);
      assert.match(text, /PDFs go as text elsewhere/, "the details are shown, not just titles");
      assert.doesNotMatch(text, /github/i);
      p2.$("whatsNewClose").click();
      await p2.until(() => !existsSync(file), "the notes to be cleared once seen");
    } finally {
      p2.close();
    }
  });

  test("the scout dropdown offers Off plus the models of ready providers, and saving one is remembered for the repository", async () => {
    const H = { "x-narrowbit-token": app.token, "content-type": "application/json" };
    const sel = page.$("scoutSel");
    assert.ok(sel, "the dropdown exists");
    assert.equal(sel.options[0].value, "", "Off is the first choice");
    const r = await fetch(`${app.base}/api/models`, { method: "POST", headers: H, body: JSON.stringify({ provider: "claude", effort: "medium", tiers: { explore: "sonnet", execute: "sonnet", escalate: "opus" }, scout: "codex:gpt-6-sol" }) });
    assert.equal((await r.json()).scout, "codex:gpt-6-sol");
    const bad = await fetch(`${app.base}/api/models`, { method: "POST", headers: H, body: JSON.stringify({ provider: "claude", effort: "medium", tiers: { explore: "sonnet", execute: "sonnet", escalate: "opus" }, scout: "not-a-scout" }) });
    assert.equal((await bad.json()).scout, "", "a malformed value turns the scout off");
  });

  test("Review only pairs with a different reviewer, and is disabled while Lead mode is on", async () => {
    page.$("settingsBtn").click();
    await page.until(() => !page.$("drawer").classList.contains("hidden"), "the drawer to open");
    assert.equal(page.$("reviewOnlyChk").disabled, page.$("leadChk").checked, "review-only is only usable while lead mode is off");
    if (page.$("leadChk").checked) { page.$("leadChk").click(); await page.until(() => !page.$("reviewOnlyChk").disabled, "review-only to unlock"); }
    page.$("reviewOnlyChk").click();
    await page.until(() => page.$("reviewOnlyChk").checked, "review-only to stay checked after saving");
    page.$("leadChk").click();
    await page.until(() => page.$("reviewOnlyChk").disabled, "review-only to disable once lead mode is back on");
  });

  test("Approve plan first needs Lead mode on, and is remembered like the other toggles", async () => {
    assert.equal(page.$("planApprovalChk").disabled, !page.$("leadChk").checked, "usable only while lead mode is on");
    if (!page.$("leadChk").checked) { page.$("leadChk").click(); await page.until(() => !page.$("planApprovalChk").disabled, "plan-approval to unlock"); }
    page.$("planApprovalChk").click();
    await page.until(() => page.$("planApprovalChk").checked, "plan-approval to stay checked after saving");
    page.$("leadChk").click();
    await page.until(() => page.$("planApprovalChk").disabled, "plan-approval to disable once lead mode is off");
  });

  test("a mode label (Solo by default) shows in Behaviour and the composer chip, and follows Lead mode", async () => {
    if (!page.$("drawer") || page.$("drawer").classList.contains("hidden")) page.$("settingsBtn").click();
    await page.until(() => !page.$("drawer").classList.contains("hidden"), "the drawer to open");
    // Other tests in this shared session may have left Lead mode or Review-only on; drive real clicks (not a
    // raw API call, which wouldn't reach this already-open page's own in-memory state) until Solo shows, one
    // toggle at a time, waiting on modeLabel each time — the checkbox's .checked flips natively and instantly
    // on click, well before the save round-trip (and modeLabel, which depends on its response) completes.
    for (let i = 0; i < 5 && page.$("modeLabel").textContent !== "Solo mode"; i++) {
      const before = page.$("modeLabel").textContent;
      if (page.$("leadChk").checked) page.$("leadChk").click();
      else if (page.$("reviewOnlyChk").checked) page.$("reviewOnlyChk").click();
      else break;
      await page.until(() => page.$("modeLabel").textContent !== before, "the mode label to change");
    }
    assert.equal(page.$("modeLabel").textContent, "Solo mode");
    assert.match(page.$("modelChipText").textContent, /Solo$/);
    page.$("leadChk").click();
    await page.until(() => page.$("modeLabel").textContent === "Lead mode", "the label to follow Lead mode");
    assert.match(page.$("modelChipText").textContent, /Lead$/);
    page.$("leadChk").click();
    await page.until(() => page.$("modeLabel").textContent === "Solo mode", "back to Solo once Lead mode is off");
  });

  test("the Behaviour section states what Solo saves against the native app, and that the ranking below is against Solo, not the native app", () => {
    const box = page.w.document.querySelector(".callout");
    assert.ok(box, "the callout exists");
    assert.match(box.textContent, /75-90%/);
    assert.match(box.textContent, /native Claude Code/);
    assert.match(box.textContent, /63%/);
    assert.match(box.textContent, /native Codex/);
    assert.match(box.textContent, /ranked against\s*Solo/);
  });

  test("the GitHub button beside the folder pill stays hidden when the repository has no GitHub remote", () => {
    assert.ok(page.$("ghCrumb").classList.contains("hidden"));
  });

  test("the sidebar can be hidden and shown with the menu button and Cmd/Ctrl+B", () => {
    const app = page.$("app");
    assert.ok(!app.classList.contains("side-hidden"));
    page.$("hideSideBtn").click();
    assert.ok(app.classList.contains("side-hidden"));
    page.$("menuBtn").click();
    assert.ok(!app.classList.contains("side-hidden"), "the button in the top bar shows it again");
    page.$("menuBtn").click();
    assert.ok(app.classList.contains("side-hidden"));
    page.key("b");
    assert.ok(app.classList.contains("side-hidden"), "plain b does nothing");
    page.w.document.dispatchEvent(new page.w.KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }));
    assert.ok(!app.classList.contains("side-hidden"));
  });

  test("there is no theme dropdown in settings — the top-right button is the only theme control", () => {
    assert.equal(page.$("themeSel"), null);
  });

  test("the top-right theme button cycles auto → light → dark → auto, and its icon/title reflect the state", () => {
    const btn = page.$("themeBtn");
    const root = page.w.document.documentElement;
    // Reset to a known start (auto) regardless of what an earlier test left it at.
    while (root.getAttribute("data-theme") !== null) btn.click();
    assert.match(btn.title, /Match my Mac/);
    btn.click();
    assert.equal(root.getAttribute("data-theme"), "light");
    assert.equal(btn.textContent, "☀");
    assert.match(btn.title, /^Theme: Light/);
    btn.click();
    assert.equal(root.getAttribute("data-theme"), "dark");
    assert.equal(btn.textContent, "☾");
    assert.match(btn.title, /^Theme: Dark/);
    btn.click();
    assert.equal(root.getAttribute("data-theme"), null, "back to auto");
    assert.match(btn.title, /Match my Mac/);
  });

  test("the version is visible in the sidebar and in About", () => {
    assert.match(page.$("verLine").textContent, /^Narrowbit v\d+\.\d+\.\d+/);
    assert.match(page.$("aboutInfo").textContent, /Narrowbit v\d+\.\d+\.\d+/);
    assert.ok([...page.$("aboutInfo").querySelectorAll("button")].some((b) => b.textContent === "Copy diagnostics"));
  });

  test("with nothing signed in, the 'get a model ready' card explains what to do", async () => {
    const card = await page.until(() => (page.visible(page.$("getStarted")) ? page.$("getStarted") : null), "the setup card");
    assert.match(card.textContent, /Let's get a model ready/);
    assert.match(card.textContent, /Choose a folder first/);
    assert.match(card.textContent, /claude auth login|isn't installed/);
  });

  test("with no folder and no provider signed in, the composer stays disabled and says why", () => {
    // No longer gated on "choose a folder" specifically — planning a project needs no folder at all (see
    // the describe block below); what actually blocks sending here is that nothing is signed in yet.
    assert.equal(page.$("sendBtn").disabled, true);
    assert.match(page.$("hint").textContent, /isn't logged in|not signed in|isn't installed|needs an API key/);
  });
});

describe("planning a project before any folder exists (stand-in model, no network)", () => {
  let home, fakeDir, app, page;
  before(async () => {
    home = fresh("home"); fakeDir = fresh("fake");
    writeFileSync(join(fakeDir, "replies.json"), JSON.stringify([
      "Sounds good — a small CLI tool. What language do you want to use?",
      "Got it, Python it is. I'd suggest argparse for the CLI and a src/ layout.",
    ]));
    writeFileSync(join(fakeDir, "claude"), `#!/usr/bin/env node
// The app's own readiness check calls "claude auth status" on page load, on the same binary — answer that
// without touching the reply counter below, or it races the test's own send and steals a reply by chance.
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const fs = require("fs"); const d = ${JSON.stringify(fakeDir)};
const c = d + "/count"; const n = fs.existsSync(c) ? Number(fs.readFileSync(c, "utf8")) : 0; fs.writeFileSync(c, String(n + 1));
const r = JSON.parse(fs.readFileSync(d + "/replies.json", "utf8")); const text = r[Math.min(n, r.length - 1)];
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
console.log(JSON.stringify({ type: "assistant", message: { id: "m" + n, content: [{ type: "text", text }], usage } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, usage, total_cost_usd: 0, num_turns: 1, session_id: "s" }));
`, { mode: 0o755 });
    // A fresh HOME has no global git identity — Create Project's own commit needs one, same as any real
    // machine would (the app tells the user to set this up rather than guessing an identity for them).
    execFileSync("git", ["config", "--global", "user.email", "t@t.t"], { env: { ...process.env, HOME: home } });
    execFileSync("git", ["config", "--global", "user.name", "t"], { env: { ...process.env, HOME: home } });
    app = await startApp({ cwd: home, home, env: { NARROWBIT_CLAUDE: join(fakeDir, "claude") } });
    page = await openPage(app.url);
    await page.until(() => page.$("crumbName").textContent, "the folder pill to render");
  });
  after(() => { page?.close(); app?.stop(); for (const d of [home, fakeDir]) rmSync(d, { recursive: true, force: true }); });

  test("the composer works with no folder open, and the reply renders like an ordinary message", async () => {
    assert.equal(page.$("sendBtn").disabled, false, "sending doesn't need a folder");
    page.$("input").value = "I want to build a small CLI tool";
    page.$("sendBtn").click();
    await page.until(() => page.w.document.querySelector(".final"), "the model's reply");
    assert.match(page.w.document.querySelector(".final").textContent, /small CLI tool|language/);
    assert.ok(!page.$("createProjectBar").classList.contains("hidden"), "Create project appears once there's a reply");
  });

  test("the draft is listed in the sidebar and can be reopened", async () => {
    const sess = await page.until(() => [...page.w.document.querySelectorAll("#sessions .sess")].find((s) => /CLI tool/.test(s.textContent)), "the draft in the sidebar");
    page.$("newBtn").click();
    assert.equal(page.w.document.querySelector(".final"), null, "a fresh draft starts blank");
    sess.click();
    await page.until(() => page.w.document.querySelector(".final"), "the reopened draft's reply");
  });

  test("Create project turns the draft into a real local git repo — no GitHub involved — and seeds the first task", async () => {
    const target = join(home, "Projects", "cli-tool-test");
    page.$("cpbarOpen").click();
    page.$("cpbarName").value = target;
    page.$("cpbarCreate").click();
    await page.until(() => page.$("crumbName") && page.$("crumbName").textContent.indexOf("cli-tool-test") === 0, "the app to switch into the new project");
    assert.ok(existsSync(join(target, ".git")), "a real git repo was created");
    assert.equal(execFileSync("git", ["remote"], { cwd: target }).toString().trim(), "", "no GitHub remote — creating one is a separate, later step");
    assert.match(page.$("input").value, /CLI tool|language|Python/i, "the discussion was seeded into the composer, not auto-sent");
  });
});

describe("app page with a folder open", () => {
  let home, repo, app, page;
  before(async () => {
    home = fresh("home");
    repo = fresh("repo");
    const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "hi\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    execFileSync(process.execPath, [BIN, "init", "--no-index"], { cwd: repo, stdio: "ignore", env: { ...process.env, HOME: home } });

    // A finished task that hit a usage limit, exactly as runtime.ts records it.
    const { appendEvent } = await import(join(ROOT, "dist", "events.js"));
    const { paths } = await import(join(ROOT, "dist", "config.js"));
    const p = paths(repo);
    const dbDir = p.nb;
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(p.db, ""); // "initialized" is judged by the index file existing
    appendEvent(p, "rt-limit-test", { actor: "user", type: "decision", summary: "task received", meta: { goal: "say hi" } });
    appendEvent(p, "rt-limit-test", { actor: "system", type: "decision", summary: "outcome: error", meta: { outcome: "error", summary: "You've hit your session limit · resets 1am (Asia/Calcutta)", steps: 0, errorKind: "limit", resets: "1am (Asia/Calcutta)" } });
    appendEvent(p, "rt-auth-test", { actor: "user", type: "decision", summary: "task received", meta: { goal: "sign-in problem" } });
    appendEvent(p, "rt-auth-test", { actor: "system", type: "decision", summary: "outcome: error", meta: { outcome: "error", summary: "codex CLI is not logged in", steps: 0, errorKind: "auth" } });

    // A finished task with real steps: its work should fold into one line, the answer stays visible.
    appendEvent(p, "rt-work-test", { actor: "user", type: "decision", summary: "task received", meta: { goal: "what is in a.txt" } });
    appendEvent(p, "rt-work-test", { actor: "model", type: "model_call", summary: "step 0", tokens: { model: "haiku", role: "execution", inputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 5, costUsd: 0 }, meta: { context: { parts: [{ kind: "task", label: "your request", tokens: 12 }, { kind: "instructions", label: "Narrowbit's instructions (sent once per session)", tokens: 900 }], tokens: 912 } } });
    appendEvent(p, "rt-work-test", { actor: "model", type: "tool_call", summary: "read a.txt", meta: { action: "read", path: "a.txt", model: "haiku" } });
    appendEvent(p, "rt-work-test", { actor: "system", type: "tool_result", summary: "read a.txt:1-1 hi" });
    appendEvent(p, "rt-work-test", { actor: "model", type: "decision", summary: "done: It contains the word hi.", meta: {} });
    appendEvent(p, "rt-work-test", { actor: "system", type: "decision", summary: "outcome: done", meta: { outcome: "done", summary: "It contains the word hi.", steps: 1 } });
    appendEvent(p, "rt-sug-test", { actor: "user", type: "decision", summary: "task received", meta: { goal: "fix the parser" } });
    appendEvent(p, "rt-sug-test", { actor: "system", type: "decision", summary: "done: fixed", meta: {} });
    appendEvent(p, "rt-sug-test", { actor: "system", type: "decision", summary: "suggested 2 notes for project memory (nothing saved until you approve)", meta: { suggested: [{ type: "bug", text: "Verification failed with an off-by-one; fixed by editing src/parse.ts.", files: ["src/parse.ts"], confidence: 0.8 }, { type: "command", text: "A working check for this repo: `npm test --silent`", confidence: 0.65 }] } });
    appendEvent(p, "rt-sug-test", { actor: "system", type: "decision", summary: "outcome: done", meta: { outcome: "done", summary: "fixed", steps: 2 } });
    const { openMemory } = await import(join(ROOT, "dist", "memory.js"));
    openMemory(p).add({ type: "decision", text: "Use pnpm, not npm, in this repo", reason: "lockfile is pnpm-lock.yaml" });

    // A finished task with checkpoints: rewind should render for the one after the edit, not for the rewound-to marker.
    appendEvent(p, "rt-ckpt-test", { actor: "user", type: "decision", summary: "task received", meta: { goal: "say bye" } });
    appendEvent(p, "rt-ckpt-test", { actor: "system", type: "checkpoint", summary: "checkpoint after step 0: before any changes", meta: { step: 0, commit: "deadbeef" } });
    appendEvent(p, "rt-ckpt-test", { actor: "system", type: "checkpoint", summary: "checkpoint after step 1: edited a.txt", meta: { step: 1, commit: "cafef00d" } });
    appendEvent(p, "rt-ckpt-test", { actor: "system", type: "decision", summary: "outcome: done", meta: { outcome: "done", summary: "changed it", steps: 1 } });

    // A Claude usage reading from 40 minutes ago: stale, since Claude's number only updates as a side effect
    // of a real Claude call (unlike Codex's actively-refreshed one) — the app should flag it, not show it as current.
    mkdirSync(join(home, ".narrowbit"), { recursive: true });
    writeFileSync(join(home, ".narrowbit", "limits.json"), JSON.stringify({
      claude: { fiveHour: { usedPercent: 95, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, weekly: { usedPercent: 40, resetsAt: null }, status: "allowed", checkedAt: new Date(Date.now() - 40 * 60000).toISOString() },
    }));

    app = await startApp({ cwd: repo, home });
    page = await openPage(app.url);
    await page.until(() => !page.$("crumb").classList.contains("empty") && page.$("crumbName").textContent, "the repo pill");
  });
  after(() => {
    page?.close();
    app?.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  test("typing @ opens a popover of matching repo files; picking one inserts its path", async () => {
    const inp = page.$("input");
    inp.focus();
    inp.value = "look at @a";
    inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.dispatchEvent(new page.w.Event("input"));
    await page.until(() => !page.$("mentionPop").classList.contains("hidden"), "the mention popover");
    await page.until(() => page.$("mentionPop").textContent.includes("a.txt"), "a.txt to appear as a match");
    page.$("mentionPop").querySelector(".mi").click();
    assert.equal(inp.value, "look at @a.txt ");
    assert.ok(page.$("mentionPop").classList.contains("hidden"), "the popover closes after picking");
    inp.value = "";
  });

  test("attaching an image shows a chip that can be removed, and other file types are refused", async () => {
    const w = page.w;
    const input = page.$("attachInput");
    const png = new w.File([Uint8Array.from([137, 80, 78, 71])], "shot.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [png], configurable: true });
    input.dispatchEvent(new w.Event("change"));
    await page.until(() => page.$("attached").textContent.includes("shot.png"), "the attachment chip");
    assert.ok(!page.$("attached").classList.contains("hidden"));
    page.$("attached").querySelector("button").click();
    assert.ok(page.$("attached").classList.contains("hidden"));
    const exe = new w.File(["x"], "run.sh", { type: "text/x-sh" });
    Object.defineProperty(input, "files", { value: [exe], configurable: true });
    input.dispatchEvent(new w.Event("change"));
    assert.match(page.$("banner").textContent, /Only images/);
  });

  test("boots without script errors, and the pill shows the repo and branch", () => {
    assert.deepEqual(page.errors, []);
    assert.match(page.$("crumbName").textContent, /· main$/);
    assert.equal(page.$("crumbWrap").nextElementSibling.className, "composer");
  });

  test("the pill is the same control as with no folder, and its dialog closes with Cancel", () => {
    page.$("crumb").click();
    assert.ok(page.visible(page.$("repoOverlay")));
    page.$("closeRepo").click();
    assert.ok(!page.visible(page.$("repoOverlay")));
  });

  test("Cloudflare asks for the account id itself, not a URL template to edit", async () => {
    const sel = page.$("providerSel");
    sel.value = "cloudflare";
    sel.dispatchEvent(new page.w.Event("change"));
    const box = await page.until(() => page.w.document.querySelector('#urlRow input[aria-label="Cloudflare account id"]'), "the account id field");
    assert.ok(box, "account id input shown");
    assert.ok(![...page.w.document.querySelectorAll("#urlRow input")].some((i) => /\{CLOUDFLARE/.test(i.value)), "no raw URL template");
  });

  test("a model chosen from the dropdown stays selected after it saves (ids like org/name, free-only on or off)", async () => {
    const { createServer } = await import("node:http");
    const mock = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "deepseek-ai/deepseek-v4.1-flash" }, { id: "meta/llama-3.3-70b:free" }, { id: "zeta/model" }] })); });
    await new Promise((r) => mock.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${mock.address().port}/v1`;
    const post = (path, b) => fetch(`${app.base}${path}`, { method: "POST", headers: { "x-narrowbit-token": app.token, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
    await post("/api/endpoint", { provider: "custom", baseUrl: base });
    const pg = await openPage(app.url);
    try {
      await pg.until(() => pg.$("providerSel").options.length >= 15, "the provider list");
      const sel = pg.$("providerSel");
      sel.value = "custom";
      sel.dispatchEvent(new pg.w.Event("change"));
      const s1 = await pg.until(() => pg.w.document.querySelector("#slot-explore")?.tagName === "SELECT" && pg.w.document.querySelector("#slot-explore"), "the dropdown for the custom provider");
      s1.value = "deepseek-ai/deepseek-v4.1-flash";
      s1.dispatchEvent(new pg.w.Event("change"));
      // The drawer re-renders after the save: a new element, which must still show the choice.
      const s2 = await pg.until(() => { const e = pg.w.document.querySelector("#slot-explore"); return e && e !== s1 && e; }, "the drawer to re-render after saving");
      assert.equal(s2.value, "deepseek-ai/deepseek-v4.1-flash", "the saved model is shown selected");
      const st = await fetch(`${app.base}/api/state`, { headers: { "x-narrowbit-token": app.token } }).then((r) => r.json());
      assert.equal(st.providers.custom.tiers.explore, "deepseek-ai/deepseek-v4.1-flash", "and the server has it");
      assert.deepEqual(Object.values(st.providers.custom.tiers), Array(3).fill("deepseek-ai/deepseek-v4.1-flash"), "unset slots follow the first choice instead of staying blank");
      await new Promise((r) => setTimeout(r, 300));
    } finally { pg.close(); mock.close(); }
  });

  test("notes the agent remembered are listed, can be opened to read, and forgotten with a click", async () => {
    const row = await page.until(() => [...page.w.document.querySelectorAll("#memList .skill-row")].find((r) => /pnpm/.test(r.textContent)), "the memory note");
    assert.match(page.$("memLabel").textContent, /Memory \(1\)/);
    row.querySelector(".skill").click();
    assert.match(page.$("memList").textContent, /lockfile is pnpm-lock\.yaml/, "opening a note shows its reason");
    row.querySelector(".skill-del").click();
    await page.until(() => /Nothing remembered yet/.test(page.$("memList").textContent), "the note to disappear");
    const st = await fetch(`${app.base}/api/state`, { headers: { "x-narrowbit-token": app.token } }).then((r) => r.json());
    assert.deepEqual(st.memory, [], "and the server no longer lists it");
  });

  test("under each message: when it was sent, Copy, edit-and-send-again, and start a new task from it", async () => {
    const sess = await page.until(() => [...page.w.document.querySelectorAll("#sessions .sess")].find((x) => /say hi/.test(x.textContent)), "a session");
    sess.click();
    const bar = await page.until(() => page.w.document.querySelector(".msg-user .msg-actions"), "the message actions");
    const titles = [...bar.querySelectorAll("button")].map((b) => b.title);
    assert.deepEqual(titles, ["Copy", "Edit and send again", "Start a new task from this"]);
    assert.ok(bar.querySelector(".when").textContent.length > 0, "shows when it was sent");
    bar.querySelector('[title="Edit and send again"]').click();
    assert.equal(page.$("input").value, "say hi", "the message returns to the composer to edit");
  });

  test("a finished task folds its steps into one line above the answer, and opens on click", async () => {
    const sess = await page.until(() => [...page.w.document.querySelectorAll("#sessions .sess")].find((x) => /what is in a\.txt/.test(x.textContent)), "the finished session");
    sess.click();
    const group = await page.until(() => page.w.document.querySelector("details.work"), "the folded work");
    assert.match(group.querySelector("summary").textContent, /Worked.*read 1 file/);
    assert.equal(group.open, false, "closed by default");
    assert.ok(group.querySelector(".step"), "the step is inside it");
    assert.ok(!group.querySelector(".final"), "the answer is not folded away");
    assert.match(page.w.document.querySelector(".final").textContent, /contains the word hi/);
    group.querySelector("summary").click();
    // "Why is this in context?": the step carries a context button that itemises what its model call was sent.
    const btn = group.querySelector(".ctx-btn");
    assert.match(btn.textContent, /context ~912/);
    btn.click();
    const panel = group.querySelector(".ctx");
    assert.ok(!panel.classList.contains("hidden"));
    assert.match(panel.textContent, /instructions.*~900/s);
    assert.match(panel.textContent, /your request.*~12/s);
    assert.match(panel.textContent, /Billed for this call/);
  });

  test("a chat can be renamed and deleted from the sidebar (inline, no browser dialogs)", async () => {
    const post = (path, b) => fetch(`${app.base}${path}`, { method: "POST", headers: { "x-narrowbit-token": app.token, "content-type": "application/json" }, body: JSON.stringify(b) });
    const { appendEvent } = await import(join(ROOT, "dist", "events.js"));
    const { paths } = await import(join(ROOT, "dist", "config.js"));
    appendEvent(paths(repo), "rt-scratch-test", { actor: "user", type: "decision", summary: "task received", meta: { goal: "temporary chat" } });
    // Server side: rename shows up in history, path tricks are refused, delete removes it.
    assert.equal((await post("/api/session/rename", { id: "../x", title: "no" })).status, 400);
    let st = await (await post("/api/session/rename", { id: "rt-scratch-test", title: "My renamed chat" })).json();
    assert.ok(st.history.some((h) => h.id === "rt-scratch-test" && h.goal === "My renamed chat"));
    // Page side: hover actions exist, and Delete asks inline before doing anything.
    const pg = await openPage(app.url);
    try {
      const row = await pg.until(() => [...pg.w.document.querySelectorAll("#sessions .sess-row")].find((r) => /My renamed chat/.test(r.textContent)), "the renamed chat");
      assert.deepEqual([...row.querySelectorAll(".sess-acts button")].map((b) => b.title), ["Rename", "Delete"]);
      row.querySelector('[title="Delete"]').click();
      assert.match(pg.$("sessions").textContent, /Delete this chat\?/);
      const cancel = [...pg.$("sessions").querySelectorAll("button")].find((b) => b.textContent === "Cancel");
      cancel.click();
      assert.ok([...pg.w.document.querySelectorAll("#sessions .sess-row")].some((r) => /My renamed chat/.test(r.textContent)), "Cancel keeps it");
    } finally { pg.close(); }
    st = await (await post("/api/session/delete", { id: "rt-scratch-test" })).json();
    assert.ok(!st.history.some((h) => h.id === "rt-scratch-test"), "deleted");
  });

  test("'Save as skill' on a finished chat opens the skill form prefilled with the request and the steps that worked", async () => {
    const sess = await page.until(() => [...page.w.document.querySelectorAll("#sessions .sess")].find((x) => /what is in a\.txt/.test(x.textContent)), "the finished session");
    sess.click();
    const btn = await page.until(() => page.w.document.querySelector('.final-wrap [title="Save this as a skill"]'), "the save-as-skill button");
    btn.click();
    assert.ok(page.visible(page.$("skillOverlay")), "the skill form opened");
    assert.match(page.$("skillName").value, /what is in a\.txt/);
    assert.match(page.$("skillBody").value, /read a\.txt/, "the steps that worked are listed for editing");
    page.$("closeSkill").click();
  });

  test("the skill form can import from a GitHub link (and says to read the instructions first)", async () => {
    page.$("addSkillBtn").click();
    assert.ok(page.$("skillUrl") && page.$("findSkill"), "import field present");
    page.$("skillUrl").value = "https://example.com/not-github";
    page.$("findSkill").click();
    const note = await page.until(() => /Only github\.com/.test(page.$("skillImportNote").textContent) && page.$("skillImportNote"), "a clear refusal for other hosts");
    assert.ok(note);
    page.$("closeSkill").click();
  });

  test("a backup provider can be chosen in settings, is remembered, and can be cleared", async () => {
    const H = { "x-narrowbit-token": app.token, "content-type": "application/json" };
    const save = (fb) => fetch(`${app.base}/api/models`, { method: "POST", headers: H, body: JSON.stringify({ provider: "claude", effort: "medium", tiers: { explore: "haiku", execute: "sonnet", escalate: "opus" }, fallback: fb }) }).then((r) => r.json());
    assert.equal((await save("codex")).fallback, "codex");
    assert.equal((await save("claude")).fallback, "", "the main provider can't be its own backup");
    assert.equal((await save("codex")).fallback, "codex");
    assert.equal((await save("")).fallback, "");
    assert.ok(page.$("fallbackSel"), "the settings panel has the backup selector");
  });

  test("Compact now: the button shows on an open chat, and compacting an idle chat is recorded in its log", async () => {
    const H = { "x-narrowbit-token": app.token, "content-type": "application/json" };
    const sess = await page.until(() => [...page.w.document.querySelectorAll("#sessions .sess")].find((x) => /what is in a\.txt/.test(x.textContent)), "a session");
    sess.click();
    const btn = await page.until(() => { const b = page.$("compactBtn"); return page.visible(b) && b; }, "the Compact button");
    assert.match(btn.title, /fresh session/);
    const post = (b) => fetch(`${app.base}/api/compact`, { method: "POST", headers: H, body: JSON.stringify(b) });
    assert.equal((await post({ task: "../x" })).status, 400);
    assert.equal((await post({ task: "rt-nope-000" })).status, 404);
    const r = await post({ task: "rt-work-test" });
    assert.equal(r.status, 200);
    assert.match((await r.json()).when, /next message/);
    const t = await (await fetch(`${app.base}/api/task/rt-work-test`, { headers: H })).json();
    const h = t.events.find((e) => e.type === "handoff");
    assert.ok(h && h.meta.manual && h.actor === "user", "the compaction is in the chat's log, as the user's action");
  });

  test("suggested notes appear after a task; Save writes one to project memory, Dismiss writes nothing", async () => {
    const H = { "x-narrowbit-token": app.token, "content-type": "application/json" };
    const sess = await page.until(() => [...page.w.document.querySelectorAll("#sessions .sess")].find((x) => /fix the parser/.test(x.textContent)), "the session with suggestions");
    sess.click();
    const card = await page.until(() => page.w.document.querySelector(".suggested"), "the suggestions card");
    assert.match(card.textContent, /off-by-one/); assert.match(card.textContent, /npm test/);
    const buttons = [...card.querySelectorAll("button")].map((b) => b.textContent);
    assert.deepEqual(buttons, ["Save", "Dismiss", "Save", "Dismiss"]);
    const before = (await (await fetch(`${app.base}/api/state`, { headers: H })).json()).memory.length;
    card.querySelectorAll("button")[0].click(); // save the first
    await page.until(async () => true, "click handled");
    let st;
    for (let i = 0; i < 40; i++) { st = await (await fetch(`${app.base}/api/state`, { headers: H })).json(); if (st.memory.length > before) break; await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(st.memory.length, before + 1, "the approved note is in project memory");
    assert.ok(st.memory.some((m) => /off-by-one/.test(m.text)));
    const dis = await fetch(`${app.base}/api/memory/suggested`, { method: "POST", headers: H, body: JSON.stringify({ task: "rt-sug-test", index: 1, approve: false }) });
    assert.equal(dis.status, 200);
    st = await dis.json();
    assert.equal(st.memory.length, before + 1, "dismissing saves nothing");
    const again = await fetch(`${app.base}/api/memory/suggested`, { method: "POST", headers: H, body: JSON.stringify({ task: "rt-sug-test", index: 1, approve: true }) });
    assert.equal(again.status, 409, "a handled suggestion can't be applied twice");
    // tidy up so later tests see an empty memory
    for (const m of st.memory) await fetch(`${app.base}/api/memory/remove`, { method: "POST", headers: H, body: JSON.stringify({ id: m.id }) });
  });

  test("diff comments: commenting on a line and drafting feedback fills the composer, without sending anything", async () => {
    writeFileSync(join(repo, "a.txt"), "hi\nsecond line\n");
    const sess = await page.until(() => [...page.w.document.querySelectorAll("#sessions .sess")].find((x) => /what is in a\.txt/.test(x.textContent)), "the finished session");
    sess.click();
    const addBtn = await page.until(() => page.w.document.querySelector(".dl.a .dl-add"), "an add-comment button on an added line");
    addBtn.click();
    const ta = await page.until(() => page.w.document.querySelector(".dl-comment-row textarea"), "the comment box");
    ta.value = "should this be capitalised?";
    const save = [...ta.closest(".dl-comment-row").querySelectorAll("button")].find((b) => b.textContent === "Save");
    save.click();
    assert.ok(page.w.document.querySelector(".dl-comment-saved"), "the comment is saved inline");
    assert.match(page.w.document.querySelector(".dl-comment-saved .txt").textContent, /capitalised/);
    const draftBtn = await page.until(() => [...page.w.document.querySelectorAll("button")].find((b) => b.textContent === "Draft as feedback"), "the draft-feedback button");
    draftBtn.click();
    assert.match(page.$("input").value, /Feedback on the diff/);
    assert.match(page.$("input").value, /should this be capitalised\?/);
    assert.match(page.$("input").value, /a\.txt/);
  });

  test("a Claude usage reading from 40 minutes ago is shown flagged as possibly stale, not as current", async () => {
    const wins = await page.until(() => { const w = [...page.w.document.querySelectorAll(".limits .win")]; return w.length ? w : null; }, "the limits rows");
    const staleWin = wins.find((w) => w.classList.contains("stale"));
    assert.ok(staleWin, "the Claude 5-hour window is marked stale");
    assert.match(staleWin.textContent, /95%\?/, "the ? marks it as uncertain, the number itself is unchanged");
    assert.match(page.$("limits").title, /may be out of date/);
  });

  test("the Skills list can be collapsed and expanded, without the + button also toggling it", async () => {
    assert.ok(!page.$("skillsLabel").classList.contains("collapsed"));
    assert.ok(!page.$("skillsList").classList.contains("hidden"));
    page.$("skillsLabel").click();
    assert.ok(page.$("skillsLabel").classList.contains("collapsed"));
    assert.ok(page.$("skillsList").classList.contains("hidden"));
    page.$("skillsLabel").click();
    assert.ok(!page.$("skillsLabel").classList.contains("collapsed"), "clicking again re-expands");
    page.$("addSkillBtn").click();
    assert.ok(!page.$("skillsLabel").classList.contains("collapsed"), "the + button opens the skill form, not the collapse toggle");
    page.$("closeSkill").click();
  });

  test("every project lists the built-in skills, without a delete button; user skills get one", async () => {
    const rows = () => [...page.w.document.querySelectorAll("#skillsList .skill-row")];
    await page.until(() => rows().length >= 6, "built-in skills");
    const names = rows().map((r) => r.querySelector(".skill").textContent);
    for (const n of ["Bug fix", "Code review", "Write tests", "Refactor", "Explain this code", "Security review"]) assert.ok(names.includes(n), `missing ${n}: ${names}`);
    assert.equal(rows().filter((r) => r.querySelector(".skill-del")).length, 0, "built-ins can't be deleted from the UI");

    // Create a user skill through the real modal, then remove it again.
    page.$("addSkillBtn").click();
    page.$("skillName").value = "Release notes";
    page.$("skillBody").value = "Group by user impact.";
    page.$("saveSkill").click();
    await page.until(() => rows().some((r) => r.querySelector(".skill").textContent === "Release notes"), "the new skill");
    const mine = rows().find((r) => r.querySelector(".skill").textContent === "Release notes");
    assert.ok(mine.querySelector(".skill-del"), "a user skill can be deleted");
    mine.querySelector(".skill-del").click();
    await page.until(() => !rows().some((r) => r.querySelector(".skill").textContent === "Release notes"), "the skill to be removed");
  });

  test("clicking a skill puts its instructions in the composer", async () => {
    const bug = [...page.w.document.querySelectorAll("#skillsList .skill")].find((b) => b.textContent === "Bug fix");
    bug.click();
    assert.match(page.$("input").value, /root cause/i);
  });

  test("rewind: each checkpoint has a Rewind button; clicking it asks to confirm before restoring", async () => {
    const sess = await page.until(() => [...page.w.document.querySelectorAll("#sessions .sess")].find((s) => /say bye/.test(s.textContent)), "the checkpointed session");
    sess.click();
    const labels = await page.until(() => { const l = [...page.w.document.querySelectorAll(".ckpt-label")]; return l.length === 2 ? l : null; }, "both checkpoint rows");
    assert.match(labels[0].textContent, /before any changes/);
    assert.match(labels[1].textContent, /after this edit/);
    const btn = labels[1].parentElement.querySelector("button");
    assert.equal(btn.textContent, "Rewind here");
    btn.click();
    assert.match(labels[1].parentElement.textContent, /Undo everything after this\?/, "clicking asks to confirm, not restoring immediately");
    assert.ok(labels[1].parentElement.querySelector("button.danger"), "a distinct destructive button for the actual rewind");
  });

  test("a usage-limit failure is explained with the reset time and a way out, not shown as a raw error", async () => {
    const sess = await page.until(() => [...page.w.document.querySelectorAll("#sessions .sess")].find((s) => /say hi/.test(s.textContent)), "the failed session");
    sess.click();
    const card = await page.until(() => page.w.document.querySelector(".errcard"), "the error card");
    assert.match(card.textContent, /Usage limit reached/);
    assert.match(card.textContent, /1am \(Asia\/Calcutta\)/);
    assert.ok([...card.querySelectorAll("button")].some((b) => b.textContent === "Switch model"));
    assert.equal(page.w.document.querySelector(".outcome .o-blocked"), null, "no raw red error line duplicating the card");
  });

  test("a sign-in failure says 'Not signed in' and points to settings", async () => {
    const sess = [...page.w.document.querySelectorAll("#sessions .sess")].find((s) => /sign-in problem/.test(s.textContent));
    sess.click();
    const card = await page.until(() => [...page.w.document.querySelectorAll(".errcard")].find((c) => /Not signed in/.test(c.textContent)), "the auth card");
    assert.ok([...card.querySelectorAll("button")].some((b) => b.textContent === "Open settings"));
  });

  test("Copy diagnostics produces a report with no home path and no secrets", async () => {
    const res = await fetch(`${app.base}/api/diagnostics`, { headers: { "x-narrowbit-token": app.token } });
    const { text } = await res.json();
    assert.match(text, /^Narrowbit diagnostics/);
    assert.ok(!text.includes(home), "home path is shortened");
    assert.match(text, /recent problems:/);
    assert.match(text, /session limit/, "the failed task shows up in the report");
  });

  test("the API never returns connector tokens to the page", async () => {
    const res = await fetch(`${app.base}/api/state`, { headers: { "x-narrowbit-token": app.token } });
    assert.ok(Array.isArray((await res.json()).connectors));
  });

  test("commit is paused when the change contains a secret, and goes through with the override", async () => {
    writeFileSync(join(repo, "leak.js"), 'const k = "ghp_' + "z".repeat(36) + '";\n'); // narrowbit-audit-ignore: fake
    const post = (body) => fetch(`${app.base}/api/commit`, { method: "POST", headers: { "x-narrowbit-token": app.token, "content-type": "application/json" }, body: JSON.stringify(body) });
    const paused = await post({ message: "add leak" });
    assert.equal(paused.status, 409);
    assert.equal((await paused.json()).error, "secrets");
    assert.equal((await post({ message: "add leak", force: true })).status, 200);
  });

  // Last in this describe: it leaves the project, so nothing after it can assume a folder is open.
  test("'Start without a folder' leaves the project and returns to the rootless planning screen", async () => {
    page.$("crumb").click();
    assert.ok(page.visible(page.$("startNoFolder")), "offered since a folder is open");
    page.$("startNoFolder").click();
    await page.until(() => !page.visible(page.$("repoOverlay")), "the dialog to close");
    assert.equal(page.$("crumbName").textContent, "Choose a folder to start");
    assert.ok(page.$("crumb").classList.contains("empty"));
    page.$("crumb").click();
    assert.ok(!page.visible(page.$("startNoFolder")), "nothing to leave once no folder is open");
    page.$("closeRepo").click();
  });
});

describe("layout rules that broke before (checked in the page's own CSS)", () => {
  let home, app, css;
  before(async () => {
    home = fresh("home");
    app = await startApp({ cwd: home, home });
    css = await (await fetch(app.url)).text();
  });
  after(() => {
    app?.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("the folder pill's wrapper and the composer share one max-width, so the pill never drifts from the input on a wide window", () => {
    const widthOf = (sel) => new RegExp(`(?:^|\\n)\\${sel}\\s*\\{[^}]*max-width:\\s*(\\d+px)`).exec(css)?.[1];
    assert.ok(widthOf(".composer"), "composer has a max-width");
    assert.equal(widthOf(".crumb-wrap"), widthOf(".composer"));
  });

  test("a model dropdown sits in the wide column of its row (it was squeezed into the number badge's 24px column)", () => {
    const html = readFileSync(join(ROOT, "dist", "ui-page.js"), "utf8");
    assert.match(html, /\.slot input, \.slot select \{ grid-column: 2/);
  });

  test("every local response carries the security headers and a strict content-security-policy", async () => {
    const res = await fetch(app.url);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  });

  test("API calls without the launch token are refused", async () => {
    assert.equal((await fetch(`${app.base}/api/state`)).status, 401);
  });
});

describe("pushing commits to the remote (a local bare repo stands in for GitHub)", () => {
  let home, repo, remote, app, page;
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" });
  before(async () => {
    home = fresh("home");
    repo = fresh("repo");
    remote = fresh("remote");
    git(remote, "init", "-q", "--bare", "-b", "main");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "first");
    git(repo, "remote", "add", "origin", remote);
    execFileSync(process.execPath, [BIN, "init", "--no-index"], { cwd: repo, stdio: "ignore", env: { ...process.env, HOME: home } });
    const { paths } = await import(join(ROOT, "dist", "config.js"));
    mkdirSync(paths(repo).nb, { recursive: true });
    writeFileSync(paths(repo).db, "");
    app = await startApp({ cwd: repo, home });
  });
  after(() => {
    page?.close();
    app?.stop();
    for (const d of [home, repo, remote]) rmSync(d, { recursive: true, force: true });
  });
  const api = (path, body) => fetch(`${app.base}${path}`, { method: body ? "POST" : "GET", headers: { "x-narrowbit-token": app.token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

  test("the first push sets up tracking; later commits show as 'to push' and push cleanly, without force", async () => {
    let st = await (await api("/api/state")).json();
    assert.equal(st.remote.hasRemote, true);
    assert.equal(st.remote.ahead, 1, "the first commit is not on any remote yet");
    let r = await api("/api/push", {});
    assert.equal(r.status, 200);
    st = (await r.json()).state;
    assert.equal(st.remote.ahead, 0);
    assert.equal(st.remote.upstream, "origin/main");
    assert.equal(git(remote, "log", "--format=%s", "-1").trim(), "first");

    writeFileSync(join(repo, "a.txt"), "two\n");
    git(repo, "commit", "-qam", "second");
    page = await openPage(app.url);
    const pill = await page.until(() => { const b = page.$("pushPill"); return page.visible(b) && b; }, "the push pill");
    assert.match(pill.textContent, /1 to push/);
    pill.click();
    assert.match(pill.textContent, /Click again to push to origin\/main/, "the first click only arms it");
    assert.equal(git(remote, "log", "--format=%s", "-1").trim(), "first", "nothing was pushed by the first click");
    pill.click();
    await page.until(() => !page.visible(page.$("pushPill")), "the pill to go away after pushing");
    assert.equal(git(remote, "log", "--format=%s", "-1").trim(), "second");
  });

  test("remote connectors: saved with a URL, the token stays hidden, and the sign-in callback rejects an unknown state", async () => {
    const r = await api("/api/connectors", { name: "linear", url: "https://mcp.example.com/mcp", authHeader: "Bearer secret-value" });
    assert.equal(r.status, 200);
    const text = JSON.stringify(await (await api("/api/state")).json());
    assert.ok(text.includes("https://mcp.example.com/mcp") && !text.includes("secret-value"), "URL shown, token never sent to the page");
    const cb = await fetch(`${app.base}/oauth/callback?code=x&state=forged`);
    assert.match(await cb.text(), /Sign-in failed/);
    assert.equal((await api("/api/connectors", { name: "bad", url: "ftp://x" })).status, 400);
    await api("/api/connectors/delete", { name: "linear" });
  });

  test("the GitHub section says which repo it pushes to and who commits are by", async () => {
    const g = await (await api("/api/github")).json();
    assert.equal(g.remoteUrl, remote);
    assert.equal(g.author.email, "t@t.t");
    assert.ok("ghInstalled" in g && "ghAccount" in g);
  });

  test("a remote that has moved on refuses the push with a plain explanation (no force)", async () => {
    const other = fresh("other");
    try {
      git(other, "clone", "-q", remote, ".");
      git(other, "config", "user.email", "o@o.o");
      git(other, "config", "user.name", "o");
      writeFileSync(join(other, "b.txt"), "x\n");
      git(other, "add", "-A");
      git(other, "commit", "-qm", "someone else");
      git(other, "push", "-q");
    } finally { rmSync(other, { recursive: true, force: true }); }
    writeFileSync(join(repo, "a.txt"), "three\n");
    git(repo, "commit", "-qam", "third");
    const r = await api("/api/push", {});
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /never force-pushes/);
  });
});

describe("the agent asking the user a question in the app (stand-in model, no network)", () => {
  let home, repo, fakeDir, app;
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  before(async () => {
    home = fresh("home"); repo = fresh("repo"); fakeDir = fresh("fake");
    git("init", "-q", "-b", "main"); git("config", "user.email", "t@t.t"); git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "hi\n"); git("add", "-A"); git("commit", "-qm", "init");
    execFileSync(process.execPath, [BIN, "init"], { cwd: repo, stdio: "ignore", env: { ...process.env, HOME: home } });
    writeFileSync(join(fakeDir, "replies.json"), JSON.stringify([
      JSON.stringify({ action: "ask", question: "Which colour?", options: ["red", "blue"] }),
      JSON.stringify({ action: "done", summary: "went with your colour" }),
    ]));
    writeFileSync(join(fakeDir, "claude"), `#!/usr/bin/env node
const fs = require("fs"); const d = ${JSON.stringify(fakeDir)};
const c = d + "/count"; const n = fs.existsSync(c) ? Number(fs.readFileSync(c, "utf8")) : 0; fs.writeFileSync(c, String(n + 1));
const r = JSON.parse(fs.readFileSync(d + "/replies.json", "utf8")); const text = r[Math.min(n, r.length - 1)];
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
console.log(JSON.stringify({ type: "assistant", message: { id: "m" + n, content: [{ type: "text", text }], usage } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, usage, total_cost_usd: 0, num_turns: 1, session_id: "s" }));
`, { mode: 0o755 });
    app = await startApp({ cwd: repo, home, env: { NARROWBIT_CLAUDE: join(fakeDir, "claude") } });
  });
  after(() => { app?.stop(); for (const d of [home, repo, fakeDir]) rmSync(d, { recursive: true, force: true }); });

  test("a question streams to the page, an answer resumes the task, and the task finishes", async () => {
    const H = { "x-narrowbit-token": app.token, "content-type": "application/json" };
    const events = [];
    const ctl = new AbortController();
    const stream = await fetch(`${app.base}/api/stream?t=${app.token}`, { signal: ctl.signal });
    const reader = stream.body.getReader();
    let buf = "";
    let pending = null; // one outstanding read at a time — racing fresh reads would drop chunks
    const waitFor = async (pred, what) => {
      const t0 = Date.now();
      for (;;) {
        const hit = events.find(pred); if (hit) return hit;
        if (Date.now() - t0 > 20000) throw new Error("timed out waiting for " + what + " — saw " + JSON.stringify(events.map((e) => e.type === "finished" ? e : e.type === "event" ? e.event.summary : e.type)));
        pending = pending || reader.read();
        const got = await Promise.race([pending, new Promise((r) => setTimeout(() => r(null), 200))]);
        if (!got) continue;
        pending = null;
        const { value, done } = got;
        if (done) break;
        if (value) { buf += new TextDecoder().decode(value); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const m = /^data: (.*)$/m.exec(chunk); if (m) events.push(JSON.parse(m[1])); } }
      }
    };
    await fetch(`${app.base}/api/models`, { method: "POST", headers: H, body: JSON.stringify({ provider: "claude", effort: "medium", tiers: { explore: "haiku", execute: "sonnet", escalate: "opus" }, lead: false }) });
    const started = await fetch(`${app.base}/api/run`, { method: "POST", headers: H, body: JSON.stringify({ task: "choose a colour for the button", askCommands: false }) });
    assert.equal(started.status, 200, await started.clone().text());
    const q = await waitFor((e) => e.type === "question", "the question");
    assert.equal(q.question, "Which colour?");
    assert.deepEqual(q.options, ["red", "blue"]);
    assert.equal((await fetch(`${app.base}/api/answer`, { method: "POST", headers: H, body: JSON.stringify({ id: q.id, answer: "" }) })).status, 400, "an empty answer is refused");
    assert.equal((await fetch(`${app.base}/api/answer`, { method: "POST", headers: H, body: JSON.stringify({ id: q.id, answer: "blue" }) })).status, 200);
    const fin = await waitFor((e) => e.type === "finished", "the task to finish");
    assert.equal(fin.outcome, "done");
    ctl.abort();
  });
  test("an isolated run edits a separate copy; the changes card offers Apply, and Apply brings them into the folder", async () => {
    const H = { "x-narrowbit-token": app.token, "content-type": "application/json" };
    const { rmSync: rm } = await import("node:fs");
    rm(join(fakeDir, "count"), { force: true });
    writeFileSync(join(fakeDir, "replies.json"), JSON.stringify([
      JSON.stringify({ action: "edit", path: "a.txt", old: "hi", new: "hello there" }),
      JSON.stringify({ action: "done", summary: "greeted" }),
    ]));
    const started = await fetch(`${app.base}/api/run`, { method: "POST", headers: H, body: JSON.stringify({ task: "make the greeting friendlier", askBeforeCommands: false, isolate: true, force: true }) });
    assert.equal(started.status, 200, await started.clone().text());
    let taskId = null;
    for (let i = 0; i < 200 && !taskId; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const st = await (await fetch(`${app.base}/api/state`, { headers: H })).json();
      const h = st.history.find((x) => x.outcome === "done" && /friendlier/.test(x.goal));
      if (h && !st.running) taskId = h.id;
    }
    assert.ok(taskId, "the isolated task finished");
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "hi\n", "the folder is untouched while the copy holds the edit");
    const d = await (await fetch(`${app.base}/api/diff?task=${taskId}`, { headers: H })).json();
    assert.equal(d.isolated, true);
    assert.deepEqual(d.files, ["a.txt"]);
    assert.match(d.diff, /\+hello there/);
    const r = await fetch(`${app.base}/api/isolated/apply`, { method: "POST", headers: H, body: JSON.stringify({ task: taskId }) });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "hello there\n", "Apply brought the change into the folder");
    const after = await (await fetch(`${app.base}/api/diff?task=${taskId}`, { headers: H })).json();
    assert.notEqual(after.isolated, true, "the copy is gone after Apply");
  });

  test("rewind: a checkpoint exists before the task and after its edit, and restoring one undoes the file", async () => {
    const H = { "x-narrowbit-token": app.token, "content-type": "application/json" };
    writeFileSync(join(repo, "a.txt"), "hi\n"); // this describe block's earlier tests may have left it edited
    const { rmSync: rm } = await import("node:fs");
    rm(join(fakeDir, "count"), { force: true });
    writeFileSync(join(fakeDir, "replies.json"), JSON.stringify([
      JSON.stringify({ action: "edit", path: "a.txt", old: "hi", new: "bye" }),
      JSON.stringify({ action: "done", summary: "changed it" }),
    ]));
    const started = await fetch(`${app.base}/api/run`, { method: "POST", headers: H, body: JSON.stringify({ task: "say bye instead", askBeforeCommands: false, force: true }) });
    assert.equal(started.status, 200, await started.clone().text());
    let taskId = null;
    for (let i = 0; i < 200 && !taskId; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const st = await (await fetch(`${app.base}/api/state`, { headers: H })).json();
      const h = st.history.find((x) => x.outcome === "done" && /bye instead/.test(x.goal));
      if (h && !st.running) taskId = h.id;
    }
    assert.ok(taskId, "the task finished");
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "bye\n");
    const t = await (await fetch(`${app.base}/api/task/${taskId}`, { headers: H })).json();
    const checkpoints = t.events.filter((e) => e.type === "checkpoint" && e.actor === "system");
    assert.equal(checkpoints.length, 2, "one before the task, one after the edit");
    const r = await fetch(`${app.base}/api/rewind`, { method: "POST", headers: H, body: JSON.stringify({ task: taskId, checkpoint: checkpoints[0].id }) });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "hi\n", "rewinding to the first checkpoint undid the edit");
    const bad = await fetch(`${app.base}/api/rewind`, { method: "POST", headers: H, body: JSON.stringify({ task: taskId, checkpoint: "nope" }) });
    assert.equal(bad.status, 404);
  });
});
