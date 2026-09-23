/**
 * The app's single page, served by ui.ts. Self-contained (no CDN, no build step) so it works
 * offline and inside the macOS app's WKWebView. The script avoids template literals so this file
 * can hold it in one TS template string; all text reaches the DOM via textContent, never innerHTML.
 */
export function uiPage(): string {
  return PAGE;
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Narrowbit</title>
<style>
:root {
  --bg: #f6f6f4; --panel: #ffffff; --panel-2: #f0efec; --line: #e2e0db; --text: #1d1c1a; --muted: #6d6a64;
  --accent: #3b5bdb; --accent-text: #ffffff; --ok: #2b8a3e; --warn: #b7791f; --bad: #c92a2a;
  --t-explore: #0c8599; --t-execute: #3b5bdb; --t-escalate: #9c36b5;
  --add-bg: #e6f4ea; --add-fg: #1e6b34; --del-bg: #fbe9e9; --del-fg: #a61e1e; --hunk: #6d6a64;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161615; --panel: #1f1f1d; --panel-2: #272725; --line: #34332f; --text: #ecebe7; --muted: #9a978f;
    --accent: #6e8bff; --accent-text: #0e0e0d; --ok: #51cf66; --warn: #f0b429; --bad: #ff6b6b;
    --t-explore: #3bc9db; --t-execute: #748ffc; --t-escalate: #da77f2;
    --add-bg: #17301f; --add-fg: #8ce99a; --del-bg: #3a1a1a; --del-fg: #ffa8a8; --hunk: #9a978f;
  }
}
:root[data-theme="dark"] {
  --bg: #161615; --panel: #1f1f1d; --panel-2: #272725; --line: #34332f; --text: #ecebe7; --muted: #9a978f;
  --accent: #6e8bff; --accent-text: #0e0e0d; --ok: #51cf66; --warn: #f0b429; --bad: #ff6b6b;
  --t-explore: #3bc9db; --t-execute: #748ffc; --t-escalate: #da77f2;
  --add-bg: #17301f; --add-fg: #8ce99a; --del-bg: #3a1a1a; --del-fg: #ffa8a8; --hunk: #9a978f;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; border: 1px solid var(--line); background: var(--panel); border-radius: 7px; padding: 6px 12px; }
button:hover:not(:disabled) { background: var(--panel-2); }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
button.primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--accent); }
button.danger { color: var(--bad); }
button.danger.armed { background: var(--bad); border-color: var(--bad); color: #fff; }
button.link { border: 0; background: none; padding: 2px 4px; color: var(--accent); }
select, input[type=text], input[type=number], textarea { background: var(--panel); border: 1px solid var(--line); border-radius: 7px; padding: 6px 8px; width: 100%; }
select:focus, input:focus, textarea:focus { outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: -1px; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.muted { color: var(--muted); }
.hidden { display: none !important; }

header { height: 52px; display: flex; align-items: center; gap: 12px; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 5; }
header .brand { font-weight: 700; letter-spacing: -.01em; }
header .repo { display: flex; align-items: center; gap: 8px; min-width: 0; }
header .repo-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 2px 8px; border-radius: 99px; background: var(--panel-2); color: var(--muted); white-space: nowrap; }
.pill.ok { color: var(--ok); } .pill.warn { color: var(--warn); } .pill.bad { color: var(--bad); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; display: inline-block; }
header .spacer { flex: 1; }
.limits { display: flex; gap: 14px; border: 0; background: none; padding: 4px 6px; font-size: 11.5px; color: var(--muted); }
.limits .prov { display: flex; align-items: center; gap: 6px; }
.limits .name { font-weight: 600; color: var(--text); }
.limits .win { display: inline-flex; align-items: center; gap: 4px; }
.limits .bar { width: 34px; height: 5px; border-radius: 3px; background: var(--panel-2); overflow: hidden; display: inline-block; }
.limits .bar i { display: block; height: 100%; background: var(--ok); }
.limits .bar i.mid { background: var(--warn); } .limits .bar i.high { background: var(--bad); }
@media (max-width: 900px) { .limits .win .lbl { display: none; } }

.layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); height: calc(100% - 52px); }
aside { border-right: 1px solid var(--line); overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 18px; }
main { overflow-y: auto; padding: 20px 24px 40px; }
.main-inner { max-width: 920px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 10px; font-weight: 600; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }

.slot { display: grid; grid-template-columns: 22px 1fr; gap: 4px 8px; align-items: center; margin-bottom: 10px; }
.slot .num { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; font-weight: 700; font-size: 12px; color: #fff; }
.slot label { font-size: 12px; color: var(--muted); }
.slot select { grid-column: 2; }
#providerSel { margin-bottom: 12px; }
.pinfo { font-size: 12px; color: var(--muted); margin: -4px 0 12px; }
.pinfo a { color: var(--accent); }
.subrow { display: flex; gap: 6px; margin: -4px 0 12px; align-items: center; flex-wrap: wrap; }
.subrow input { flex: 1 1 140px; width: auto; }
.subrow .status { font-size: 12px; color: var(--ok); flex: 1 1 100%; }
.slot input { grid-column: 2; }
.freeonly { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); margin: -4px 0 10px 30px; }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 3px; }
.check { display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; font-size: 13px; }
.check input { margin-top: 3px; }
.note { font-size: 12px; color: var(--warn); margin-top: 8px; }
.saved { font-size: 12px; color: var(--ok); height: 16px; margin-top: 4px; }

.history { display: flex; flex-direction: column; gap: 2px; }
.history button { text-align: left; border: 0; background: none; padding: 7px 8px; border-radius: 7px; display: grid; grid-template-columns: 10px 1fr; gap: 2px 8px; }
.history button:hover { background: var(--panel-2); }
.history .goal { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
.history .meta { grid-column: 2; font-size: 11.5px; color: var(--muted); }
.history .dot { margin-top: 6px; }
.o-done { color: var(--ok); } .o-blocked, .o-error { color: var(--bad); } .o-stopped, .o-unfinished, .o-max_steps { color: var(--warn); }

.composer textarea { min-height: 84px; resize: vertical; border: 0; padding: 0; background: transparent; outline: none !important; font-size: 15px; }
.composer .bar { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.composer .sel { font-size: 12px; color: var(--muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kbd { font-size: 11px; color: var(--muted); }

.warnbox { border-color: color-mix(in srgb, var(--warn) 50%, var(--line)); }
.warnbox ul { margin: 6px 0 10px; padding-left: 18px; }
.errbox { border-color: color-mix(in srgb, var(--bad) 50%, var(--line)); color: var(--bad); }

.timeline { display: flex; flex-direction: column; }
.step { display: grid; grid-template-columns: 28px 76px 1fr; gap: 8px; padding: 6px 0; border-bottom: 1px dashed var(--line); align-items: baseline; }
.step:last-child { border-bottom: 0; }
.step .n { color: var(--muted); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
.chip { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 5px; justify-self: start; background: var(--panel-2); color: var(--muted); }
.step .what { min-width: 0; }
.step .act { font-weight: 600; }
.step .res { display: block; color: var(--muted); font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
.step.notice .what { color: var(--warn); }
.step.final .what { font-weight: 600; }
.spinner { width: 12px; height: 12px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; display: inline-block; animation: spin .8s linear infinite; vertical-align: -2px; }
@keyframes spin { to { transform: rotate(360deg); } }

.approval { border: 1px solid color-mix(in srgb, var(--warn) 60%, var(--line)); background: color-mix(in srgb, var(--warn) 8%, var(--panel)); border-radius: 10px; padding: 12px; margin: 8px 0; }
.approval pre { margin: 6px 0 10px; padding: 8px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 7px; white-space: pre-wrap; word-break: break-all; }
.approval .btns { display: flex; gap: 8px; flex-wrap: wrap; }
.approval.resolved { opacity: .7; }

.result-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.result-head .label { font-weight: 700; }
.stats { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); margin-top: 8px; }

.diff { border: 1px solid var(--line); border-radius: 8px; overflow: auto; max-height: 60vh; background: var(--panel); }
.diff .file { position: sticky; top: 0; background: var(--panel-2); padding: 6px 10px; font-family: var(--mono); font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--line); }
.diff .ln { font-family: var(--mono); font-size: 12px; white-space: pre; padding: 0 10px; min-height: 18px; }
.diff .add { background: var(--add-bg); color: var(--add-fg); }
.diff .del { background: var(--del-bg); color: var(--del-fg); }
.diff .hunk { color: var(--hunk); background: var(--panel-2); }
.commit { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.commit input { flex: 1 1 260px; }

.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--bg) 70%, transparent); backdrop-filter: blur(4px); display: grid; place-items: center; z-index: 20; padding: 16px; }
.modal { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; width: min(560px, 100%); max-height: 85vh; overflow-y: auto; padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,.18); }
.modal h1 { font-size: 20px; margin: 0 0 4px; }
.modal .recent { display: flex; flex-direction: column; gap: 4px; margin: 14px 0; }
.modal .recent button { text-align: left; border: 1px solid var(--line); padding: 8px 10px; }
.modal .recent .path { font-size: 12px; color: var(--muted); display: block; }
.modal .open-row { display: flex; gap: 8px; }
.modal .events { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; }
.modal .ev { font-size: 12.5px; border-left: 3px solid var(--line); padding: 2px 8px; white-space: pre-wrap; word-break: break-word; }
.modal .ev.model { border-color: var(--t-execute); }
.modal .ev.edit { border-color: var(--ok); }
.modal .ev.blocker { border-color: var(--warn); }
.empty { text-align: center; color: var(--muted); padding: 30px 10px; }

@media (max-width: 760px) {
  .layout { grid-template-columns: 1fr; height: auto; }
  aside { border-right: 0; border-bottom: 1px solid var(--line); }
  main { padding: 16px; }
  .step { grid-template-columns: 22px 64px 1fr; }
}
</style>
</head>
<body>
<header>
  <span class="brand">Narrowbit</span>
  <div class="repo">
    <span class="repo-name" id="repoName">No repository</span>
    <span class="pill hidden" id="branchPill"></span>
    <span class="pill hidden" id="treePill"></span>
  </div>
  <button class="link" id="switchRepo">Switch…</button>
  <span class="spacer"></span>
  <button class="limits" id="limits" title="Subscription usage — click to check now"></button>
  <span class="pill hidden" id="runPill"><span class="spinner"></span> running</span>
</header>

<div class="layout">
  <aside>
    <section>
      <h2>Models</h2>
      <select id="providerSel" aria-label="Provider"></select>
      <div class="pinfo" id="providerInfo"></div>
      <div id="keyRow" class="subrow hidden"></div>
      <div id="urlRow" class="subrow hidden"></div>
      <datalist id="modelList"></datalist>
      <div id="slots"></div>
      <div class="row2">
        <div class="field"><label for="effort">Effort</label><select id="effort"></select></div>
        <div class="field"><label for="maxSteps">Max steps</label><input type="number" id="maxSteps" min="1" max="100" value="20"></div>
      </div>
      <label class="check"><input type="checkbox" id="askCmd" checked><span>Ask before running commands<br><span class="muted" style="font-size:12px">Reads, edits and verify run freely; shell commands wait for you.</span></span></label>
      <div class="note hidden" id="providerNote"></div>
      <div class="saved" id="savedMsg"></div>
    </section>
    <section>
      <h2>History</h2>
      <div class="history" id="history"></div>
    </section>
  </aside>

  <main>
    <div class="main-inner">
      <div class="card hidden" id="setupCard">
        <strong>Narrowbit isn't set up in this repository yet.</strong>
        <p class="muted" style="margin:6px 0 12px">This creates a local <span class="mono">.narrowbit/</span> folder (git-ignored) and indexes the code. Nothing leaves your Mac.</p>
        <button class="primary" id="initBtn">Set up Narrowbit here</button>
      </div>

      <div class="card composer" id="composer">
        <textarea id="task" placeholder="What should Narrowbit do? e.g. “Fix the off-by-one in pagination and add a test”"></textarea>
        <div class="bar">
          <span class="sel" id="selLine"></span>
          <span class="kbd">⌘↩</span>
          <button id="stopBtn" class="danger hidden">Stop</button>
          <button id="runBtn" class="primary">Run</button>
        </div>
      </div>

      <div class="card warnbox hidden" id="dirtyBox"></div>
      <div class="card errbox hidden" id="errBox"></div>

      <div class="card hidden" id="runCard">
        <h2 id="runTitle">Run</h2>
        <div class="timeline" id="timeline"></div>
      </div>

      <div class="card hidden" id="resultCard"></div>

      <div class="card hidden" id="diffCard">
        <h2>Changes</h2>
        <div id="diffBody"></div>
        <div class="commit" id="commitRow">
          <input type="text" id="commitMsg" placeholder="Commit message">
          <button class="primary" id="commitBtn">Commit</button>
          <button class="danger" id="discardBtn">Discard changes</button>
        </div>
        <div class="saved" id="commitMsgOut"></div>
      </div>

      <div class="empty" id="emptyHint">Describe a task and press Run. You'll approve each command, then review the diff before anything is committed.</div>
    </div>
  </main>
</div>

<div class="overlay hidden" id="repoOverlay">
  <div class="modal">
    <h1>Open a repository</h1>
    <p class="muted" style="margin:0">Narrowbit works directly in the folder you choose. Edits are real — you review and commit them here.</p>
    <div class="recent" id="recentList"></div>
    <div class="open-row">
      <input type="text" id="repoPath" placeholder="/path/to/your/project" class="mono">
      <button id="pickFolder" class="hidden">Choose…</button>
      <button class="primary" id="openRepo">Open</button>
    </div>
    <div class="note hidden" id="repoErr" style="color:var(--bad)"></div>
    <div style="text-align:right;margin-top:14px"><button class="link hidden" id="closeRepo">Cancel</button></div>
  </div>
</div>

<div class="overlay hidden" id="taskOverlay">
  <div class="modal" style="width:min(760px,100%)">
    <div style="display:flex;justify-content:space-between;align-items:start;gap:12px">
      <h1 id="taskTitle" style="font-size:16px"></h1>
      <button class="link" id="closeTask">Close</button>
    </div>
    <div class="events" id="taskEvents"></div>
  </div>
</div>

<script>
(function () {
  "use strict";
  var T = new URLSearchParams(location.search).get("t") || "";
  var native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.narrowbit;
  var S = null;            // last /api/state
  var draft = null;        // provider being edited in the sidebar
  var es = null;           // EventSource for the run stream
  var lastRow = null;      // timeline row that receives "→ result" lines
  var runTask = "";

  function $(id) { return document.getElementById(id); }
  function el(tag, props) {
    var n = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === "text") n.textContent = props[k];
      else if (k === "cls") n.className = props[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    }
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function show(n, on) { n.classList.toggle("hidden", !on); }
  function fmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n); }
  function ago(iso) {
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago";
  }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem("nb." + k); localStorage.setItem("nb." + k, v); } catch (e) { return null; } }

  function api(path, body) {
    return fetch(path, {
      method: body ? "POST" : "GET",
      headers: { "x-narrowbit-token": T, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || r.statusText); e.status = r.status; e.data = j; throw e; }
        return j;
      });
    });
  }
  function showError(msg) { var b = $("errBox"); b.textContent = msg; show(b, !!msg); }

  // ---------- state / sidebar ----------
  function load() {
    return api("/api/state").then(apply).catch(function (e) { showError(e.message); });
  }
  function apply(state) {
    S = state;
    if (!S.root) { openRepoPicker(false); renderHeader(); return; }
    show($("repoOverlay"), false);
    if (!draft || draft.root !== S.root) draft = { root: S.root, provider: S.selection.provider, effort: S.selection.effort };
    renderHeader();
    renderModels();
    renderHistory();
    show($("setupCard"), !S.initialized);
    $("composer").style.opacity = S.initialized ? "" : ".5";
    setRunning(S.running);
    if (!es) connectStream();
  }
  function renderHeader() {
    $("repoName").textContent = S && S.root ? S.name : "No repository";
    $("repoName").title = S && S.root ? S.root : "";
    var b = $("branchPill"), t = $("treePill");
    show(b, !!(S && S.git && S.git.branch)); show(t, !!(S && S.git && S.git.isRepo));
    if (S && S.git) {
      b.textContent = S.git.branch + (S.git.head ? " · " + S.git.head : "");
      var n = S.git.changed.length + S.git.untracked.length;
      clear(t).appendChild(el("span", { cls: "dot" }));
      t.appendChild(document.createTextNode(n ? n + " changed" : "clean"));
      t.className = "pill " + (n ? "warn" : "ok");
    }
  }
  var PHASE = { explore: ["1", "Explore — reading, before any edit", "var(--t-explore)"], execute: ["2", "Execute — editing and verifying", "var(--t-execute)"], escalate: ["3", "Escalate — only when stuck", "var(--t-escalate)"] };
  var KIND = { subscription: "Subscriptions", api: "APIs — free & paid", local: "Local models — free, offline" };
  var modelLists = {};   // provider -> /api/models result
  function renderModels() {
    var sel = clear($("providerSel"));
    ["subscription", "api", "local"].forEach(function (kind) {
      var g = el("optgroup", { label: KIND[kind] });
      Object.keys(S.providers).forEach(function (prov) {
        var P = S.providers[prov];
        if (P.kind !== kind) return;
        var o = el("option", { value: prov, text: P.label + " — " + P.pricing });
        if (prov === draft.provider) o.selected = true;
        g.appendChild(o);
      });
      sel.appendChild(g);
    });
    var P = S.providers[draft.provider];
    var info = clear($("providerInfo"));
    if (P.hint) info.appendChild(document.createTextNode(P.hint + " "));
    if (P.keyUrl && !P.keySource) info.appendChild(el("a", { href: P.keyUrl, target: "_blank", text: "Get a key →" }));
    show(info, !!(P.hint || (P.keyUrl && !P.keySource)));

    var keyRow = clear($("keyRow"));
    show(keyRow, P.kind === "api");
    if (P.kind === "api") {
      if (P.keySource) {
        keyRow.appendChild(el("span", { cls: "status", text: P.keySource === "env" ? "✓ API key set (from environment)" : "✓ API key saved" }));
        if (P.keySource === "file") keyRow.appendChild(el("button", { cls: "link", text: "Remove key", onclick: function () { saveKey(""); } }));
      } else {
        var k = el("input", { type: "password", placeholder: P.needsKey ? "Paste API key" : "API key (if needed)", autocomplete: "off" });
        keyRow.appendChild(k);
        keyRow.appendChild(el("button", { text: "Save", onclick: function () { if (k.value.trim()) saveKey(k.value); } }));
      }
    }
    var urlRow = clear($("urlRow"));
    var hasUrl = P.kind === "local" || draft.provider === "custom";
    show(urlRow, hasUrl);
    if (hasUrl) {
      var u = el("input", { type: "text", cls: "mono", value: P.baseUrl || "", placeholder: "http://127.0.0.1:8080/v1", "aria-label": "Base URL" });
      urlRow.appendChild(u);
      urlRow.appendChild(el("button", { text: "Set URL", onclick: function () { api("/api/endpoint", { provider: draft.provider, baseUrl: u.value }).then(function (st) { delete modelLists[draft.provider]; apply(st); flash($("savedMsg"), "Endpoint saved"); }).catch(function (e) { showError(e.message); }); } }));
    }

    var slots = clear($("slots"));
    var list = modelLists[draft.provider];
    S.phases.forEach(function (ph) {
      var inp = el("input", { type: "text", id: "slot-" + ph, list: "modelList", value: P.tiers[ph] || "", placeholder: list && !list.models.length ? "type a model id" : "choose a model", autocomplete: "off", spellcheck: "false", onchange: function () { saveModels(); } });
      slots.appendChild(el("div", { cls: "slot" },
        el("span", { cls: "num", style: "background:" + PHASE[ph][2], text: PHASE[ph][0] }),
        el("label", { for: "slot-" + ph, text: PHASE[ph][1] + (P.defaults[ph] && P.tiers[ph] !== P.defaults[ph] ? " · default " + P.defaults[ph] : "") }),
        inp));
    });
    if (list && list.free.length) {
      var fo = el("input", { type: "checkbox", id: "freeOnly" });
      fo.checked = store("freeOnly") === "1";
      fo.onchange = function () { store("freeOnly", fo.checked ? "1" : "0"); fillModelList(); };
      slots.appendChild(el("label", { cls: "freeonly" }, fo, "Show free models only (" + list.free.length + ")"));
    }
    fillModelList();
    if (!list) loadModelList(draft.provider);

    var eff = clear($("effort"));
    S.efforts.forEach(function (l) { var o = el("option", { value: l, text: l }); if (l === draft.effort) o.selected = true; eff.appendChild(o); });
    var note = $("providerNote");
    var notes = [];
    if (P.unavailable) notes.push(P.unavailable);
    if (list && !list.models.length) notes.push(list.note);
    if (S.selectionError) notes.push(S.selectionError);
    note.textContent = notes.join(" "); show(note, notes.length > 0);
    var t = S.selection.tiers;
    $("selLine").textContent = S.providers[S.selection.provider].label + ": " + (t.explore || "?") + " → " + (t.execute || "?") + " → " + (t.escalate || "?") + " · " + S.selection.effort;
    updateRunBtn();
  }
  function fillModelList() {
    var dl = clear($("modelList"));
    var list = modelLists[draft.provider];
    if (!list) return;
    var fo = $("freeOnly");
    var ids = fo && fo.checked ? list.free : list.models;
    ids.forEach(function (id) {
      var label = (list.labels[id] || "") + (list.free.indexOf(id) >= 0 ? " · free" : "");
      dl.appendChild(el("option", { value: id, label: label.replace(/^ · /, "") }));
    });
  }
  function loadModelList(prov) {
    api("/api/models?provider=" + encodeURIComponent(prov)).then(function (l) {
      modelLists[prov] = l;
      if (draft && draft.provider === prov) renderModels();
    }).catch(function () {});
  }
  function saveKey(key) {
    api("/api/key", { provider: draft.provider, key: key }).then(function (st) {
      delete modelLists[draft.provider];
      apply(st); flash($("savedMsg"), key ? "Key saved to ~/.narrowbit/keys.json" : "Key removed");
    }).catch(function (e) { showError(e.message); });
  }
  $("providerSel").onchange = function () {
    var prov = $("providerSel").value;
    draft.provider = prov;
    saveModels(S.providers[prov].tiers);
  };
  // tiers omitted = keep that provider's own saved models (used when switching provider).
  function saveModels(tiers) {
    if (!tiers || tiers instanceof Event) {
      tiers = {};
      S.phases.forEach(function (ph) { tiers[ph] = $("slot-" + ph).value.trim(); });
    }
    draft.effort = $("effort").value || draft.effort;
    api("/api/models", { provider: draft.provider, effort: draft.effort, tiers: tiers }).then(function (st) {
      apply(st); flash($("savedMsg"), "Saved for this repository");
    }).catch(function (e) { showError(e.message); });
  }
  function flash(n, msg) { n.textContent = msg; clearTimeout(n._t); n._t = setTimeout(function () { n.textContent = ""; }, 2200); }

  function renderHistory() {
    var h = clear($("history"));
    if (!S.history.length) { h.appendChild(el("div", { cls: "muted", style: "font-size:13px", text: "No tasks yet." })); return; }
    S.history.forEach(function (r) {
      h.appendChild(el("button", { title: r.goal, onclick: function () { openTask(r); } },
        el("span", { cls: "dot o-" + r.outcome }),
        el("span", { cls: "goal", text: r.goal }),
        el("span", { cls: "meta", text: r.outcome + " · " + fmt(r.tokens) + " tok · $" + r.costUsd.toFixed(3) + " · " + ago(r.at) })));
    });
  }
  function openTask(r) {
    $("taskTitle").textContent = r.goal;
    var box = clear($("taskEvents"));
    box.appendChild(el("div", { cls: "muted", text: "Loading…" }));
    show($("taskOverlay"), true);
    api("/api/task/" + encodeURIComponent(r.id)).then(function (d) {
      clear(box);
      box.appendChild(el("div", { cls: "muted", style: "font-size:12px;margin-bottom:6px", text: r.id + " · " + r.outcome + " · " + fmt(r.tokens) + " tokens · $" + r.costUsd.toFixed(3) + (r.files.length ? " · " + r.files.join(", ") : "") }));
      d.events.forEach(function (e) {
        var kind = e.type === "model_call" ? "model" : e.type === "edit" ? "edit" : e.type === "blocker" ? "blocker" : "";
        var text = (e.model ? "[" + e.model + "] " : "") + e.summary;
        box.appendChild(el("div", { cls: "ev " + kind, text: text.length > 700 ? text.slice(0, 700) + " …" : text }));
      });
    }).catch(function (e) { clear(box).appendChild(el("div", { cls: "errbox", text: e.message })); });
  }
  $("closeTask").onclick = function () { show($("taskOverlay"), false); };

  // ---------- repo picker ----------
  function openRepoPicker(cancellable) {
    var list = clear($("recentList"));
    var recent = (S && S.recent) || [];
    recent.forEach(function (r) {
      var name = r.split("/").filter(Boolean).pop();
      list.appendChild(el("button", { onclick: function () { openRepo(r); } }, el("strong", { text: name }), el("span", { cls: "path mono", text: r })));
    });
    if (!recent.length) list.appendChild(el("div", { cls: "muted", style: "font-size:13px", text: "No recent repositories." }));
    show($("pickFolder"), !!native);
    show($("closeRepo"), cancellable);
    show($("repoErr"), false);
    show($("repoOverlay"), true);
    if (!native) $("repoPath").focus();
  }
  function openRepo(path) {
    api("/api/repo", { path: path }).then(function (st) {
      if (es) { es.close(); es = null; }
      resetRunView();
      draft = null;
      apply(st);
    }).catch(function (e) { var n = $("repoErr"); n.textContent = e.message; show(n, true); });
  }
  $("switchRepo").onclick = function () { openRepoPicker(!!(S && S.root)); };
  $("closeRepo").onclick = function () { show($("repoOverlay"), false); };
  $("openRepo").onclick = function () { var v = $("repoPath").value.trim(); if (v) openRepo(v); };
  $("repoPath").addEventListener("keydown", function (e) { if (e.key === "Enter") $("openRepo").click(); });
  $("pickFolder").onclick = function () { native.postMessage({ type: "pickFolder" }); };
  window.narrowbitFolderPicked = function (path) { if (path) { $("repoPath").value = path; openRepo(path); } };
  $("initBtn").onclick = function () {
    var b = $("initBtn"); b.disabled = true; b.textContent = "Indexing…";
    api("/api/init", {}).then(apply).catch(function (e) { showError(e.message); }).then(function () { b.disabled = false; b.textContent = "Set up Narrowbit here"; });
  };

  // ---------- running ----------
  var running = false;
  function setRunning(on) {
    running = on;
    show($("runPill"), on); show($("stopBtn"), on);
    $("task").disabled = on;
    updateRunBtn();
  }
  function updateRunBtn() {
    var ok = S && S.root && S.initialized && !running && !S.providers[S.selection.provider].unavailable;
    $("runBtn").disabled = !ok;
  }
  $("maxSteps").value = store("maxSteps") || "20";
  $("askCmd").checked = store("askCmd") !== "0";
  $("maxSteps").onchange = function () { store("maxSteps", $("maxSteps").value); };
  $("askCmd").onchange = function () { store("askCmd", $("askCmd").checked ? "1" : "0"); };
  $("effort").onchange = function () { saveModels(); };

  function resetRunView() {
    clear($("timeline")); lastRow = null;
    show($("runCard"), false); show($("resultCard"), false); show($("diffCard"), false); show($("dirtyBox"), false);
    show($("emptyHint"), true); showError("");
  }
  function run(force) {
    var task = $("task").value.trim();
    if (!task || $("runBtn").disabled) return;
    showError(""); show($("dirtyBox"), false);
    api("/api/run", { task: task, force: !!force, maxSteps: Number($("maxSteps").value) || 20, askBeforeCommands: $("askCmd").checked })
      .then(function () {
        runTask = task;
        clear($("timeline")); lastRow = null;
        show($("resultCard"), false); show($("diffCard"), false); show($("emptyHint"), false);
        show($("runCard"), true);
        setRunning(true);
        if (es) { es.close(); es = null; }
        connectStream();
      })
      .catch(function (e) {
        if (e.status === 409 && e.data && e.data.error === "dirty") {
          var box = clear($("dirtyBox"));
          box.appendChild(el("strong", { text: "This repository has uncommitted changes." }));
          box.appendChild(el("div", { cls: "muted", text: "The agent's edits would mix with yours, and Discard would revert them too:" }));
          var ul = el("ul", { cls: "mono" }); e.data.files.slice(0, 12).forEach(function (f) { ul.appendChild(el("li", { text: f })); });
          box.appendChild(ul);
          box.appendChild(el("button", { text: "Run anyway", onclick: function () { run(true); } }));
          show(box, true);
        } else showError(e.message);
      });
  }
  $("runBtn").onclick = function () { run(false); };
  $("task").addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(false); } });
  $("stopBtn").onclick = function () { api("/api/stop", {}).catch(function (e) { showError(e.message); }); };

  function tierOf(model) {
    var t = S && S.selection.tiers;
    if (!t) return null;
    return model === t.escalate ? "escalate" : model === t.execute ? "execute" : model === t.explore ? "explore" : null;
  }
  // Keep the newest step in view, unless the user has scrolled up to read (force: approvals).
  function follow(fn, force) {
    var m = document.querySelector("main");
    var atEnd = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
    fn();
    if (atEnd || force) m.scrollTop = m.scrollHeight;
  }
  function addStep(n, model, text, cls) {
    var tier = tierOf(model);
    var chip = model ? el("span", { cls: "chip", text: model, style: tier ? "color:" + PHASE[tier][2] : "" }) : el("span");
    var what = el("div", { cls: "what" });
    var m = /^(\w+)(.*)$/.exec(text);
    if (m && !cls) { what.appendChild(el("span", { cls: "act", text: m[1] })); what.appendChild(document.createTextNode(m[2])); }
    else what.textContent = text;
    var row = el("div", { cls: "step" + (cls ? " " + cls : "") }, el("span", { cls: "n", text: n }), chip, what);
    follow(function () { $("timeline").appendChild(row); });
    lastRow = what;
  }
  function onLog(line) {
    var m = /^\[(\d+)\] \(([^)]+)\) (.*)$/.exec(line);
    if (m) {
      var fin = /^(done|blocked):/.test(m[3]);
      return addStep(m[1], m[2], m[3], fin ? "final" : /^done rejected|unparseable/.test(m[3]) ? "notice" : "");
    }
    var r = /^\s+→ (.*)$/.exec(line);
    if (r && lastRow) { follow(function () { lastRow.appendChild(el("span", { cls: "res", text: r[1] })); }); return; }
    var nz = /^\s+[!~] (.*)$/.exec(line);
    if (nz) return addStep("", null, nz[1], "notice");
    var plain = /^\[(\d+)\] (.*)$/.exec(line);
    if (plain) return addStep(plain[1], null, plain[2], "notice");
    addStep("", null, line.trim(), "notice");
  }
  var approvals = {};
  function onApproval(ev) {
    var box = el("div", { cls: "approval" },
      el("strong", { text: "Run this command?" }),
      el("pre", { cls: "mono", text: ev.command }));
    var btns = el("div", { cls: "btns" });
    function decide(d) {
      Array.prototype.forEach.call(btns.querySelectorAll("button"), function (b) { b.disabled = true; });
      api("/api/approve", { id: ev.id, decision: d }).catch(function (e) { showError(e.message); });
    }
    btns.appendChild(el("button", { cls: "primary", text: "Allow once", onclick: function () { decide("once"); } }));
    btns.appendChild(el("button", { text: "Allow for this task", onclick: function () { decide("task"); } }));
    btns.appendChild(el("button", { cls: "danger", text: "Deny", onclick: function () { decide("deny"); } }));
    box.appendChild(btns);
    approvals[ev.id] = { box: box, btns: btns };
    follow(function () { $("timeline").appendChild(box); }, true);
    if (native) native.postMessage({ type: "attention", text: ev.command });
  }
  function onApprovalResolved(ev) {
    var a = approvals[ev.id]; if (!a) return;
    a.box.classList.add("resolved");
    clear(a.btns).appendChild(el("span", { cls: ev.allowed ? "o-done" : "o-blocked", text: ev.allowed ? "✓ Allowed" : "✕ Denied" }));
  }
  var LABEL = { done: "Done", blocked: "Blocked", error: "Error", stopped: "Stopped", max_steps: "Step budget reached" };
  function onFinished(ev) {
    setRunning(false);
    var card = clear($("resultCard"));
    card.appendChild(el("div", { cls: "result-head" },
      el("span", { cls: "dot o-" + ev.outcome }), el("span", { cls: "label o-" + ev.outcome, text: LABEL[ev.outcome] || ev.outcome })));
    card.appendChild(el("div", { text: ev.summary }));
    card.appendChild(el("div", { cls: "stats" },
      el("span", { text: ev.steps + " steps" }),
      el("span", { text: fmt(ev.tokens) + " tokens" }),
      el("span", { text: "$" + ev.costUsd.toFixed(3) + " notional (subscription)" }),
      el("span", { cls: "mono", text: ev.taskId })));
    if (ev.outcome !== "done") card.appendChild(el("div", { cls: "note", text: "The task didn't report a clean completion — read the diff carefully before committing." }));
    show(card, true);
    if (!$("commitMsg").value && runTask) $("commitMsg").value = runTask.split("\n")[0].slice(0, 72);
    loadDiff();
    load();
    loadLimits();
    if (native) native.postMessage({ type: "finished", text: (LABEL[ev.outcome] || ev.outcome) + ": " + ev.summary });
  }
  function connectStream() {
    if (!S || !S.root) return;
    es = new EventSource("/api/stream?t=" + encodeURIComponent(T));
    es.onmessage = function (m) {
      var ev = JSON.parse(m.data);
      if (ev.type === "start") {
        runTask = ev.task; clear($("timeline")); lastRow = null; approvals = {};
        $("runTitle").textContent = ev.selection;
        show($("runCard"), true); show($("emptyHint"), false); show($("resultCard"), false); show($("diffCard"), false);
        if (!$("task").value) $("task").value = ev.task;
      } else if (ev.type === "log") onLog(ev.line);
      else if (ev.type === "approval") onApproval(ev);
      else if (ev.type === "approval_resolved") onApprovalResolved(ev);
      else if (ev.type === "finished") onFinished(ev);
      else if (ev.type === "failed") { setRunning(false); showError("The run failed: " + ev.error); load(); }
    };
  }

  // ---------- diff / commit / discard ----------
  function loadDiff() {
    api("/api/diff").then(function (d) {
      var body = clear($("diffBody"));
      show($("diffCard"), true);
      show($("commitRow"), d.files.length > 0);
      if (!d.files.length) { body.appendChild(el("div", { cls: "muted", text: "No files changed." })); return; }
      var box = el("div", { cls: "diff" });
      d.diff.split("\n").forEach(function (l) {
        if (/^diff --git /.test(l)) { box.appendChild(el("div", { cls: "file", text: l.replace(/^diff --git a\/(.*) b\/.*$/, "$1") })); return; }
        if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) return;
        var cls = l[0] === "+" ? "ln add" : l[0] === "-" ? "ln del" : l.slice(0, 2) === "@@" ? "ln hunk" : "ln";
        box.appendChild(el("div", { cls: cls, text: l || " " }));
      });
      body.appendChild(box);
      if (d.skipped.length) body.appendChild(el("div", { cls: "muted", style: "font-size:12px;margin-top:8px", text: "Not shown or committed (untracked before this run): " + d.skipped.join(", ") }));
    }).catch(function (e) { showError(e.message); });
  }
  $("commitBtn").onclick = function () {
    var msg = $("commitMsg").value.trim();
    if (!msg) { $("commitMsg").focus(); return; }
    api("/api/commit", { message: msg }).then(function (r) {
      flash($("commitMsgOut"), "Committed " + r.head);
      $("commitMsg").value = ""; $("task").value = "";
      show($("commitRow"), false);
      clear($("diffBody")).appendChild(el("div", { cls: "muted", text: "Committed as " + r.head + "." }));
      load();
    }).catch(function (e) { showError(e.message); });
  };
  var armed = null;
  $("discardBtn").onclick = function () {
    var b = $("discardBtn");
    if (!armed) {
      b.classList.add("armed"); b.textContent = "Click again to discard";
      armed = setTimeout(function () { armed = null; b.classList.remove("armed"); b.textContent = "Discard changes"; }, 4000);
      return;
    }
    clearTimeout(armed); armed = null; b.classList.remove("armed"); b.textContent = "Discard changes";
    api("/api/discard", {}).then(function (r) {
      var msg = "Reverted " + r.restored.length + " file(s)" + (r.deleted.length ? ", removed " + r.deleted.length + " new file(s)" : "");
      if (r.kept.length) msg += " — left " + r.kept.length + " untracked file(s) that weren't created by this run";
      show($("commitRow"), false);
      clear($("diffBody")).appendChild(el("div", { cls: "muted", text: msg + "." }));
      load();
    }).catch(function (e) { showError(e.message); });
  };

  // ---------- subscription limits ----------
  function until(t) {
    if (!t) return "";
    var m = Math.round((t * 1000 - Date.now()) / 60000);
    return m <= 0 ? "resetting" : m < 90 ? "resets in " + m + "m" : m < 2880 ? "resets in " + Math.round(m / 60) + "h" : "resets " + new Date(t * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric" });
  }
  function renderLimits(L) {
    var box = clear($("limits"));
    var tips = [];
    [["claude", "Claude"], ["codex", "Codex"]].forEach(function (pair) {
      var l = L[pair[0]];
      var p = el("span", { cls: "prov" }, el("span", { cls: "name", text: pair[1] }));
      if (!l || (!l.fiveHour && !l.weekly)) {
        p.appendChild(el("span", { text: l && l.error ? (/login/.test(l.error) ? "log in to see" : "unavailable") : "—" }));
        tips.push(pair[1] + ": " + (l && l.error ? l.error : "no reading yet"));
      } else {
        [["5h", l.fiveHour, "5-hour"], ["wk", l.weekly, "Weekly"]].forEach(function (w) {
          if (!w[1]) return;
          var pct = w[1].usedPercent;
          p.appendChild(el("span", { cls: "win" }, el("span", { cls: "lbl", text: w[0] }),
            el("span", { cls: "bar" }, el("i", { cls: pct >= 90 ? "high" : pct >= 70 ? "mid" : "", style: "width:" + Math.min(100, pct) + "%" })),
            el("span", { text: Math.round(pct) + "%" })));
          tips.push(pair[1] + " " + w[2] + ": " + pct + "% used, " + until(w[1].resetsAt));
        });
        if (l.error) tips.push(pair[1] + ": last check failed — " + l.error);
      }
      box.appendChild(p);
    });
    box.title = tips.join("\n") + "\n\nClick to check now (Claude: one tiny Haiku call).";
  }
  function loadLimits() { api("/api/limits").then(renderLimits).catch(function () {}); }
  $("limits").onclick = function () {
    $("limits").style.opacity = ".5";
    api("/api/limits/refresh", {}).then(renderLimits).catch(function (e) { showError(e.message); }).then(function () { $("limits").style.opacity = ""; });
  };
  loadLimits();
  setInterval(loadLimits, 60000);

  load();
})();
</script>
</body>
</html>
`;
