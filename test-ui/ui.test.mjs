// Browser-level checks of the app page: boots the real server, loads the real page in jsdom and drives it.
// Run with `npm run test:ui`. Each check below exists because that exact thing broke (or nearly broke)
// and was only noticed by hand: the folder dialog with no Cancel, a different layout per state, the
// version/readiness UI, skills, error cards. No model is ever called.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
async function startApp({ cwd, home }) {
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, "ui", "--no-open", "--port", String(port)], { cwd, env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
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
    const models = [...page.w.document.querySelectorAll("#slots input[type=text]")].map((i) => i.value);
    assert.deepEqual(models, ["haiku", "sonnet", "opus"]);
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

  test("the composer can't send with no folder, and says why", () => {
    assert.equal(page.$("sendBtn").disabled, true);
    assert.match(page.$("hint").textContent, /Choose a folder/);
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
