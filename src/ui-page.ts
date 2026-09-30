/**
 * The app's single page, served by ui.ts. Self-contained (no CDN, no build step) so it works
 * offline and inside the macOS app's WKWebView. The script avoids template literals so this file
 * can hold it in one TS template string; all text reaches the DOM via textContent, never innerHTML.
 *
 * The conversation is rendered from runtime events (events.ts), the same records `narrowbit agent`
 * writes: a past session and a live one go through the same renderEvent().
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cg fill='%23c96442'%3E%3Crect x='20' y='25' width='8' height='50'/%3E%3Crect x='20' y='25' width='20' height='8'/%3E%3Crect x='20' y='67' width='20' height='8'/%3E%3Crect x='72' y='25' width='8' height='50'/%3E%3Crect x='60' y='25' width='20' height='8'/%3E%3Crect x='60' y='67' width='20' height='8'/%3E%3Crect x='44' y='44' width='12' height='12'/%3E%3C/g%3E%3C/svg%3E">
<style>
:root {
  --bg: #faf9f5; --side: #f3f1ea; --panel: #ffffff; --panel-2: #f0eee6; --line: #e5e2d9; --line-2: #d9d5c9;
  --text: #1f1e1b; --muted: #76746c; --faint: #a19e95;
  --accent: #c96442; --accent-soft: #f5e3db; --on-accent: #ffffff;
  --ok: #2f7d4f; --warn: #a86a12; --bad: #c0392b;
  --t-explore: #1f7a8c; --t-execute: #4a5fc1; --t-escalate: #9b4dca;
  --add-bg: #e7f3ea; --add-fg: #1d6337; --del-bg: #fbeaea; --del-fg: #9f2a2a;
  --shadow: 0 1px 2px rgba(31,30,27,.06), 0 4px 16px rgba(31,30,27,.06);
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  --serif: ui-serif, "New York", Georgia, serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #262624; --side: #1f1e1d; --panel: #30302e; --panel-2: #383734; --line: #3b3a36; --line-2: #4a4944;
    --text: #f3f1ea; --muted: #a8a59c; --faint: #7d7a72;
    --accent: #d97757; --accent-soft: #4a3229; --on-accent: #1f1e1d;
    --ok: #5fbf85; --warn: #e0a84a; --bad: #ef7a6c;
    --t-explore: #5cc2d4; --t-execute: #8c9cf0; --t-escalate: #c790ee;
    --add-bg: #1f3827; --add-fg: #8fd9a8; --del-bg: #43211f; --del-fg: #f2a9a0;
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 6px 20px rgba(0,0,0,.25);
  }
}
:root[data-theme="dark"] {
  --bg: #262624; --side: #1f1e1d; --panel: #30302e; --panel-2: #383734; --line: #3b3a36; --line-2: #4a4944;
  --text: #f3f1ea; --muted: #a8a59c; --faint: #7d7a72;
  --accent: #d97757; --accent-soft: #4a3229; --on-accent: #1f1e1d;
  --ok: #5fbf85; --warn: #e0a84a; --bad: #ef7a6c;
  --t-explore: #5cc2d4; --t-execute: #8c9cf0; --t-escalate: #c790ee;
  --add-bg: #1f3827; --add-fg: #8fd9a8; --del-bg: #43211f; --del-fg: #f2a9a0;
  --shadow: 0 1px 2px rgba(0,0,0,.3), 0 6px 20px rgba(0,0,0,.25);
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; overflow: hidden; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 6px 12px; }
button:hover:not(:disabled) { background: var(--panel-2); }
button:disabled { opacity: .45; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
button.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.07); }
button.ghost { border-color: transparent; background: transparent; }
button.ghost:hover:not(:disabled) { background: var(--panel-2); }
#themeBtn { width: 32px; height: 32px; padding: 0; display: grid; place-items: center; font-size: 15px; border-radius: 8px; flex: none; }
button.danger { color: var(--bad); }
button.danger.armed { background: var(--bad); border-color: var(--bad); color: #fff; }
button.link { border: 0; background: none; padding: 0; color: var(--accent); }
select, input[type=text], input[type=number], input[type=password] { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 9px; width: 100%; }
:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 1px; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.muted { color: var(--muted); }
.hidden { display: none !important; }
button.primary kbd { color: inherit; border-color: currentColor; opacity: .75; }
kbd { font: 11px var(--mono); border: 1px solid var(--line-2); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; color: var(--muted); }

.app { display: grid; grid-template-columns: 264px minmax(0, 1fr); height: 100vh; }

/* ---------- sidebar ---------- */
aside { background: var(--side); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.side-top { display: flex; align-items: center; justify-content: space-between; padding: 14px 12px 8px 16px; }
.brand { font-weight: 700; letter-spacing: -.01em; display: flex; align-items: center; gap: 8px; }
.brand .mark { width: 18px; height: 18px; display: inline-block; flex: none; }
.brand .mark rect { fill: var(--accent); }
.new-btn { display: flex; align-items: center; gap: 8px; width: calc(100% - 20px); margin: 4px 10px 10px; padding: 8px 10px; border-radius: 9px; background: var(--panel); box-shadow: var(--shadow); border: 1px solid var(--line); font-weight: 600; }
.new-btn .plus { width: 20px; height: 20px; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: grid; place-items: center; font-size: 15px; line-height: 1; }
.repo-btn { display: flex; flex-direction: column; align-items: flex-start; width: calc(100% - 20px); margin: 0 10px 8px; border: 0; background: transparent; padding: 6px 8px; text-align: left; border-radius: 8px; }
.repo-btn:hover { background: var(--panel-2); }
.repo-btn .rn { font-weight: 600; font-size: 13px; }
.repo-btn .rb { font-size: 11.5px; color: var(--muted); }
.side-label { font-size: 11px; font-weight: 600; color: var(--faint); text-transform: uppercase; letter-spacing: .07em; padding: 8px 18px 4px; display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.side-label.collapsible { cursor: pointer; user-select: none; border-radius: 6px; margin: 0 6px; padding-left: 12px; padding-right: 12px; }
.side-label.collapsible:hover { background: var(--panel-2); }
.side-label .cv { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 5px; font-size: 10px; color: var(--faint); transition: transform .15s, background .1s; margin-right: 2px; }
.side-label.collapsible:hover .cv { background: var(--panel-2); color: var(--text); }
.side-label.collapsed .cv { transform: rotate(-90deg); }
.side-label .add-skill { border: 0; background: transparent; color: var(--faint); font-size: 14px; line-height: 1; padding: 2px 6px; border-radius: 5px; text-transform: none; letter-spacing: normal; }
.side-label .add-skill:hover { background: var(--panel-2); color: var(--text); }
.sessions { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }
* { scrollbar-width: thin; scrollbar-color: var(--line-2) transparent; }
.skills { flex: none; max-height: 160px; overflow-y: auto; padding: 0 8px 8px; }
.skill-row { display: flex; align-items: center; gap: 2px; }
.skill-row .skill { flex: 1; min-width: 0; text-align: left; border: 0; background: transparent; padding: 7px 10px; border-radius: 8px; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-row .skill:hover { background: var(--panel-2); }
.skill-row .skill-del { flex: none; opacity: 0; border: 0; background: transparent; color: var(--faint); padding: 4px 7px; border-radius: 6px; font-size: 13px; }
.skill-row:hover .skill-del { opacity: 1; }
.skill-row .skill-del:hover { background: var(--panel-2); color: var(--bad); }
.skill-form { display: flex; flex-direction: column; gap: 8px; margin: 14px 0; }
.skill-form input, .skill-form textarea { font-size: 13px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); font-family: inherit; resize: vertical; }
.sess { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 7px 10px; border-radius: 8px; margin-bottom: 1px; }
.sess:hover { background: var(--panel-2); }
.sess-row { position: relative; }
.sess-row .sess-acts { position: absolute; top: 5px; right: 6px; display: none; gap: 1px; background: var(--panel-2); border-radius: 7px; }
.sess-row:hover .sess-acts, .sess-row:focus-within .sess-acts { display: flex; }
.sess-acts button { border: 0; background: transparent; color: var(--faint); padding: 3px 6px; border-radius: 6px; font-size: 12px; }
.sess-acts button:hover { color: var(--text); }
.sess-acts button.danger:hover { color: var(--bad); }
.sess-edit { width: 100%; }
.sess-confirm { display: flex; gap: 6px; align-items: center; padding: 7px 10px; font-size: 12.5px; color: var(--muted); }
.ckpt { display: flex; align-items: center; gap: 8px; padding: 4px 2px; font-size: 12px; color: var(--faint); }
.ckpt-label { font-family: var(--mono); }
.ckpt-confirm { display: flex; align-items: center; gap: 6px; }
.sess.on { background: var(--panel); box-shadow: var(--shadow); }
.sess .st { display: flex; gap: 7px; align-items: center; font-size: 13px; }
.sess .st span:last-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sess .sm { font-size: 11.5px; color: var(--faint); padding-left: 14px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; display: inline-block; }
.o-done { color: var(--ok); } .o-blocked, .o-error { color: var(--bad); } .o-stopped, .o-unfinished, .o-max_steps { color: var(--warn); } .o-running { color: var(--accent); }
.side-foot { border-top: 1px solid var(--line); padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
.side-foot .settings { display: flex; align-items: center; gap: 8px; border: 0; background: transparent; padding: 6px 6px; text-align: left; border-radius: 8px; width: 100%; }
.side-foot .settings:hover { background: var(--panel-2); }
.side-foot .settings .sub { font-size: 11.5px; color: var(--muted); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.limits { border: 0; background: transparent; padding: 4px 6px; text-align: left; border-radius: 8px; font-size: 11.5px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; width: 100%; }
.limits:hover { background: var(--panel-2); }
.limits .lrow { display: grid; grid-template-columns: 46px 1fr 1fr; gap: 8px; align-items: center; }
.limits .name { font-weight: 600; color: var(--text); }
.limits .win { display: flex; align-items: center; gap: 5px; }
.limits .bar { flex: 1; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
.limits .bar i { display: block; height: 100%; background: var(--ok); }
.limits .bar i.mid { background: var(--warn); } .limits .bar i.high { background: var(--bad); }
.limits .win.stale { opacity: .55; }
.limits .win.stale .bar { background-image: repeating-linear-gradient(45deg, var(--line) 0 3px, transparent 3px 6px); background-color: transparent; }

/* ---------- main ---------- */
main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.topbar { height: 48px; flex: none; display: flex; align-items: center; gap: 10px; padding: 0 16px; border-bottom: 1px solid transparent; }
.topbar.scrolled { border-bottom-color: var(--line); }
.topbar .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.cpbar { max-width: 780px; margin: 0 auto 8px; background: var(--accent-soft); border-radius: 12px; padding: 10px 14px; }
.cpbar-row { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.cpbar-row input { flex: 1; min-width: 0; font-size: 13px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--text); }
.crumb-wrap { max-width: 780px; margin: 0 auto 8px; }
.crumb { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--panel-2); border: 1px solid var(--line); text-align: left; }
.crumb:hover { background: var(--line); }
.crumb.empty { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.crumb .ci { font-size: 11px; }
.crumb #crumbName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 2px 9px; border-radius: 99px; background: var(--panel-2); color: var(--muted); white-space: nowrap; border: 0; }
.pill.ok { color: var(--ok); } .pill.warn { color: var(--warn); }
#menuBtn { display: none; }
.app.side-hidden #menuBtn { display: inline-block; }
.app.side-hidden { grid-template-columns: minmax(0, 1fr); }
.app.side-hidden aside { display: none; }
.scroll { flex: 1; overflow-y: auto; min-height: 0; }
.thread { max-width: 780px; margin: 0 auto; padding: 8px 24px 32px; }

.welcome { text-align: center; padding: 12vh 0 24px; }
.welcome h1 { font-family: var(--serif); font-weight: 400; font-size: 30px; margin: 0 0 8px; letter-spacing: -.01em; }
.welcome p { color: var(--muted); margin: 0 auto 22px; max-width: 480px; }
.examples { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.examples button { border-radius: 99px; font-size: 13px; color: var(--muted); }
.setup { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 20px 0; box-shadow: var(--shadow); }

.msg-user { display: flex; flex-direction: column; align-items: flex-end; margin: 22px 0 14px; }
.msg-actions { display: flex; align-items: center; gap: 2px; margin: 4px 2px 0; color: var(--faint); font-size: 12px; opacity: 0; transition: opacity .12s; }
.msg-user:hover .msg-actions, .msg-actions:focus-within, .final-wrap:hover .msg-actions { opacity: 1; }
.msg-actions .when { margin-right: 6px; }
.msg-actions button { border: 0; background: transparent; color: var(--faint); padding: 5px 6px; border-radius: 7px; display: inline-grid; place-items: center; }
.msg-actions button:hover { background: var(--panel-2); color: var(--text); }
.msg-actions svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.msg-user .bubble { background: var(--panel-2); border-radius: 14px; padding: 10px 14px; max-width: 85%; white-space: pre-wrap; word-break: break-word; }
.narr { margin: 12px 0 4px; font-family: var(--serif); font-size: 15.5px; line-height: 1.55; }
.final { margin: 16px 0 6px; font-family: var(--serif); font-size: 15.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.final code, .narr code, .bubble code, .plan code, .review code { font-family: var(--mono); font-size: .85em; background: var(--panel-2); padding: 1px 5px; border-radius: 5px; }
.work { margin: 8px 0 4px; }
.work > summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); padding: 3px 8px 3px 4px; border-radius: 8px; user-select: none; }
.work > summary::-webkit-details-marker { display: none; }
.work > summary::before { content: "›"; display: inline-block; transition: transform .12s; font-size: 15px; line-height: 1; }
.work[open] > summary::before { transform: rotate(90deg); }
.work > summary:hover { background: var(--panel-2); color: var(--text); }
.work-body { margin: 4px 0 6px 6px; padding-left: 10px; border-left: 1px solid var(--line); }
.outcome { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--muted); margin: 4px 0 18px; align-items: center; }
.outcome .lbl { font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }

.plan { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin: 10px 0 14px; box-shadow: var(--shadow); }
.plan .ph { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); margin-bottom: 8px; }
.plan .ph strong { color: var(--text); font-size: 13px; }
.plan .prog { flex: 1; height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; max-width: 140px; margin-left: auto; }
.plan .prog i { display: block; height: 100%; background: var(--ok); transition: width .3s; }
.plan ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.plan li { display: grid; grid-template-columns: 18px 1fr; gap: 8px; font-size: 13.5px; }
.plan li .box { width: 15px; height: 15px; border-radius: 4px; border: 1.5px solid var(--line-2); margin-top: 3px; display: grid; place-items: center; font-size: 10px; color: var(--on-accent); }
.plan li.done .box { background: var(--ok); border-color: var(--ok); }
.plan li.done .tx { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--line-2); }
.plan .pf { font-size: 12px; color: var(--muted); margin-top: 8px; }

.step { margin: 2px 0; }
.ctx-btn { border: 0; background: transparent; color: var(--faint); font-size: 11px; padding: 0 5px; border-radius: 6px; margin-left: 4px; }
.ctx-btn:hover { background: var(--panel-2); color: var(--text); }
.ctx { margin: 4px 0 8px 16px; padding: 8px 10px; border-left: 2px solid var(--line-2); font-size: 12px; color: var(--muted); }
.ctx h5 { margin: 0 0 4px; font-size: 12px; font-weight: 600; color: var(--text); }
.ctx .row { display: flex; gap: 8px; align-items: baseline; padding: 1px 0; }
.ctx .row .k { flex: none; min-width: 78px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--faint); }
.ctx .row .l { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx .row .n { flex: none; font-variant-numeric: tabular-nums; }
.ctx .foot { margin-top: 5px; color: var(--faint); }
.step .sh { display: flex; align-items: baseline; gap: 8px; padding: 3px 6px; margin: 0 -6px; border-radius: 7px; cursor: pointer; min-width: 0; }
.step .sh:hover { background: var(--panel-2); }
.step .sd { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; transform: translateY(-1px); }
.step.run .sd { background: var(--accent); animation: pulse 1.1s ease-in-out infinite; }
.step.ok .sd { background: var(--ok); } .step.fail .sd { background: var(--bad); }
@keyframes pulse { 50% { opacity: .35; } }
.step .verb { font-weight: 600; flex: none; }
.step .tgt { font-family: var(--mono); font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.step .meta { margin-left: auto; display: flex; gap: 8px; align-items: baseline; flex: none; font-size: 11.5px; color: var(--faint); }
.step .add { color: var(--ok); font-family: var(--mono); } .step .rem { color: var(--bad); font-family: var(--mono); }
.chip { font-size: 10.5px; font-weight: 600; padding: 0 6px; border-radius: 5px; background: var(--panel-2); }
.drawer h3 .chip { margin-left: 6px; color: var(--accent); text-transform: none; letter-spacing: normal; vertical-align: middle; padding: 2px 7px; }
.step .prev { font-family: var(--mono); font-size: 12px; color: var(--muted); padding: 0 0 2px 22px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.step .prev::before { content: "⎿  "; color: var(--faint); }
.step .sb { margin: 4px 0 8px 22px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); overflow: auto; max-height: 360px; }
.step .sb pre { margin: 0; padding: 8px 10px; font: 12px/1.5 var(--mono); white-space: pre-wrap; word-break: break-word; }
.dl { position: relative; font: 12px/1.55 var(--mono); white-space: pre; padding: 0 10px; min-height: 18px; }
.dl.a { background: var(--add-bg); color: var(--add-fg); } .dl.d { background: var(--del-bg); color: var(--del-fg); } .dl.c { color: var(--muted); }
.dl.h { color: var(--faint); background: var(--panel-2); }
.dl.a, .dl.d, .dl.c { cursor: text; }
.dl .dl-add { visibility: hidden; position: absolute; right: 4px; top: 0; border: 0; background: var(--panel-2); color: var(--muted); font-size: 11px; line-height: 16px; width: 16px; height: 16px; border-radius: 4px; padding: 0; }
.dl:hover .dl-add { visibility: visible; }
.dl.commented { box-shadow: inset 3px 0 0 var(--accent); }
.dl-comment-row { padding: 6px 10px 6px 22px; background: var(--panel-2); border-top: 1px dashed var(--line); border-bottom: 1px dashed var(--line); }
.dl-comment-row textarea { width: 100%; min-height: 42px; font: 12.5px/1.4 -apple-system, sans-serif; border: 1px solid var(--line); border-radius: 6px; padding: 5px 7px; background: var(--panel); color: var(--text); resize: vertical; }
.dl-comment-row .btns { display: flex; justify-content: flex-end; gap: 6px; margin-top: 5px; }
.dl-comment-saved { padding: 4px 10px 4px 22px; background: var(--panel-2); border-top: 1px dashed var(--line); border-bottom: 1px dashed var(--line); font-size: 12px; color: var(--text); display: flex; gap: 8px; align-items: flex-start; }
.dl-comment-saved .txt { flex: 1; white-space: pre-wrap; }
.dl-comment-saved button { color: var(--muted); border: 0; background: transparent; padding: 0; }
.notice { font-size: 12.5px; color: var(--muted); margin: 6px 0 6px 22px; font-style: italic; }
.notice.warn { color: var(--warn); } .notice.bad { color: var(--bad); font-style: normal; }
.divider { display: flex; align-items: center; gap: 10px; color: var(--faint); font-size: 11.5px; margin: 14px 0; }
.divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--line); }

.review { border-left: 3px solid var(--t-escalate); background: color-mix(in srgb, var(--t-escalate) 7%, transparent); border-radius: 0 10px 10px 0; padding: 8px 12px; margin: 10px 0; font-size: 13.5px; }
.review .rh { display: flex; gap: 8px; align-items: center; font-weight: 600; }
.review .rh .v-ok { color: var(--ok); } .review .rh .v-rev { color: var(--warn); }
.review .fb { margin-top: 4px; color: var(--muted); white-space: pre-wrap; }

.approval { border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--line)); background: color-mix(in srgb, var(--accent) 6%, var(--panel)); border-radius: 12px; padding: 12px 14px; margin: 10px 0; box-shadow: var(--shadow); }
.trust-detail { white-space: pre-wrap; font-size: 12px; max-height: 12em; overflow: auto; }
.discard-plan { margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--bad, #c0392b) 8%, transparent); font-size: 13px; }
.discard-plan > div + div { margin-top: 4px; }
.approval-warn { margin: 6px 0 2px; padding: 6px 8px; border-radius: 6px; background: color-mix(in srgb, var(--bad, #c0392b) 12%, transparent); color: var(--bad, #c0392b); font-size: 13px; }
.approval .ah { font-weight: 600; }
.approval pre { margin: 8px 0 10px; padding: 8px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; white-space: pre-wrap; word-break: break-all; font: 12.5px var(--mono); }
.approval .btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.approval.resolved { box-shadow: none; opacity: .75; padding: 8px 12px; }
.sug-row { display: flex; gap: 8px; align-items: baseline; margin: 6px 0; flex-wrap: wrap; }
.sug-row .sug-text { flex: 1; min-width: 200px; }
.approval .qt { margin: 6px 0 10px; }
.approval input[type=text] { flex: 1; min-width: 180px; }
.approval.resolved pre { margin: 4px 0 0; }

.working { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; margin: 12px 0; }
.working .spark { width: 14px; height: 14px; border-radius: 4px; background: var(--accent); animation: spin 1.6s cubic-bezier(.6,0,.4,1) infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.working .shimmer { background: linear-gradient(90deg, var(--muted) 30%, var(--text) 50%, var(--muted) 70%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: shim 1.8s linear infinite; }
@keyframes shim { from { background-position: 100% 0; } to { background-position: -100% 0; } }

.changes { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; margin: 14px 0; box-shadow: var(--shadow); overflow: hidden; }
.changes .chh { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.changes .chh strong { flex: 1; }
.cfile { border-bottom: 1px solid var(--line); }
.cfile .cfh { display: flex; gap: 10px; align-items: center; padding: 7px 14px; cursor: pointer; font: 12.5px var(--mono); }
.cfile .cfh:hover { background: var(--panel-2); }
.cfile .cfh .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cfile .cfb { max-height: 420px; overflow: auto; border-top: 1px solid var(--line); background: var(--bg); }
.commit { display: flex; gap: 8px; padding: 10px 14px; flex-wrap: wrap; }
.commit input { flex: 1 1 240px; width: auto; }
.cmsg { padding: 0 14px 10px; font-size: 12.5px; color: var(--muted); }

/* ---------- composer ---------- */
.composer-wrap { flex: none; padding: 0 24px 16px; }
.composer { position: relative; max-width: 780px; margin: 0 auto; background: var(--panel); border: 1px solid var(--line-2); border-radius: 16px; box-shadow: var(--shadow); padding: 10px 12px 8px; }
.composer:focus-within { border-color: color-mix(in srgb, var(--accent) 50%, var(--line-2)); }
.banner { font-size: 12.5px; border-radius: 9px; padding: 8px 10px; margin-bottom: 8px; }
.banner.warn { background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--text); }
.banner.bad { background: color-mix(in srgb, var(--bad) 12%, transparent); color: var(--bad); }
.banner ul { margin: 4px 0 6px; padding-left: 18px; }
#input { width: 100%; border: 0; background: transparent; resize: none; outline: none; font-size: 15px; line-height: 1.5; max-height: 240px; min-height: 26px; padding: 2px 2px; }
/* Two purpose-built rows instead of one flat row that wraps unpredictably: settings (attach, model,
   toggles) left-aligned and free to wrap on its own; actions (compact, usage, send) a tight cluster
   pinned right, never stretched across the full width — the old single flex row with one spacer put
   the spacer wherever it happened to land after a wrap, leaving a large empty gap on a short second line. */
.cbar { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.cbar-settings { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
.cbar-actions { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.cbar .mchip { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; padding: 3px 7px; border-radius: 8px; font-size: 12.5px; color: var(--muted); max-width: 320px; }
.cbar .mchip:hover { background: var(--panel-2); color: var(--text); }
.cbar .mchip span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.attached { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px 0; }
.mention-pop { position: absolute; bottom: calc(100% + 6px); left: 12px; right: 12px; max-height: 200px; overflow-y: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); z-index: 5; }
.mention-pop .mi { padding: 6px 12px; font-size: 12.5px; font-family: var(--mono); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mention-pop .mi.sel, .mention-pop .mi:hover { background: var(--accent-soft); color: var(--accent); }
.mention-pop .mi.empty { color: var(--muted); font-family: inherit; cursor: default; }
.attached .att { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 4px 3px 8px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line); max-width: 220px; }
.attached .att span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attached .att button { padding: 0 6px; border: 0; background: transparent; color: var(--muted); }
.tog { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); padding: 3px 6px; border-radius: 8px; cursor: pointer; user-select: none; }
.tog:hover { background: var(--panel-2); }
.tog input { accent-color: var(--accent); margin: 0; }
.usage { font-size: 11.5px; color: var(--faint); white-space: nowrap; display: inline-flex; align-items: baseline; gap: 5px; }
.usage-cost { font-size: 12.5px; color: var(--muted); font-weight: 600; }
.usage-tok { color: var(--faint); }
.send { width: 30px; height: 30px; border-radius: 50%; padding: 0; display: grid; place-items: center; background: var(--accent); border: 0; color: var(--on-accent); font-size: 15px; font-weight: 700; flex-shrink: 0; }
.send:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
.send:disabled { opacity: .45; }
.stop { width: 30px; height: 30px; border-radius: 50%; padding: 0; display: grid; place-items: center; background: var(--text); color: var(--bg); border: 0; flex-shrink: 0; }
.stop i { width: 10px; height: 10px; background: currentColor; border-radius: 2px; }
.hint { max-width: 780px; margin: 6px auto 0; text-align: center; font-size: 11px; color: var(--faint); }

/* ---------- drawer + overlays ---------- */
.scrim { position: fixed; inset: 0; background: rgba(0,0,0,.25); z-index: 30; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(380px, 100%); background: var(--panel); border-left: 1px solid var(--line); z-index: 31; display: flex; flex-direction: column; box-shadow: -10px 0 40px rgba(0,0,0,.12); }
.drawer .dh { display: flex; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.drawer .dh strong { flex: 1; font-size: 15px; }
.drawer .db { overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 4px; }
.drawer h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--faint); margin: 12px 0 6px; }
.drawer h3:first-child { margin-top: 0; }
.drawer h3 small { display: block; text-transform: none; letter-spacing: normal; font-weight: 400; color: var(--muted); margin-top: 2px; }
.upd { display: flex; align-items: center; gap: 10px; flex: none; padding: 8px 16px; background: var(--accent-soft); border-bottom: 1px solid var(--line); font-size: 13px; }
.upd .u-msg { flex: 1; min-width: 0; }
.upd .u-list { color: var(--muted); font-size: 12px; }
.errcard { border: 1px solid var(--line); border-left: 3px solid var(--warn); background: var(--panel); border-radius: 10px; padding: 12px 14px; margin: 0 0 18px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; font-size: 13px; }
.ver { font-size: 11px; color: var(--faint); padding: 0 6px; }
.diag { width: 100%; font-family: var(--mono); font-size: 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); padding: 8px; }
.about { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; font-size: 13px; }
.gs { border: 1px solid var(--line); background: var(--panel); border-radius: 14px; padding: 16px 18px; margin: 0 0 16px; }
.gs h2 { font-family: var(--serif); font-weight: 400; font-size: 19px; margin: 0 0 4px; }
.gs .gs-sub { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
.gs .gs-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 13px; }
.gs .gs-row .gs-name { font-weight: 600; min-width: 92px; }
.gs .gs-row .gs-note { flex: 1; color: var(--muted); min-width: 0; }
.gs .gs-row input { flex: 1; min-width: 0; font-size: 12.5px; padding: 6px 8px; border-radius: 7px; border: 1px solid var(--line); background: var(--bg); }
.gs .gs-row select { font-size: 12.5px; padding: 5px 6px; border-radius: 7px; border: 1px solid var(--line); background: var(--bg); }
.gs .gs-ok { color: var(--ok); }
.gs code { font-family: var(--mono); font-size: 12px; background: var(--panel-2); padding: 1px 5px; border-radius: 4px; }
.connector-form { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
.connector-form input { font-size: 12.5px; padding: 7px 9px; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); }
.connector-form button { align-self: flex-start; }
.conn-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 13px; }
.conn-row .cn { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conn-row .cc { color: var(--muted); font-size: 11.5px; font-family: var(--mono); }
.conn-row button { flex: none; border: 0; background: transparent; color: var(--faint); padding: 3px 6px; border-radius: 6px; font-size: 12px; }
.conn-row button:hover { background: var(--panel-2); color: var(--bad); }
.pinfo { font-size: 12px; color: var(--muted); margin: 6px 0 8px; }
.pinfo a { color: var(--accent); }
.subrow { display: flex; gap: 6px; margin: 2px 0 8px; align-items: center; flex-wrap: wrap; }
.subrow input { flex: 1 1 140px; width: auto; }
.subrow .status { font-size: 12px; color: var(--ok); flex: 1 1 auto; }
.slot { display: grid; grid-template-columns: 24px 1fr; gap: 3px 10px; align-items: center; margin-bottom: 10px; }
.slot .num { width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; font-weight: 700; font-size: 12px; color: #fff; }
.slot label { font-size: 12px; color: var(--muted); }
.slot input, .slot select { grid-column: 2; min-width: 0; }
.freeonly { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); margin: -2px 0 8px 34px; }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 3px; }
.check { display: flex; gap: 9px; align-items: flex-start; margin: 8px 0; font-size: 13px; }
.check input { margin-top: 3px; accent-color: var(--accent); }
.check small { display: block; color: var(--muted); font-size: 12px; }
.callout { font-size: 12px; line-height: 1.5; color: var(--muted); background: var(--accent-soft); border-radius: 8px; padding: 9px 11px; margin: 4px 0 10px; }
.callout strong { color: var(--text); }
.sgroup { border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); padding: 0 12px; margin: 8px 0; }
.sindent { margin: 0 0 4px 16px; padding-left: 12px; border-left: 2px solid var(--line); }
.trow { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 11px 0; font-size: 13px; cursor: pointer; }
.trow + .trow, .sgroup .sindent { border-top: 1px solid var(--line); }
.trow.sub { padding: 8px 0; font-size: 12.5px; }
.trow.dim { cursor: default; }
.trow.dim .tt { opacity: .45; }
.impact { display: inline-block; margin-left: 7px; font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 5px; vertical-align: middle; text-transform: none; }
.impact.save { background: var(--add-bg); color: var(--add-fg); }
.impact.neutral { background: var(--panel); color: var(--faint); border: 1px solid var(--line); }
.impact.cost { background: var(--del-bg); color: var(--del-fg); }
.trow.sub + .trow.sub { border-top: 1px solid var(--line); }
.trow .tt { flex: 1; min-width: 0; }
.trow .tt strong { font-weight: 600; }
.trow small { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; line-height: 1.4; }
.switch { position: relative; flex: none; width: 34px; height: 20px; margin-top: 1px; }
.switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.switch i { position: absolute; inset: 0; background: var(--line-2); border-radius: 999px; transition: background .15s; pointer-events: none; }
.switch i::before { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; background: #fff; border-radius: 50%; transition: transform .15s; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
.switch input:checked + i { background: var(--accent); }
.switch input:checked + i::before { transform: translateX(14px); }
.switch input:disabled + i { opacity: .4; }
.switch input:disabled ~ * { cursor: default; }
.switch input:focus-visible + i { outline: 2px solid var(--accent); outline-offset: 2px; }
.frow { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 11px 0; font-size: 13px; }
.frow + .frow { border-top: 1px solid var(--line); }
.frow label { font-weight: 600; }
.frow small { display: block; color: var(--muted); font-size: 12px; font-weight: 400; margin-top: 2px; line-height: 1.4; }
.frow select { flex: none; width: 160px; min-width: 0; }
.note { font-size: 12px; color: var(--warn); margin-top: 6px; }
.saved { font-size: 12px; color: var(--ok); min-height: 16px; }
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--bg) 70%, transparent); backdrop-filter: blur(6px); display: grid; place-items: center; z-index: 40; padding: 16px; }
.wn { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 10px; }
.wn-d { color: var(--muted); font-size: 13px; white-space: pre-wrap; margin-top: 2px; }
.modal { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; width: min(560px, 100%); max-height: 85vh; overflow-y: auto; padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,.2); }
.modal h1 { font-family: var(--serif); font-weight: 400; font-size: 24px; margin: 0 0 4px; }
.modal .recent { display: flex; flex-direction: column; gap: 6px; margin: 16px 0; }
.modal .recent button { text-align: left; padding: 9px 12px; }
.modal .recent .path { font-size: 11.5px; color: var(--muted); display: block; }
.modal .open-row { display: flex; gap: 8px; }

@media (max-width: 820px) {
  .app { grid-template-columns: 1fr; }
  aside { position: fixed; inset: 0 auto 0 0; width: 280px; z-index: 35; transform: translateX(-100%); transition: transform .2s; }
  .app.side-open aside { transform: none; box-shadow: 10px 0 40px rgba(0,0,0,.2); }
  #menuBtn { display: inline-block; }
  .app.side-hidden { grid-template-columns: 1fr; }
  .app.side-hidden aside { display: flex; }
  .thread { padding: 8px 16px 24px; }
  .composer-wrap { padding: 0 12px 12px; }
  .cbar .mchip { max-width: 160px; }
}
</style>
<script>try { var t = localStorage.getItem("nb-theme"); if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); } catch (e) {}</script>
</head>
<body>
<div class="app" id="app">
  <aside>
    <div class="side-top"><span class="brand"><svg class="mark" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="20" y="25" width="8" height="50"/><rect x="20" y="25" width="20" height="8"/><rect x="20" y="67" width="20" height="8"/><rect x="72" y="25" width="8" height="50"/><rect x="60" y="25" width="20" height="8"/><rect x="60" y="67" width="20" height="8"/><rect x="44" y="44" width="12" height="12"/></svg>Narrowbit</span><button class="ghost" id="hideSideBtn" title="Hide sidebar (Cmd/Ctrl+B)" aria-label="Hide sidebar">⇤</button></div>
    <button class="new-btn" id="newBtn"><span class="plus">+</span>New task <span style="margin-left:auto"><kbd>⌘</kbd> <kbd>K</kbd></span></button>
    <button class="repo-btn" id="repoBtn" title="Switch repository"><span class="rn" id="repoName">Choose a folder</span><span class="rb" id="repoBranch"></span></button>
    <div class="side-label">Sessions</div>
    <div class="sessions" id="sessions"></div>
    <div class="side-label collapsible" id="skillsLabel"><span><span class="cv" id="skillsChevron">▾</span>Skills</span><button class="add-skill" id="addSkillBtn" title="New skill">+</button></div>
    <div class="skills" id="skillsList"></div>
    <div class="side-label" id="memLabel">Memory</div>
    <div class="skills" id="memList"></div>
    <div class="side-foot">
      <button class="settings" id="settingsBtn"><span style="font-size:16px">⚙</span><span style="min-width:0"><span>Models &amp; settings</span><span class="sub" id="settingsSub"></span></span></button>
      <button class="limits" id="limits" title="Subscription usage"></button>
      <div class="ver" id="verLine"></div>
    </div>
  </aside>

  <main>
    <div class="upd hidden" id="updBar"></div>
    <div class="topbar" id="topbar">
      <button class="ghost" id="menuBtn" aria-label="Show sidebar" title="Show sidebar (Cmd/Ctrl+B)">⇥</button>
      <span class="title" id="title"></span>
      <button class="pill hidden" id="planMini"></button>
      <span class="pill hidden" id="treePill"></span>
      <button class="pill warn hidden" id="pushPill" title="Push your commits to the remote"></button>
      <button class="pill hidden" id="publishPill" title="Create a GitHub repository for this project">Publish to GitHub</button>
      <button class="ghost" id="themeBtn" aria-label="Theme"></button>
    </div>
    <div class="scroll" id="scroll">
      <div class="thread" id="thread">
        <div class="welcome hidden" id="welcome">
          <h1 id="welcomeTitle">What should we work on?</h1>
          <p>Narrowbit plans with your strongest model, does the work with cheaper ones, and asks before running commands. You review the diff before anything is committed.</p>
          <div class="examples" id="examples"></div>
        </div>
        <div class="gs hidden" id="getStarted"></div>
        <div class="setup hidden" id="missingCard">
          <strong>Can't find this project's folder</strong>
          <p class="muted" style="margin:6px 0 4px" id="missingPath"></p>
          <p class="muted" style="margin:0 0 12px">It may have been renamed, moved, or is on a drive that isn't connected right now. Nothing was lost — point Narrowbit at wherever it is now.</p>
          <button class="primary" id="locateBtn">Locate folder…</button>
        </div>
        <div class="setup hidden" id="setupCard">
          <strong>Narrowbit isn't set up in this repository yet.</strong>
          <p class="muted" style="margin:6px 0 12px">This creates a local <span class="mono">.narrowbit/</span> folder (git-ignored) and indexes the code. Nothing leaves your Mac.</p>
          <button class="primary" id="initBtn">Set up Narrowbit here</button>
        </div>
        <div id="items"></div>
        <div id="changesSlot"></div>
      </div>
    </div>
    <div class="composer-wrap">
      <div class="cpbar hidden" id="createProjectBar">
        <div class="cpbar-row">
          <span>Ready to start building this for real?</span>
          <button class="primary" id="cpbarOpen">Choose a folder</button>
        </div>
      </div>
      <div class="crumb-wrap" id="crumbWrap"><button class="crumb" id="crumb" title="Switch repository"><span class="ci">📁</span><span id="crumbName"></span></button> <button class="crumb hidden" id="ghCrumb" title="Open this repository on GitHub"><span class="ci">⎇</span><span id="ghName"></span></button></div>
      <div class="composer">
        <div id="banner" class="banner hidden"></div>
        <div id="attached" class="attached hidden"></div>
        <div class="mention-pop hidden" id="mentionPop"></div>
        <textarea id="input" rows="1" placeholder="Describe a task… (@ to mention a file)"></textarea>
        <div class="cbar">
          <div class="cbar-actions">
            <button class="ghost hidden" id="compactBtn" title="Start a fresh session from a short summary of this chat — smaller context, nothing lost from the files or your saved notes">Compact</button>
            <span class="usage" id="usage"></span>
            <button class="stop hidden" id="stopBtn" title="Stop after the current step"><i></i></button>
            <button class="send" id="sendBtn" title="Send (Enter)">↑</button>
          </div>
          <div class="cbar-settings">
            <button class="ghost" id="attachBtn" title="Attach an image or PDF (or paste or drop one)">📎</button>
            <input type="file" id="attachInput" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" multiple class="hidden">
            <button class="mchip" id="modelChip" title="Models &amp; settings"><span id="modelChipText"></span>▾</button>
            <label class="tog" title="Model 3 plans the task first and reviews the diff before it's done"><input type="checkbox" id="leadTog"> Lead</label>
            <label class="tog" title="Work in a separate copy of the folder; nothing changes your files until you press Apply"><input type="checkbox" id="isoTog"> Isolate</label>
            <label class="tog" title="Shell commands wait for your approval"><input type="checkbox" id="askTog"> Ask before commands</label>
          </div>
        </div>
      </div>
      <div class="hint" id="hint">Enter to send · Shift+Enter for a new line</div>
    </div>
  </main>
</div>

<div class="scrim hidden" id="scrim"></div>
<div class="drawer hidden" id="drawer" role="dialog" aria-label="Models and settings">
  <div class="dh"><strong>Models &amp; settings</strong><button class="ghost" id="closeDrawer" aria-label="Close">✕</button></div>
  <div class="db">
    <h3>Provider</h3>
    <select id="providerSel" aria-label="Provider"></select>
    <div class="pinfo hidden" id="providerInfo"></div>
    <div id="keyRow" class="subrow hidden"></div>
    <div id="urlRow" class="subrow hidden"></div>
    <datalist id="modelList"></datalist>
    <h3>Models</h3>
    <div id="slots"></div>
    <div class="row2">
      <div class="field"><label for="effort">Effort</label><select id="effort"></select></div>
      <div class="field"><label for="maxSteps">Max steps</label><input type="number" id="maxSteps" min="1" max="100" value="20"></div>
    </div>
    <h3>Behaviour<span class="chip" id="modeLabel"></span></h3>
    <div class="callout">Solo (nothing below turned on) already used <strong>~75-90% fewer tokens than native Claude Code</strong> and <strong>~63% fewer than native Codex</strong>, in our tests (Hono, 10-40 tasks, equal success — see the README). <strong>Everything below is ranked against Solo</strong>, not against the native app: saves some, then no change, then costs more.</div>
    <div class="sgroup">
      <div class="frow"><label for="scoutSel">Scout<span class="impact save">saves ~25-30%</span><small>A cheaper model reads the code first and hands the worker a short report. Spends a different provider's usage to save this one's.</small></label><select id="scoutSel"></select></div>
    </div>
    <div class="sgroup">
      <div class="frow"><label for="fallbackSel">Backup<span class="impact neutral">no change</span><small>If this provider hits a limit or fails, continue on</small></label><select id="fallbackSel"></select></div>
      <label class="trow"><span class="tt">Ask before running commands<span class="impact neutral">no change</span><small>Reads, edits and verify run freely; shell commands wait for you.</small></span><span class="switch"><input type="checkbox" id="askChk"><i></i></span></label>
    </div>
    <div class="sgroup">
      <label class="trow"><span class="tt"><strong>Lead mode</strong><span class="impact cost">costs 25-57% more</span><small>Model 3 writes a plan before work starts and reviews the diff before it's reported done. Two extra calls to your strongest model per task.</small></span><span class="switch"><input type="checkbox" id="leadChk"><i></i></span></label>
      <div class="sindent">
        <label class="trow sub"><span class="tt">Approve plan first<span class="impact neutral">no change</span><small>Show you the plan before work starts — approve it, or ask for changes (one round). Needs Lead mode on.</small></span><span class="switch"><input type="checkbox" id="planApprovalChk"><i></i></span></label>
        <label class="trow sub"><span class="tt">Review only<span class="impact cost">costs the most</span><small>Skip the plan call; still review the diff before "done" — tested worse than everything else here. Off while Lead mode is on.</small></span><span class="switch"><input type="checkbox" id="reviewOnlyChk"><i></i></span></label>
      </div>
    </div>
    <div class="note hidden" id="providerNote"></div>
    <div class="saved" id="savedMsg"></div>

    <h3>GitHub<small>Where "Push" sends your commits, and who it counts as</small></h3>
    <div id="githubBox" class="muted" style="font-size:12.5px;padding:4px 0 14px"></div>
    <h3>Connectors<small>MCP servers the agent can call out to — GitHub, Slack, anything with an MCP server</small></h3>
    <div id="connectorsList"></div>
    <div class="connector-form">
      <input type="text" id="connName" placeholder="Name (e.g. github)">
      <input type="text" id="connUrl" placeholder="Remote server URL (e.g. https://mcp.linear.app/mcp) — or a command below">
      <input type="password" id="connAuth" placeholder="API token for a remote server (optional): Bearer ghp_…" autocomplete="off">
      <input type="text" id="connCommand" placeholder="Command (e.g. npx)">
      <input type="text" id="connArgs" placeholder="Args, space-separated (e.g. -y @modelcontextprotocol/server-github)">
      <input type="text" id="connEnv" placeholder="Env (optional): KEY=value,KEY2=value2">
      <button id="addConnector">Add connector</button>
    </div>
    <div class="note hidden" id="connectorErr" style="color:var(--bad)"></div>

    <h3>About</h3>
    <div class="about" id="aboutInfo"></div>
  </div>
</div>

<div class="overlay hidden" id="whatsNew">
  <div class="modal">
    <div id="whatsNewBody"></div>
    <div style="text-align:right;margin-top:14px"><button class="primary" id="whatsNewClose">Got it</button></div>
  </div>
</div>
<div class="overlay hidden" id="repoOverlay">
  <div class="modal">
    <h1>Choose a folder</h1>
    <p class="muted" style="margin:0">Pick an existing project, or a new or empty folder to start one there. Narrowbit works directly in it — edits are real, you review and commit them here.</p>
    <div class="recent" id="recentList"></div>
    <div class="open-row">
      <input type="text" id="repoPath" placeholder="/path/to/your/project" class="mono">
      <button id="pickFolder" class="hidden">Choose…</button>
      <button class="primary" id="openRepo">Open</button>
    </div>
    <div class="note hidden" id="repoErr" style="color:var(--bad)"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px">
      <button class="link hidden" id="startNoFolder">Start without a folder</button>
      <button class="link hidden" id="closeRepo">Cancel</button>
    </div>
  </div>
</div>

<div class="overlay hidden" id="ghCreateOverlay">
  <div class="modal">
    <h1>Publish to GitHub</h1>
    <p class="muted" style="margin:0">Creates a new GitHub repository from this project and adds it as the remote — nothing is pushed yet, that's still the ordinary Push button, right after this.</p>
    <div class="open-row">
      <input type="text" id="ghRepoName" placeholder="repo-name" class="mono">
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:6px"><input type="checkbox" id="ghPrivate" checked> Private repository</label>
    <div class="note hidden" id="ghCreateErr" style="color:var(--bad)"></div>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:14px">
      <button class="link" id="ghCreateCancel">Cancel</button>
      <button class="primary" id="ghCreateGo">Create</button>
    </div>
  </div>
</div>

<div class="overlay hidden" id="skillOverlay">
  <div class="modal">
    <h1>New skill</h1>
    <p class="muted" style="margin:0">A reusable set of instructions you can apply to any task, without retyping it.</p>
    <div class="skill-form" style="margin-bottom:6px">
      <div style="display:flex;gap:6px"><input type="text" id="skillUrl" placeholder="Or import from GitHub: a link to a SKILL.md, a folder or a repo"><button id="findSkill">Find</button></div>
      <select id="skillPick" class="hidden" aria-label="Skills found"></select>
      <div class="note hidden" id="skillImportNote"></div>
    </div>
    <div class="skill-form">
      <input type="text" id="skillName" placeholder="Name (e.g. Bug Fix)">
      <input type="text" id="skillDesc" placeholder="Description (optional)">
      <textarea id="skillBody" rows="6" placeholder="Instructions…"></textarea>
    </div>
    <div class="note hidden" id="skillErr" style="color:var(--bad)"></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button class="link" id="closeSkill">Cancel</button><button class="primary" id="saveSkill">Save</button></div>
  </div>
</div>

<script>
(function () {
  // The only theme control: the ☀/☾ button in the top bar (cycles auto → light → dark). Used to also have a
  // dropdown in Appearance settings; removed as redundant once the button existed, so this is the one place
  // theme state is read, applied and stored.
  var btn = document.getElementById("themeBtn");
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  function get() { try { return localStorage.getItem("nb-theme") || "auto"; } catch (e) { return "auto"; } }
  function resolved(v) { return v === "auto" ? (mq.matches ? "dark" : "light") : v; }
  function render() {
    var v = get();
    var r = resolved(v);
    btn.textContent = r === "dark" ? "☾" : "☀";
    btn.title = "Theme: " + (v === "auto" ? "Match my Mac (currently " + r + ")" : v[0].toUpperCase() + v.slice(1)) + " — click to change";
  }
  function apply(v) {
    try { localStorage.setItem("nb-theme", v); } catch (e) {}
    if (v === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", v);
    render();
  }
  btn.addEventListener("click", function () { apply({ auto: "light", light: "dark", dark: "auto" }[get()]); });
  mq.addEventListener("change", render);
  render();
})();
(function () {
  "use strict";
  var T = new URLSearchParams(location.search).get("t") || "";
  var native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.narrowbit;
  var BT = String.fromCharCode(96); // a backtick; a literal one would end this TS template
  var S = null;             // last /api/state
  var draft = null;         // provider being edited in the drawer
  var modelLists = {};      // provider -> /api/models
  var es = null;            // run event stream
  var run = { active: false, taskId: null };   // what the server is running
  var view = null;          // the conversation on screen

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, props) {
    var n = document.createElement(tag);
    if (props) for (var k in props) {
      var v = props[k];
      if (v == null) continue;
      if (k === "text") n.textContent = v;
      else if (k === "cls") n.className = v;
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function show(n, on) { n.classList.toggle("hidden", !on); }
  function fmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n); }
  function money(x) { return "$" + (x || 0).toFixed(x >= 1 ? 2 : 3); }
  function ago(iso) {
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago";
  }
  function dur(ms) { var s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s"; }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem("nb." + k); localStorage.setItem("nb." + k, v); } catch (e) { return null; } }
  // Inline code spans only: the model's summaries use backticks for identifiers.
  function rich(text) {
    var f = document.createDocumentFragment();
    String(text || "").split(BT).forEach(function (part, i) { f.appendChild(i % 2 ? el("code", { text: part }) : document.createTextNode(part)); });
    return f;
  }
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
  function banner(kind, content) {
    var b = $("banner");
    if (!content) { show(b, false); return; }
    clear(b); b.className = "banner " + kind;
    b.appendChild(typeof content === "string" ? document.createTextNode(content) : content);
  }
  function flash(n, msg) { n.textContent = msg; clearTimeout(n._t); n._t = setTimeout(function () { n.textContent = ""; }, 2400); }
  var scroller = $("scroll");
  function nearBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120; }
  function follow(fn, force) { var atEnd = nearBottom(); fn(); if (atEnd || force) scroller.scrollTop = scroller.scrollHeight; }
  scroller.addEventListener("scroll", function () { $("topbar").classList.toggle("scrolled", scroller.scrollTop > 4); });

  // ---------- state ----------
  function load() { return api("/api/state").then(apply).catch(function (e) { banner("bad", e.message); }); }
  function apply(state) {
    var first = !S;
    S = state;
    renderRepo();
    renderVersion();
    show($("repoOverlay"), false);
    if (!S.root) {
      show($("welcome"), !S.missingRoot && (!view || !view.taskId));
      show($("setupCard"), false);
      show($("missingCard"), !!S.missingRoot);
      if (S.missingRoot) $("missingPath").textContent = S.missingRoot;
      if (S.providers) { draft = { root: null, provider: S.selection.provider, effort: S.selection.effort }; renderSettings(); renderConnectors(); if (!S.missingRoot) renderGetStarted(); else show($("getStarted"), false); }
      renderSessions(); renderComposer();
      if (first) blankView();
      return;
    }
    if (!draft || draft.root !== S.root) draft = { root: S.root, provider: S.selection.provider, effort: S.selection.effort };
    run.active = S.running; if (S.running) run.taskId = S.runningTask;
    renderSessions(); renderSettings(); renderComposer(); renderSkills(); renderMemory(); renderConnectors(); renderGetStarted();
    show($("setupCard"), !S.initialized);
    if (first) {
      if (S.running && S.runningTask) openSession(S.runningTask);
      else blankView();
    }
    if (!es) connect();
  }
  function renderRepo() {
    $("repoName").textContent = S && S.root ? S.name : S && S.missingRoot ? "Project not found" : "Choose a folder";
    $("repoBranch").textContent = S && S.git && S.git.branch ? S.git.branch + (S.git.head ? " · " + S.git.head : "") : "";
    $("welcomeTitle").textContent = S && S.root ? "What should we work on in " + S.name + "?" : "What should we work on?";
    // Persistent breadcrumb above the chat, not just the sidebar — visible in every view (idle or
    // mid-session), so which repo you're in never depends on remembering to check the sidebar.
    var hasRepo = !!(S && S.root);
    show($("crumbWrap"), true);
    $("crumb").classList.toggle("empty", !hasRepo);
    var gh = hasRepo && S.remote && S.remote.webUrl;
    show($("ghCrumb"), !!gh);
    if (gh) { $("ghName").textContent = S.remote.repoName; $("ghCrumb").dataset.url = S.remote.webUrl; }
    $("crumbName").textContent = hasRepo ? S.name + (S.git && S.git.branch ? " · " + S.git.branch : "") : S && S.missingRoot ? "Project not found — locate it" : "Choose a folder to start";
    var t = $("treePill");
    if (S && S.git && S.git.isRepo) {
      var n = S.git.changed.length + S.git.untracked.filter(function (f) { return f !== ".narrowbitignore"; }).length;
      clear(t).appendChild(el("span", { cls: "dot" }));
      t.appendChild(document.createTextNode(n ? n + " uncommitted" : "clean"));
      t.className = "pill " + (n ? "warn" : "ok");
      show(t, true);
    } else show(t, false);
    renderPush();
  }
  // Push is always an explicit, two-step click (arm, then confirm) — never automatic.
  var pushArm = null;
  function renderPush() {
    var b = $("pushPill"), r = S && S.remote;
    // A local-only project (created via "Choose a folder", never touched GitHub) has no remote at all —
    // offer to publish one instead of just hiding both pills with no way forward.
    show($("publishPill"), !!(S && S.root && S.git && S.git.isRepo && r && !r.hasRemote));
    if (!S || !S.root || !r || !r.hasRemote || !r.ahead) { show(b, false); return; }
    var where = r.upstream || "origin";
    b.textContent = pushArm ? "Click again to push to " + where : "↑ " + r.ahead + " to push";
    b.title = "Push " + r.ahead + " commit" + (r.ahead === 1 ? "" : "s") + " to " + where + " — Models & settings shows which GitHub account and repo";
    show(b, true);
  }
  $("pushPill").onclick = function () {
    if (!pushArm) { pushArm = setTimeout(function () { pushArm = null; renderPush(); }, 4000); renderPush(); return; }
    clearTimeout(pushArm); pushArm = null;
    var b = $("pushPill"); b.textContent = "Pushing…"; b.disabled = true;
    api("/api/push", {}).then(function (r) { b.disabled = false; apply(r.state); banner("", null); flash($("savedMsg"), r.message); showToast(r.message); })
      .catch(function (e) { b.disabled = false; renderPush(); banner("bad", e.message); });
  };
  // Publishing is a separate, explicit step from creating the project (planning.ts's createProjectFromDraft
  // never touches GitHub) — this is that step: create the repo and add it as the remote, but don't push.
  // The ordinary Push pill takes over for the actual push once a remote exists.
  $("publishPill").onclick = function () {
    $("ghRepoName").value = (S && S.name || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    $("ghPrivate").checked = true;
    show($("ghCreateErr"), false);
    show($("ghCreateOverlay"), true);
    $("ghRepoName").focus();
  };
  $("ghCreateCancel").onclick = function () { show($("ghCreateOverlay"), false); };
  $("ghCreateOverlay").onclick = function (e) { if (e.target === this) show(this, false); };
  function ghCreateGo() {
    var name = $("ghRepoName").value.trim();
    if (!name) { $("ghRepoName").focus(); return; }
    $("ghCreateGo").disabled = true;
    api("/api/github/create-repo", { name: name, private: $("ghPrivate").checked }).then(function (r) {
      $("ghCreateGo").disabled = false;
      show($("ghCreateOverlay"), false);
      apply(r.state);
      showToast(r.message + " Click Push when you're ready to publish your commits.");
    }).catch(function (e) {
      $("ghCreateGo").disabled = false;
      var n = $("ghCreateErr"); n.textContent = e.message; show(n, true);
    });
  }
  $("ghCreateGo").onclick = ghCreateGo;
  $("ghRepoName").addEventListener("keydown", function (e) { if (e.key === "Enter") ghCreateGo(); });
  function showToast(text) { var n = el("div", { cls: "notice", text: text }); add(n); }
  // One merged, recency-sorted list across every recent project plus rootless drafts (like Claude.ai's
  // single chat list) rather than only ever showing whichever one project happens to be open — each row
  // carries its own project tag, and opening one not in the currently-open project switches to it first.
  function switchToSession(r) {
    if (r.project === "Planning") { openDraft(r.id); closeSide(); return; }
    if (S && r.projectRoot === S.root) { openSession(r.id); closeSide(); return; }
    api("/api/repo", { path: r.projectRoot }).then(function (st) {
      if (es) { es.close(); es = null; }
      draft = null; S = null; modelLists = {};
      apply(st);
      openSession(r.id);
      closeSide();
    }).catch(function (e) {
      // A question the folder dialog knows how to ask (trust this repo?) — ask it there instead of a dead-end banner.
      if (e.status === 409 && e.data && (e.data.error === "untrusted" || e.data.error === "confirm-create")) { closeSide(); openRepoPicker(true); $("repoPath").value = r.projectRoot; openRepo(r.projectRoot); return; }
      banner("bad", e.message);
    });
  }
  function renderSessions() {
    var box = clear($("sessions"));
    var drafting = !(S && S.root);
    if (!S || !S.history || !S.history.length) { box.appendChild(el("div", { cls: "muted", style: "font-size:12.5px;padding:6px 10px", text: drafting ? "No conversations yet — describe what you want to build." : "No sessions yet." })); return; }
    S.history.forEach(function (r) {
      var live = run.active && run.taskId === r.id;
      var sameProject = r.project === "Planning" ? drafting : !!(S && r.projectRoot === S.root);
      var label = r.project && !sameProject ? r.project + " · " + r.goal : r.goal;
      var b = el("button", { cls: "sess" + (view && view.taskId === r.id ? " on" : ""), title: label, onclick: function () { switchToSession(r); } },
        el("div", { cls: "st" }, el("span", { cls: "dot o-" + (live ? "running" : r.outcome) }), el("span", { text: label })),
        el("div", { cls: "sm", text: (live ? "running" : ago(r.last)) + (r.turns > 1 ? " · " + r.turns + " messages" : "") + " · " + fmt(r.tokens) + " tok" }));
      var row = el("div", { cls: "sess-row" }, b);
      // Rename/delete act on whatever project is currently open — only offered for a row that's actually
      // in it, so a click can never silently rename or delete a session in some other project.
      if (!live && sameProject && r.project !== "Planning") {
        row.appendChild(el("div", { cls: "sess-acts" },
          el("button", { title: "Rename", "aria-label": "Rename", onclick: function (e) { e.stopPropagation(); renameSession(r, row, b); } }, "✎"),
          el("button", { cls: "danger", title: "Delete", "aria-label": "Delete", onclick: function (e) { e.stopPropagation(); confirmDelete(r, row, b); } }, "🗑")));
      }
      box.appendChild(row);
    });
  }
  // The window's own prompt()/confirm() dialogs aren't reliable in the native shell, so both are inline.
  function renameSession(r, row, b) {
    var inp = el("input", { type: "text", cls: "sess-edit", value: r.goal, "aria-label": "Session name" });
    var finish = function (save) {
      if (!save) { renderSessions(); return; }
      api("/api/session/rename", { id: r.id, title: inp.value }).then(function (st) { apply(st); if (view && view.taskId === r.id && inp.value.trim()) $("title").textContent = inp.value.trim(); }).catch(function (e) { banner("bad", e.message); renderSessions(); });
    };
    inp.onkeydown = function (e) { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); e.stopPropagation(); };
    inp.onblur = function () { finish(true); };
    row.replaceChild(inp, b); var acts = row.querySelector(".sess-acts"); if (acts) acts.remove();
    inp.focus(); inp.select();
  }
  function confirmDelete(r, row, b) {
    var box = el("div", { cls: "sess-confirm" }, el("span", { text: "Delete this chat?" }),
      el("button", { cls: "danger", text: "Delete", onclick: function () {
        api("/api/session/delete", { id: r.id }).then(function (st) { var wasOpen = view && view.taskId === r.id; apply(st); if (wasOpen) blankView(); }).catch(function (e) { banner("bad", e.message); renderSessions(); });
      } }),
      el("button", { text: "Cancel", onclick: function () { renderSessions(); } }));
    row.replaceChild(box, b); var acts = row.querySelector(".sess-acts"); if (acts) acts.remove();
  }

  // ---------- skills ----------
  function renderSkills() {
    var box = clear($("skillsList"));
    var list = (S && S.skills) || [];
    if (!list.length) { box.appendChild(el("div", { cls: "muted", style: "font-size:12.5px;padding:6px 10px", text: "No skills yet." })); return; }
    list.forEach(function (sk) {
      box.appendChild(el("div", { cls: "skill-row" },
        el("button", { cls: "skill", title: sk.description || sk.name, onclick: function () { useSkill(sk); } }, sk.name),
        sk.builtin ? el("span") : el("button", { cls: "skill-del", title: "Remove skill", onclick: function (e) { e.stopPropagation(); deleteSkill(sk.name); } }, "×")));
    });
  }
  // Notes proposed at the end of a task: nothing is saved (or ever injected) until the user approves one here.
  function renderSuggested(e, list) {
    var box = el("div", { cls: "approval suggested" }, el("div", { cls: "ah", text: "Worth remembering? Save these to project memory:" }));
    view.sugRows = view.sugRows || {};
    list.forEach(function (n, i) {
      var row = el("div", { cls: "sug-row" }, el("span", { cls: "chip", text: n.type }), el("span", { cls: "sug-text", text: n.text }));
      var btns = el("span", { cls: "btns" },
        el("button", { cls: "primary", text: "Save", onclick: function () { decide(i, true); } }),
        el("button", { text: "Dismiss", onclick: function () { decide(i, false); } }));
      row.appendChild(btns);
      view.sugRows[i] = { row: row, btns: btns };
      box.appendChild(row);
    });
    function decide(i, approve) {
      Array.prototype.forEach.call(view.sugRows[i].btns.querySelectorAll("button"), function (b) { b.disabled = true; });
      api("/api/memory/suggested", { task: view.taskId, index: i, approve: approve }).then(apply).catch(function (er) { banner("bad", er.message); });
    }
    add(box);
  }
  function markSuggested(i, saved, text) {
    var r = view && view.sugRows && view.sugRows[i]; if (!r) return;
    r.btns.replaceWith(el("span", { cls: "muted", text: saved ? "✓ saved" : "dismissed" }));
  }
  function renderMemory() {
    var box = clear($("memList")), list = (S && S.memory) || [];
    $("memLabel").textContent = "Memory" + (list.length ? " (" + list.length + ")" : "");
    if (!list.length) { box.appendChild(el("div", { cls: "muted", style: "font-size:12.5px;padding:6px 10px", text: "Nothing remembered yet." })); return; }
    list.forEach(function (m) {
      var detail = el("div", { cls: "muted mem-detail hidden", style: "font-size:12px;padding:2px 10px 8px;white-space:pre-wrap", text: m.text + (m.reason ? "\n\nWhy: " + m.reason : "") + "\n\n" + m.type + " · " + m.date });
      box.appendChild(el("div", { cls: "skill-row" },
        el("button", { cls: "skill", title: m.text, onclick: function () { detail.classList.toggle("hidden"); } }, "[" + m.type + "] " + m.text),
        el("button", { cls: "skill-del", title: "Forget this note", onclick: function (e) { e.stopPropagation(); api("/api/memory/remove", { id: m.id }).then(apply).catch(function (er) { banner("bad", er.message); }); } }, "×")));
      box.appendChild(detail);
    });
  }
  function useSkill(sk) {
    input.value = sk.body;
    autosize(); input.focus();
    input.setSelectionRange(sk.body.length, sk.body.length);
    closeSide();
  }
  function deleteSkill(name) {
    api("/api/skills/delete", { name: name }).then(apply).catch(function (e) { banner("bad", e.message); });
  }
  function openSkillModal() {
    if (!S || !S.root) return;
    $("skillName").value = ""; $("skillDesc").value = ""; $("skillBody").value = ""; $("skillUrl").value = "";
    show($("skillErr"), false); show($("skillImportNote"), false); show($("skillPick"), false);
    show($("skillOverlay"), true);
    $("skillName").focus();
  }
  $("addSkillBtn").onclick = openSkillModal;
  var found = [];
  function fillFromFound(i) { var c = found[i]; if (!c) return; var w = (c.warnings || []).map(function (x) { return "line " + x.line + ": " + x.check; }); if (w.length) { var n2 = $("skillImportNote"); n2.textContent = "⚠ " + c.name + " — wording aimed at the AI: " + w.join("; ") + ". Read it carefully before saving."; show(n2, true); n2.style.color = "var(--bad)"; } $("skillName").value = c.name; $("skillDesc").value = c.description || ""; $("skillBody").value = c.body; }
  $("findSkill").onclick = function () {
    var note = $("skillImportNote"), pick = $("skillPick");
    if (!$("skillUrl").value.trim()) { $("skillUrl").focus(); return; }
    note.textContent = "Looking…"; show(note, true); note.style.color = "var(--muted)";
    api("/api/skills/find", { url: $("skillUrl").value.trim() }).then(function (r) {
      found = r.skills; clear(pick);
      found.forEach(function (c, i) { pick.appendChild(el("option", { value: String(i), text: c.name + "  —  " + c.path })); });
      show(pick, found.length > 1); fillFromFound(0);
      var warned = found.filter(function (c) { return c.warnings && c.warnings.length; });
      note.textContent = "Found " + found.length + ". These are someone else's instructions and will be given to the agent — read them below before you save." + (warned.length ? " ⚠ " + warned.length + " contain wording aimed at the AI: " + warned.map(function (c) { return c.name + " (" + c.warnings.map(function (w) { return w.check; }).join(", ") + ")"; }).join("; ") : "");
      note.style.color = warned.length ? "var(--bad)" : "var(--muted)";
    }).catch(function (e) { note.textContent = e.message; note.style.color = "var(--bad)"; });
  };
  $("skillPick").onchange = function () { fillFromFound(Number($("skillPick").value)); };
  // "Save as skill" on a finished chat: prefill the form with the request and the steps that worked, to edit.
  function skillFromChat() {
    if (!view) return;
    var first = (view.asks && view.asks[0]) || $("title").textContent || "";
    var steps = (view.did || []).slice(0, 14);
    var body = first.trim() + "\n\n" + (steps.length ? "An approach that worked last time (adapt it; skip steps that don't apply):\n" + steps.map(function (x) { return "- " + x; }).join("\n") + "\n" : "");
    openSkillModal();
    $("skillName").value = first.split("\n")[0].slice(0, 40).trim();
    $("skillDesc").value = "Saved from a chat";
    $("skillBody").value = body.trim();
    show($("skillImportNote"), false); show($("skillPick"), false); $("skillUrl").value = "";
    $("skillBody").focus();
  }
  $("closeSkill").onclick = function () { show($("skillOverlay"), false); };
  $("saveSkill").onclick = function () {
    var name = $("skillName").value.trim(), desc = $("skillDesc").value.trim(), bodyText = $("skillBody").value.trim();
    if (!name || !bodyText) { var n = $("skillErr"); n.textContent = "Name and instructions are both required."; show(n, true); return; }
    api("/api/skills", { name: name, description: desc, body: bodyText })
      .then(function (st) { apply(st); show($("skillOverlay"), false); })
      .catch(function (e) { var n = $("skillErr"); n.textContent = e.message; show(n, true); });
  };

  function renderVersion() {
    var v = S && S.version;
    var line = v && v.version ? "Narrowbit v" + v.version + (v.commit ? " · " + v.commit : "") : "";
    $("verLine").textContent = line;
    var a = clear($("aboutInfo"));
    a.appendChild(el("div", { text: line || "Version unknown" }));
    var msg = !U ? "Checking for updates…" : U.canApply ? "An update is available — use the banner at the top." : U.behind > 0 ? (U.reason || "A newer version is available.") : U.supported ? "Up to date." : (U.reason || "Update check unavailable.");
    a.appendChild(el("div", { cls: "muted", style: "font-size:12.5px", text: msg }));
    a.appendChild(el("button", { text: "Check now", onclick: function () { loadUpdate(true); } }));
    var box = el("textarea", { cls: "diag hidden", readonly: "readonly", rows: "8" });
    a.appendChild(el("button", { text: "Copy diagnostics", title: "Version, setup status and recent problems (secrets removed) to paste into a bug report", onclick: function () {
      api("/api/diagnostics").then(function (r) {
        var done = function () { flash($("savedMsg"), "Diagnostics copied"); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(r.text).then(done).catch(function () { box.value = r.text; show(box, true); box.select(); });
        else { box.value = r.text; show(box, true); box.select(); }
      }).catch(function (e) { banner("bad", e.message); });
    } }));
    a.appendChild(box);
  }

  // ---------- updates from GitHub (one click) ----------
  var U = null;
  function loadUpdate(refresh) {
    return api("/api/update" + (refresh ? "?refresh=1" : "")).then(function (u) { U = u; renderUpdate(); }).catch(function () {});
  }
  // Banner text: what the update brings, in a line. Commit titles are already written for people; keep the first few short.
  function shortChanges(list) {
    var t = (list || []).slice(0, 3).map(function (c) { c = c.replace(/\s*\(.*$/, ""); return c.length > 70 ? c.slice(0, 67) + "…" : c; });
    var more = (list || []).length > 3 ? " and more" : "";
    return t.length ? t.join(" · ") + more : "bug fixes and improvements";
  }
  // After updating, say what changed in detail. The app restarts, so the server keeps the notes until they've been seen.
  function showWhatsNew(r) {
    if (!r || !r.notes) return;
    var box = clear($("whatsNewBody"));
    box.appendChild(el("h1", { text: "Narrowbit is updated" }));
    box.appendChild(el("p", { cls: "muted", style: "margin:0 0 12px", text: "Here is what this update brought." }));
    var ul = el("ul", { cls: "wn" });
    r.notes.forEach(function (n) {
      var li = el("li", {}, el("strong", { text: n.title }));
      if (n.details) li.appendChild(el("div", { cls: "wn-d", text: n.details }));
      ul.appendChild(li);
    });
    if (!r.notes.length) ul.appendChild(el("li", { text: "Bug fixes and improvements." }));
    box.appendChild(ul);
    show($("whatsNew"), true);
  }
  $("whatsNewClose").onclick = function () { show($("whatsNew"), false); api("/api/update/ack", {}).catch(function () {}); };
  function renderUpdate() {
    if (U && U.justUpdated && $("whatsNew").classList.contains("hidden") && !U.justUpdated.shown) { U.justUpdated.shown = true; showWhatsNew(U.justUpdated); }
    renderVersion();
    var bar = $("updBar");
    var show_ = !!(U && U.canApply && store("dismissedUpdate") !== U.latest);
    show(bar, show_);
    if (!show_) return;
    clear(bar);
    var msg = el("span", { cls: "u-msg" }, el("strong", { text: "Update available" }), " — " + shortChanges(U.changes) + " ");
    var go = el("button", { cls: "primary", text: "Update now", onclick: function () {
      go.disabled = true; later.disabled = true; go.textContent = "Updating…";
      api("/api/update/apply", {}).then(function (r) {
        showWhatsNew(r);
        clear(bar).appendChild(el("span", { cls: "u-msg", text: r.restarting ? "Updated. Restarting…" : "Updated. Quit Narrowbit (⌘Q) and reopen it to use the new version." }));
      }).catch(function (e) { go.disabled = false; later.disabled = false; go.textContent = "Update now"; banner("bad", e.message); });
    } });
    var later = el("button", { cls: "link", text: "Later", onclick: function () { store("dismissedUpdate", U.latest); renderUpdate(); } });
    bar.appendChild(msg); bar.appendChild(go); bar.appendChild(later);
  }

  // ---------- first-run: what can I use right now? ----------
  var R = null;
  function loadReadiness(refresh) {
    return api("/api/readiness" + (refresh ? "?refresh=1" : "")).then(function (r) { R = r; renderGetStarted(); renderComposer(); }).catch(function () {});
  }
  function renderGetStarted() {
    var box = $("getStarted");
    var P = S && S.providers ? S.providers[S.selection.provider] : null;
    var hasRoot = !!(S && S.root);
    var notReady = !!(R && P && (P.unavailable || R.ready.indexOf(S.selection.provider) < 0));
    show(box, notReady);
    if (!notReady) return;
    clear(box);
    box.appendChild(el("h2", { text: "Let's get a model ready" }));
    box.appendChild(el("p", { cls: "gs-sub", text: (P.unavailable || P.label + " isn't ready yet.") + " Pick anything below that works for you." + (hasRoot ? "" : " (Choose a folder first to save your choice.)") }));
    function row(name, note, action) {
      var r = el("div", { cls: "gs-row" }, el("span", { cls: "gs-name", text: name }), el("span", { cls: "gs-note", text: note }));
      if (action) r.appendChild(action);
      box.appendChild(r);
    }
    function useBtn(prov) { if (!hasRoot) return null; return el("button", { cls: "primary", text: "Use", onclick: function () { draft.provider = prov; saveModels(S.providers[prov].tiers).then(function () { if (S.providers[prov].unavailable) openDrawer(); }); } }); }
    row("Claude", R.claude.loggedIn ? "Signed in — uses your Claude plan." : R.claude.detail, R.claude.loggedIn ? useBtn("claude") : null);
    row("Codex", R.codex.loggedIn ? "Signed in — uses your ChatGPT plan." : R.codex.detail, R.codex.loggedIn ? useBtn("codex") : null);
    row("Antigravity", R.antigravity.loggedIn ? "Signed in — uses your Antigravity plan (Gemini, Claude)." : R.antigravity.detail, R.antigravity.loggedIn ? useBtn("antigravity") : null);
    if (R.local.ollama.running) row("Ollama", R.local.ollama.models + " local model(s) running — free, offline.", el("button", { text: "Choose models", onclick: function () { draft.provider = "ollama"; saveModels(S.providers.ollama.tiers).then(openDrawer); } }));
    if (R.local.lmstudio.running) row("LM Studio", R.local.lmstudio.models + " local model(s) running — free, offline.", el("button", { text: "Choose models", onclick: function () { draft.provider = "lmstudio"; saveModels(S.providers.lmstudio.tiers).then(openDrawer); } }));
    var free = ["gemini", "groq", "openrouter"].filter(function (p) { return S.providers[p]; });
    var sel = el("select", { "aria-label": "Provider" });
    free.forEach(function (p) { sel.appendChild(el("option", { value: p, text: S.providers[p].label })); });
    var key = el("input", { type: "password", placeholder: "Paste a free API key", autocomplete: "off" });
    var save = el("button", { text: "Save key", onclick: function () {
      if (!key.value.trim()) return;
      api("/api/key", { provider: sel.value, key: key.value }).then(function (st) {
        apply(st);
        if (!hasRoot) { flash($("savedMsg"), "Key saved — choose a folder, then pick this provider."); return loadReadiness(true); }
        draft.provider = sel.value;
        return saveModels(S.providers[sel.value].tiers).then(function () { openDrawer(); return loadReadiness(true); });
      }).catch(function (e) { banner("bad", e.message); });
    } });
    var kr = el("div", { cls: "gs-row" }, el("span", { cls: "gs-name", text: "Free API" }), sel, key, save);
    box.appendChild(kr);
    var again = el("div", { cls: "gs-row" }, el("span", { cls: "gs-note", text: "Signed in or started something in a terminal?" }), el("button", { text: "Check again", onclick: function () { loadReadiness(true); } }));
    box.appendChild(again);
  }

  // ---------- connectors (MCP servers the agent can call out to) ----------
  function loadGithub() {
    var box = $("githubBox"); if (!box) return;
    if (!S || !S.root || !S.git || !S.git.isRepo) { box.textContent = "Open a git repository to see this."; return; }
    api("/api/github").then(function (g) {
      clear(box);
      var line = function (k, v) { box.appendChild(el("div", null, el("strong", { text: k + ": " }), v)); };
      line("Remote", g.remoteUrl ? (g.repo ? g.repo + "  (" + g.remoteUrl + ")" : g.remoteUrl) : "none — Push is unavailable until you add one (git remote add origin <url>)");
      line("Signed in as", g.ghAccount ? "@" + g.ghAccount + " (GitHub CLI) — pushes use this Mac's saved credentials for it" : g.ghInstalled ? "not signed in to the GitHub CLI — pushes use whatever git has saved; sign in with: gh auth login" : "GitHub CLI not installed — pushes use whatever git has saved (keychain, SSH key or token)");
      line("Commits are authored by", (g.author.name || "(no name set)") + " <" + (g.author.email || "no email set") + ">");
    }).catch(function (e) { box.textContent = e.message; });
  }
  function renderConnectors() {
    var box = clear($("connectorsList"));
    var list = (S && S.connectors) || [];
    if (!list.length) { box.appendChild(el("div", { cls: "muted", style: "font-size:12.5px;padding:4px 0", text: "No connectors yet." })); return; }
    list.forEach(function (c) {
      var signBtn = !c.url || c.headerKeys.length ? null : c.signedIn
        ? el("button", { title: "Forget this sign-in", onclick: function () { api("/api/connectors/signout", { name: c.name }).then(apply).catch(function (e) { banner("bad", e.message); }); } }, "Sign out")
        : el("button", { cls: "primary", title: "Sign in with your browser", onclick: function () { signIn(c.name); } }, "Sign in");
      box.appendChild(el("div", { cls: "conn-row" },
        el("span", { cls: "cn", title: c.url || (c.command + " " + c.args.join(" ")) }, c.name + (c.url ? (c.signedIn ? " · signed in" : c.headerKeys.length ? " · token" : " · remote") : "")),
        signBtn,
        el("button", { title: "Connect once and list its tools", onclick: function () { testConnector(c.name); } }, "Test"),
        el("button", { title: "Remove connector", onclick: function () { deleteConnector(c.name); } }, "×")));
    });
  }
  function signIn(name) {
    flash($("savedMsg"), "Opening your browser to sign in…");
    api("/api/connectors/signin", { name: name }).then(function (r) {
      if (native) native.postMessage({ type: "openUrl", url: r.url }); else window.open(r.url, "_blank", "noopener");
      var n = $("connectorErr"); n.textContent = "Finish signing in in your browser, then press Test. If nothing opened, copy this link: " + r.url; show(n, true); n.style.color = "var(--muted)";
    }).catch(function (e) { var n = $("connectorErr"); n.textContent = e.message; show(n, true); n.style.color = "var(--bad)"; });
  }
  function testConnector(name) {
    flash($("savedMsg"), "Testing " + name + "…");
    api("/api/connectors/test", { name: name }).then(function (r) {
      flash($("savedMsg"), r.ok ? name + ": " + r.tools.length + " tool(s) — " + r.tools.join(", ") : name + ": " + r.error);
    }).catch(function (e) { flash($("savedMsg"), e.message); });
  }
  function deleteConnector(name) {
    api("/api/connectors/delete", { name: name }).then(apply).catch(function (e) { banner("bad", e.message); });
  }
  $("addConnector").onclick = function () {
    var name = $("connName").value.trim(), command = $("connCommand").value.trim(), argsStr = $("connArgs").value.trim(), envStr = $("connEnv").value.trim();
    var curl = $("connUrl").value.trim(), cauth = $("connAuth").value.trim();
    if (!name || (!command && !curl)) { var n = $("connectorErr"); n.textContent = "A name, and either a remote URL or a command, are required."; show(n, true); return; }
    show($("connectorErr"), false);
    api("/api/connectors", { name: name, command: command, args: argsStr, env: envStr, url: curl, authHeader: cauth })
      .then(function (st) { apply(st); $("connName").value = ""; $("connCommand").value = ""; $("connArgs").value = ""; $("connEnv").value = ""; $("connUrl").value = ""; $("connAuth").value = ""; })
      .catch(function (e) { var n = $("connectorErr"); n.textContent = e.message; show(n, true); });
  };

  // ---------- settings drawer ----------
  var KIND = { subscription: "Subscriptions", free: "APIs with a free tier", paid: "Paid APIs", local: "Local models — free, offline" };
  var PHASE = {
    explore: ["1", "Explore — reads and orients, before any edit", "var(--t-explore)"],
    execute: ["2", "Execute — edits and verifies", "var(--t-execute)"],
    escalate: ["3", "Lead — plans, reviews, takes over when stuck", "var(--t-escalate)"]
  };
  function openDrawer() { show($("drawer"), true); show($("scrim"), true); }
  function closeDrawer() { show($("drawer"), false); show($("scrim"), false); }
  $("settingsBtn").onclick = function () { openDrawer(); loadGithub(); }; $("modelChip").onclick = function () { openDrawer(); loadGithub(); };
  $("closeDrawer").onclick = closeDrawer; $("scrim").onclick = function () { closeDrawer(); closeSide(); };

  function renderSettings() {
    if (!S || !S.providers) return;
    var sel = clear($("providerSel"));
    ["subscription", "free", "paid", "local"].forEach(function (group) {
      var g = el("optgroup", { label: KIND[group] });
      Object.keys(S.providers).forEach(function (prov) {
        var P = S.providers[prov];
        if ((P.kind === "api" ? (P.free ? "free" : "paid") : P.kind) !== group) return;
        var o = el("option", { value: prov, text: P.label + " — " + P.pricing + (P.unavailable ? " (needs setup)" : "") });
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
        if (P.keySource === "file") keyRow.appendChild(el("button", { cls: "link", text: "Remove", onclick: function () { saveKey(""); } }));
      } else {
        var k = el("input", { type: "password", placeholder: P.needsKey ? "Paste API key" : "API key (if needed)", autocomplete: "off" });
        keyRow.appendChild(k);
        keyRow.appendChild(el("button", { text: "Save", onclick: function () { if (k.value.trim()) saveKey(k.value); } }));
      }
    }
    var urlRow = clear($("urlRow"));
    var hasUrl = P.kind === "local" || draft.provider === "custom" || draft.provider === "cloudflare";
    show(urlRow, hasUrl);
    if (hasUrl && draft.provider === "cloudflare") {
      // The URL embeds the account id; ask for just the id so nobody edits a URL template by hand.
      var idm = /\/accounts\/([0-9a-f]{32})\//.exec(P.baseUrl || "");
      var a = el("input", { type: "text", cls: "mono", value: idm ? idm[1] : "", placeholder: "Account id (32 characters, from dash.cloudflare.com → Workers AI)", "aria-label": "Cloudflare account id", autocomplete: "off", spellcheck: "false" });
      if (idm) urlRow.appendChild(el("span", { cls: "status", text: "✓ Account id saved" }));
      urlRow.appendChild(a);
      urlRow.appendChild(el("button", { text: "Save id", onclick: function () {
        var id = a.value.trim();
        if (!/^[0-9a-f]{32}$/i.test(id)) { flash($("savedMsg"), "That doesn't look like an account id (32 letters/digits)"); return; }
        api("/api/account-id", { id: id }).then(function (st) { delete modelLists.cloudflare; apply(st); flash($("savedMsg"), "Account id saved"); }).catch(function (e) { flash($("savedMsg"), e.message); });
      } }));
    } else if (hasUrl) {
      var u = el("input", { type: "text", cls: "mono", value: P.baseUrl || "", placeholder: "http://127.0.0.1:8080/v1", "aria-label": "Base URL" });
      urlRow.appendChild(u);
      urlRow.appendChild(el("button", { text: "Set URL", onclick: function () {
        api("/api/endpoint", { provider: draft.provider, baseUrl: u.value }).then(function (st) { delete modelLists[draft.provider]; apply(st); flash($("savedMsg"), "Endpoint saved"); }).catch(function (e) { flash($("savedMsg"), e.message); });
      } }));
    }

    var slots = clear($("slots"));
    var list = modelLists[draft.provider];
    S.phases.forEach(function (ph) {
      // A real dropdown when we know the models (a datalist only shows entries matching what's already typed,
      // so with a value filled in it looked like there was nothing to choose); "Other…" for anything else.
      var cur = P.tiers[ph] || "";
      var ids = list ? (store("freeOnly") === "1" && list.free.length ? list.free : list.models).slice() : [];
      var inp;
      if (ids.length) {
        if (cur && ids.indexOf(cur) < 0) ids.unshift(cur);
        inp = el("select", { id: "slot-" + ph, onchange: function () {
          if (this.value === "__other") { swapToText(ph, ""); return; }
          saveModels();
        } });
        if (!cur) inp.appendChild(el("option", { value: "", text: "choose a model" }));
        ids.forEach(function (id) {
          var label = [id, list.labels[id] && list.labels[id] !== id ? "— " + list.labels[id] : "", list.free.indexOf(id) >= 0 ? "(free)" : ""].filter(Boolean).join(" ");
          var o = el("option", { value: id, text: label }); if (id === cur) o.selected = true; inp.appendChild(o);
        });
        inp.appendChild(el("option", { value: "__other", text: "Other… (type a model id)" }));
      } else {
        inp = el("input", { type: "text", id: "slot-" + ph, value: cur, placeholder: list ? "type a model id" : "loading models…", autocomplete: "off", spellcheck: "false", onchange: function () { saveModels(); } });
      }
      slots.appendChild(el("div", { cls: "slot", id: "slotrow-" + ph },
        el("span", { cls: "num", style: "background:" + PHASE[ph][2], text: PHASE[ph][0] }),
        el("label", { for: "slot-" + ph, text: PHASE[ph][1] }), inp));
    });
    if (list && list.free.length) {
      var fo = el("input", { type: "checkbox", id: "freeOnly" });
      fo.checked = store("freeOnly") === "1";
      fo.onchange = function () { store("freeOnly", fo.checked ? "1" : "0"); fillModelList(); renderSettings(); };
      slots.appendChild(el("label", { cls: "freeonly" }, fo, "Show free models only (" + list.free.length + ")"));
    }
    fillModelList();
    if (!list) loadModelList(draft.provider);

    var fb = clear($("fallbackSel"));
    fb.appendChild(el("option", { value: "", text: "Nothing — stop with an error" }));
    Object.keys(S.providers).forEach(function (prov) {
      var Q = S.providers[prov];
      if (prov === draft.provider || Q.unavailable) return;
      var o = el("option", { value: prov, text: Q.label }); if (prov === S.fallback) o.selected = true; fb.appendChild(o);
    });
    fb.onchange = function () { saveModels(null, { fallback: fb.value }); };
    // Scout choices: every model saved in a ready provider's three slots ("provider:model"), so nothing needs typing.
    var sc = clear($("scoutSel"));
    sc.appendChild(el("option", { value: "", text: "Off — the worker reads the code itself" }));
    var seen = {};
    Object.keys(S.providers).forEach(function (prov) {
      var Q = S.providers[prov];
      if (Q.unavailable || (R && R.ready && R.ready.indexOf(prov) < 0)) return;
      ["explore", "execute", "escalate"].forEach(function (ph) {
        var m = Q.tiers && Q.tiers[ph];
        if (!m || seen[prov + ":" + m]) return;
        seen[prov + ":" + m] = true;
        var o = el("option", { value: prov + ":" + m, text: Q.label.split(" (")[0] + " · " + m }); if (prov + ":" + m === S.scout) o.selected = true; sc.appendChild(o);
      });
    });
    if (S.scout && !seen[S.scout]) { var cur = el("option", { value: S.scout, text: S.scout.replace(":", " · ") }); cur.selected = true; sc.appendChild(cur); }
    sc.onchange = function () { saveModels(null, { scout: sc.value }); };
    var eff = clear($("effort"));
    S.efforts.forEach(function (l) { var o = el("option", { value: l, text: l }); if (l === draft.effort) o.selected = true; eff.appendChild(o); });
    $("leadChk").checked = S.lead;
    $("reviewOnlyChk").checked = !!S.reviewOnly;
    $("reviewOnlyChk").disabled = S.lead;
    $("reviewOnlyChk").closest(".trow").classList.toggle("dim", S.lead);
    $("planApprovalChk").checked = !!S.planApproval;
    $("planApprovalChk").disabled = !S.lead;
    $("planApprovalChk").closest(".trow").classList.toggle("dim", !S.lead);
    var notes = [];
    if (P.unavailable) notes.push(P.unavailable);
    if (list && !list.models.length) notes.push(list.note);
    if (S.selectionError) notes.push(S.selectionError);
    $("providerNote").textContent = notes.join(" "); show($("providerNote"), notes.length > 0);
    var t = S.selection.tiers, lbl = S.providers[S.selection.provider].label;
    var line = lbl + " · " + (t.explore || "?") + " / " + (t.execute || "?") + " / " + (t.escalate || "?");
    $("settingsSub").textContent = line;
    // Named so the ranking in settings is legible at a glance: Solo (nothing on) is the measured-best default;
    // Lead/Review-only/Scout are named after whichever Behaviour toggle is actually changing how the task runs.
    var mode = S.lead ? "Lead" : S.reviewOnly ? "Review only" : S.scout ? "Scout" : "Solo";
    // The composer chip is short (provider, working model, mode); the full three-slot line is its tooltip.
    $("modelChipText").textContent = lbl.split(" (")[0] + " · " + (t.execute || "?") + " · " + mode;
    $("modelChip").title = "Models & settings — " + line + " — " + mode + " mode";
    $("modeLabel").textContent = mode + " mode";
  }
  function swapToText(ph, val) {
    var row = $("slotrow-" + ph), old = $("slot-" + ph);
    var inp = el("input", { type: "text", id: "slot-" + ph, value: val, placeholder: "type a model id", autocomplete: "off", spellcheck: "false", onchange: function () { saveModels(); } });
    row.replaceChild(inp, old); inp.focus();
  }
  function fillModelList() {
    var dl = clear($("modelList"));
    var list = modelLists[draft.provider];
    if (!list) return;
    var fo = $("freeOnly");
    (fo && fo.checked ? list.free : list.models).forEach(function (id) {
      var label = [list.labels[id], list.free.indexOf(id) >= 0 ? "free" : ""].filter(Boolean).join(" · ");
      dl.appendChild(el("option", { value: id, label: label }));
    });
  }
  function loadModelList(prov) {
    api("/api/models?provider=" + encodeURIComponent(prov)).then(function (l) {
      modelLists[prov] = l;
      if (draft && draft.provider === prov) renderSettings();
    }).catch(function () {});
  }
  function saveModels(tiers, extra) {
    if (!tiers) {
      tiers = {}; S.phases.forEach(function (ph) { tiers[ph] = $("slot-" + ph).value.trim(); });
      // Picking one model shouldn't leave the other two blank ("? / ?"): unset slots follow the first chosen one.
      var first = ""; S.phases.forEach(function (ph) { if (!first && tiers[ph]) first = tiers[ph]; });
      S.phases.forEach(function (ph) { if (!tiers[ph]) tiers[ph] = first; });
    }
    draft.effort = $("effort").value || draft.effort;
    var body = { provider: draft.provider, effort: draft.effort, tiers: tiers };
    if (extra) for (var k in extra) body[k] = extra[k];
    return api("/api/models", body).then(function (st) { apply(st); flash($("savedMsg"), "Saved for this repository"); }).catch(function (e) { flash($("savedMsg"), e.message); });
  }
  function saveKey(key) {
    api("/api/key", { provider: draft.provider, key: key }).then(function (st) {
      delete modelLists[draft.provider];
      apply(st); flash($("savedMsg"), key ? "Key saved to ~/.narrowbit/keys.json" : "Key removed");
    }).catch(function (e) { flash($("savedMsg"), e.message); });
  }
  $("providerSel").onchange = function () { var prov = $("providerSel").value; draft.provider = prov; saveModels(S.providers[prov].tiers); };
  $("effort").onchange = function () { saveModels(); };
  function setLead(on) { var P = S.providers[draft.provider]; saveModels(P.tiers, { lead: on }); }
  function setReviewOnly(on) { var P = S.providers[draft.provider]; saveModels(P.tiers, { reviewOnly: on }); }
  $("reviewOnlyChk").onchange = function () { setReviewOnly($("reviewOnlyChk").checked); };
  function setPlanApproval(on) { var P = S.providers[draft.provider]; saveModels(P.tiers, { planApproval: on }); }
  $("planApprovalChk").onchange = function () { setPlanApproval($("planApprovalChk").checked); };
  $("leadChk").onchange = function () { setLead($("leadChk").checked); };
  $("leadTog").onchange = function () { setLead($("leadTog").checked); };
  $("maxSteps").value = store("maxSteps") || "20";
  $("maxSteps").onchange = function () { store("maxSteps", $("maxSteps").value); };
  function askOn() { return store("askCmd") !== "0"; }
  function setAsk(on) { store("askCmd", on ? "1" : "0"); $("askChk").checked = on; $("askTog").checked = on; }
  setAsk(askOn());
  $("askChk").onchange = function () { setAsk($("askChk").checked); };
  $("askTog").onchange = function () { setAsk($("askTog").checked); };
  $("isoTog").checked = store("isolate") === "1";
  $("isoTog").onchange = function () { store("isolate", $("isoTog").checked ? "1" : "0"); };

  // ---------- composer ----------
  var input = $("input");
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(240, input.scrollHeight) + "px"; }
  input.addEventListener("input", autosize);
  // "@" file mentions: typing @ opens a small popover of matching repo files (server-searched, debounced);
  // picking one inserts "@path/to/file" so the runtime can read it straight into the first prompt instead
  // of the model spending a turn finding it.
  var mention = { active: false, start: -1, files: [], sel: 0 };
  var mentionTimer = null;
  function mentionRange() {
    var v = input.value, pos = input.selectionStart;
    var at = v.lastIndexOf("@", pos - 1);
    if (at < 0 || (at > 0 && !/\s|\(/.test(v[at - 1]))) return null;
    var token = v.slice(at + 1, pos);
    if (/\s/.test(token)) return null;
    return { start: at, end: pos, token: token };
  }
  function closeMention() { mention.active = false; show($("mentionPop"), false); }
  function renderMentionPop() {
    var box = clear($("mentionPop"));
    if (!mention.files.length) { box.appendChild(el("div", { cls: "mi empty", text: "No matching files" })); }
    else mention.files.forEach(function (f, i) {
      var row = el("div", { cls: "mi" + (i === mention.sel ? " sel" : ""), text: f, onclick: function () { pickMention(i); } });
      box.appendChild(row);
    });
    show(box, true);
  }
  function pickMention(i) {
    var f = mention.files[i];
    if (!f) return;
    var r = mentionRange();
    if (!r) return closeMention();
    input.value = input.value.slice(0, r.start) + "@" + f + " " + input.value.slice(r.end);
    var cur = r.start + f.length + 2;
    input.setSelectionRange(cur, cur);
    closeMention();
    autosize();
  }
  function updateMention() {
    var r = mentionRange();
    if (!r || !S || !S.root) { closeMention(); return; }
    mention.active = true; mention.start = r.start;
    clearTimeout(mentionTimer);
    mentionTimer = setTimeout(function () {
      api("/api/files?q=" + encodeURIComponent(r.token)).then(function (d) {
        if (!mention.active) return;
        mention.files = d.files || []; mention.sel = 0; renderMentionPop();
      }).catch(function () {});
    }, 120);
  }
  input.addEventListener("input", updateMention);
  input.addEventListener("keydown", function (e) {
    if (mention.active && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Tab" || e.key === "Escape")) {
      if (e.key === "Escape") { e.preventDefault(); closeMention(); return; }
      if (!mention.files.length) { if (e.key === "Enter") closeMention(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); mention.sel = (mention.sel + 1) % mention.files.length; renderMentionPop(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mention.sel = (mention.sel - 1 + mention.files.length) % mention.files.length; renderMentionPop(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mention.sel); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(false); }
  });
  input.addEventListener("blur", function () { setTimeout(closeMention, 150); });
  function viewingRun() { return !!(view && run.active && (view.pendingNew || (view.taskId && run.taskId === view.taskId))); }
  $("compactBtn").onclick = function () {
    if (!view || !view.taskId) return;
    api("/api/compact", { task: view.taskId }).then(function (r) { flash($("savedMsg"), "Compacting " + r.when); showToast("Compact requested — takes effect " + r.when + ". Notes saved to project memory are kept and listed in the summary."); })
      .catch(function (e) { banner("bad", e.message); });
  };
  function renderComposer() {
    var busy = run.active;
    var P = S && S.providers && S.providers[S.selection.provider];
    // With no folder open there is no per-repo config to trust, so P.unavailable (which only reflects
    // whether a key/model is configured) isn't enough — fall back to the live readiness check, same
    // signal renderGetStarted() uses, so an unsigned-in provider can't send just because it has no folder.
    // While readiness hasn't loaded yet (R is still null), assume it's fine rather than flash "disabled" —
    // loadReadiness()'s own callback re-renders this once the real answer is in.
    var notReadyNoRoot = !!(S && !S.root && R && P && (P.unavailable || R.ready.indexOf(S.selection.provider) < 0));
    show($("compactBtn"), !!(view && view.taskId));
    show($("stopBtn"), viewingRun());
    show($("sendBtn"), !viewingRun());
    $("sendBtn").disabled = !S || (!!S.root && !S.initialized) || busy || !!(P && P.unavailable) || notReadyNoRoot;
    $("leadTog").checked = !!(S && S.lead);
    input.placeholder = view && view.taskId ? "Ask for a follow-up or a change…" : S && S.root ? "Describe a task…" : "What do you want to build? Let's talk it through…";
    $("hint").textContent = !S ? "" : busy && !viewingRun() ? "Another task is running — open it from the sidebar to watch or stop it." : P && P.unavailable ? P.unavailable : notReadyNoRoot ? ((R[S.selection.provider] && R[S.selection.provider].detail) || "not signed in — pick a model that's ready") : !S.root ? "Enter to send · No folder needed yet — we'll create one when you're ready" : "Enter to send · Shift+Enter for a new line";
    if (S && S.root) show($("createProjectBar"), false);
  }
  var attached = [];
  function renderAttached() {
    var box = $("attached"); clear(box); show(box, attached.length > 0);
    attached.forEach(function (a, i) {
      var chip = el("div", { cls: "att" });
      chip.appendChild(el("span", { text: (a.kind === "pdf" ? "PDF · " : "Image · ") + a.name }));
      chip.appendChild(el("button", { text: "×", title: "Remove", onclick: function () { attached.splice(i, 1); renderAttached(); } }));
      box.appendChild(chip);
    });
  }
  function attachFiles(files) {
    Array.prototype.forEach.call(files, function (f) {
      if (attached.length >= 6) { banner("warn", "You can attach up to 6 files."); return; }
      if (!/^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(f.type)) { banner("warn", "Only images (png, jpg, gif, webp) and PDFs can be attached."); return; }
      var r = new FileReader();
      r.onload = function () {
        var data = String(r.result).split(",")[1] || "";
        api("/api/attach", { name: f.name || "pasted-image.png", data: data })
          .then(function (a) { attached.push(a); renderAttached(); })
          .catch(function (e) { banner("warn", (e && e.data && e.data.error) || "Couldn't attach that file."); });
      };
      r.readAsDataURL(f);
    });
  }
  $("attachBtn").addEventListener("click", function () { $("attachInput").click(); });
  $("attachInput").addEventListener("change", function () { attachFiles($("attachInput").files); $("attachInput").value = ""; });
  input.addEventListener("paste", function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); attachFiles(files); }
  });
  ["dragover", "drop"].forEach(function (t) {
    document.querySelector(".composer").addEventListener(t, function (e) {
      e.preventDefault();
      if (t === "drop" && e.dataTransfer && e.dataTransfer.files.length) attachFiles(e.dataTransfer.files);
    });
  });
  function sendDraft(text) {
    banner("", null);
    var cont = view && view.taskId ? view.taskId : null;
    input.value = ""; autosize();
    var wasNew = !cont;
    if (wasNew) resetView(null);
    if (wasNew) $("title").textContent = text;
    add(el("div", { cls: "msg-user" }, el("div", { cls: "bubble" }, rich(text))), true);
    var thinking = add(el("div", { cls: "working" }, el("span", { cls: "spark" }), el("span", { cls: "shimmer", text: "Thinking…" })), true);
    $("sendBtn").disabled = true;
    api("/api/plan", { task: text, continueTask: cont }).then(function (r) {
      thinking.remove();
      $("sendBtn").disabled = false;
      if (!view || (cont && view.taskId !== cont)) return;
      if (wasNew) { view.taskId = r.taskId; show($("welcome"), false); }
      add(el("div", { cls: "final-wrap" }, el("div", { cls: "final" }, rich(r.reply))));
      show($("createProjectBar"), true);
      load();
    }).catch(function (e) {
      thinking.remove();
      $("sendBtn").disabled = false;
      banner("bad", e.message);
    });
  }
  function send(force) {
    var text = input.value.trim();
    if (!text || $("sendBtn").disabled) return;
    if (S && !S.root) { sendDraft(text); return; }
    banner("", null);
    var cont = view && view.taskId ? view.taskId : null;
    // The server logs the task's first event before this request returns, so the view must already
    // be waiting for it.
    if (!cont) { resetView(null); view.pendingNew = true; show($("welcome"), false); }
    api("/api/run", { task: text, force: !!force, continueTask: cont, maxSteps: Number($("maxSteps").value) || 20, askBeforeCommands: askOn(), isolate: $("isoTog").checked, attachments: attached.map(function (a) { return a.id; }) })
      .then(function () {
        attached = []; renderAttached();
        input.value = ""; autosize();
        clearChanges();
        run.active = true; run.taskId = cont;
        setWorking("Starting…");
        renderComposer();
      })
      .catch(function (e) {
        if (!cont && view) { view.pendingNew = false; show($("welcome"), true); }
        if (e.status === 409 && e.data && e.data.error === "dirty") {
          var box = el("div");
          box.appendChild(el("strong", { text: "This repository has uncommitted changes." }));
          box.appendChild(el("div", { text: "The agent's edits would mix with yours, and Discard would revert them too:" }));
          var ul = el("ul", { cls: "mono" }); e.data.files.slice(0, 8).forEach(function (f) { ul.appendChild(el("li", { text: f })); });
          box.appendChild(ul);
          box.appendChild(el("button", { text: "Run anyway", onclick: function () { send(true); } }));
          banner("warn", box);
        } else banner("bad", e.message);
      });
  }
  $("sendBtn").onclick = function () { send(false); };
  $("stopBtn").onclick = function () { api("/api/stop", {}).catch(function (e) { banner("bad", e.message); }); };

  function errorCard(m) {
    var head, body, actions = [];
    if (m.errorKind === "limit") {
      head = "Usage limit reached";
      body = (m.resets ? "It resets " + m.resets + ". " : "") + "Wait for it to reset, or switch to another model or provider and send your message again.";
      actions.push(el("button", { cls: "primary", text: "Switch model", onclick: openDrawer }));
    } else if (m.errorKind === "auth") {
      head = "Not signed in";
      body = (m.summary || "The model provider rejected the sign-in.") + " Sign in, then send your message again.";
      actions.push(el("button", { cls: "primary", text: "Open settings", onclick: function () { openDrawer(); loadReadiness(true); } }));
    } else {
      head = "Couldn't reach the model provider";
      body = "Check your internet connection and try again. " + (m.summary ? "(" + String(m.summary).slice(0, 120) + ")" : "");
    }
    var card = el("div", { cls: "errcard" }, el("strong", { text: head }), el("div", { cls: "muted", text: body }));
    actions.forEach(function (a) { card.appendChild(a); });
    return card;
  }

  // ---------- conversation view ----------
  function resetView(taskId) {
    view = { taskId: taskId, seen: {}, step: null, plan: null, tokens: 0, cost: 0, segTokens: 0, segCost: 0, segSteps: 0, segStart: null, approvals: {}, pendingNew: false, working: null, finished: {} };
    clear($("items")); clearChanges();
    // No folder open at all (planning drafts, or just closed a project) has no "initialized" concept —
    // only a freshly created-but-uninitialized project should hide this in favor of the setup card. A
    // missing project's folder hides it in favor of missingCard instead, same reasoning.
    show($("welcome"), !taskId && !(S && S.missingRoot) && (!S || !S.root || S.initialized));
    $("title").textContent = "";
    show($("planMini"), false);
    updateUsage();
    renderComposer();
  }
  // Just blanking the composer for a fresh task within whatever project (or lack of one) is already
  // current — used for internal bookkeeping (first load, the active session got deleted, forking a task)
  // where nothing about which project is open should change.
  function blankView() { resetView(null); show($("createProjectBar"), false); renderSessions(); input.focus(); closeSide(); }
  // The user-facing "New task" action, though, always starts a blank, no-folder chat — matching Claude's
  // own "New" — rather than silently continuing whatever project happened to be open. The current project
  // stays reachable from the folder picker's recents list; this is the one place that leaves it, so it
  // needs the same close-then-reset a project switch does, not just blankView()'s local view reset.
  function newTask() {
    if (S && S.root) {
      api("/api/repo/close", {}).then(function (st) {
        if (es) { es.close(); es = null; }
        draft = null; S = null; modelLists = {};
        apply(st);
        blankView();
      }).catch(function (e) { banner("bad", e.message); });
    } else {
      blankView();
    }
  }
  $("newBtn").onclick = newTask;
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); newTask(); }
    if (e.key === "Escape") { closeDrawer(); closeSide(); }
    // 1 / 2 / 3 answer a pending approval when you're not typing.
    var typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (!typing && !e.metaKey && !e.ctrlKey && view) {
      var ids = Object.keys(view.approvals).filter(function (id) { return !view.approvals[id].done; });
      if (ids.length && (e.key === "1" || e.key === "2" || e.key === "3")) { e.preventDefault(); view.approvals[ids[0]].decide(e.key === "1" ? "once" : e.key === "2" ? "task" : "deny"); }
    }
  });

  function openSession(id) {
    resetView(id);
    renderSessions();
    api("/api/task/" + encodeURIComponent(id)).then(function (d) {
      if (!view || view.taskId !== id) return;
      d.events.forEach(function (e) { renderEvent(e, true); });
      if (d.running) setWorking("Working…"); else loadChanges();
      scroller.scrollTop = scroller.scrollHeight;
      renderComposer();
    }).catch(function (e) { banner("bad", e.message); });
  }
  // Planning drafts (planning.ts): a conversation before any project exists. Reuses the same event shape
  // a pure-answer task already produces (a plain "done: " reply, no tool calls), so renderEvent() and the
  // rest of the thread view work unchanged — this only has its own send()/open() plumbing, not its own UI.
  function openDraft(id) {
    resetView(id);
    renderSessions();
    show($("createProjectBar"), false);
    api("/api/plan/" + encodeURIComponent(id)).then(function (d) {
      if (!view || view.taskId !== id) return;
      d.events.forEach(function (e) { renderEvent(e, true); });
      scroller.scrollTop = scroller.scrollHeight;
      renderComposer();
      show($("createProjectBar"), d.events.some(function (e) { return e.type === "decision" && e.actor === "model" && e.summary.indexOf("done: ") === 0; }));
    }).catch(function (e) { banner("bad", e.message); });
  }

  var ICON = {
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    again: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
    skill: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    fork: '<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10M6 12c0-3 3-3 6-3h4"/></svg>'
  };
  function iconBtn(icon, title, fn) {
    var b = el("button", { title: title, "aria-label": title, onclick: fn });
    b.innerHTML = ICON[icon];
    return b;
  }
  function copyText(text, btn) {
    function done(ok) { var t = btn.title; btn.title = ok ? "Copied" : "Couldn't copy"; setTimeout(function () { btn.title = t === "Copied" || t === "Couldn't copy" ? "Copy" : t; }, 1400); }
    // Selection + execCommand works inside the native window; navigator.clipboard is often refused there.
    var ok = false;
    try {
      var ta = el("textarea", { style: "position:fixed;left:-9999px;top:0" });
      ta.value = text; document.body.appendChild(ta); ta.focus(); ta.select();
      ok = document.execCommand("copy"); ta.remove();
    } catch (e) { ok = false; }
    if (ok) { done(true); return; }
    if (native) { native.postMessage({ type: "copy", text: text }); done(true); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }).catch(function () { done(false); });
    else done(false);
  }
  function userActions(text, at) {
    var copyBtn = iconBtn("copy", "Copy", function () { copyText(text, copyBtn); });
    return el("div", { cls: "msg-actions" },
      el("span", { cls: "when", text: at ? ago(at) : "" }),
      copyBtn,
      iconBtn("again", "Edit and send again", function () { input.value = text; autosize(); input.focus(); input.setSelectionRange(text.length, text.length); }),
      iconBtn("fork", "Start a new task from this", function () { blankView(); input.value = text; autosize(); input.focus(); }));
  }
  function add(node, force) { follow(function () { $("items").appendChild(node); }, force); placeWorking(); return node; }
  function setWorking(text) { if (!view) return; view.working = text; placeWorking(); }
  function placeWorking() {
    var old = $("workingRow"); if (old) old.remove();
    if (!view || !view.working || !viewingRun()) return;
    var row = el("div", { cls: "working", id: "workingRow" }, el("span", { cls: "spark" }), el("span", { cls: "shimmer", text: view.working }), el("span", { cls: "muted", id: "workTimer", text: view.segStart ? dur(Date.now() - view.segStart) : "" }));
    follow(function () { $("items").appendChild(row); });
  }
  setInterval(function () {
    var t = $("workTimer");
    if (t && view && view.segStart) t.textContent = dur(Date.now() - view.segStart);
  }, 1000);
  // Cost first, tokens second and muted: a raw token count (hundreds of thousands, on a resumed session
  // that resends prior turns from cache every call) reads as alarming even when the real cost is small —
  // most of that figure is heavily-discounted cache reads, and cost is the number that actually matters.
  function updateUsage() {
    var u = $("usage");
    clear(u);
    if (!view || !view.tokens) return;
    u.appendChild(el("span", { cls: "usage-cost", text: money(view.cost) }));
    u.appendChild(el("span", { cls: "usage-tok", text: fmt(view.tokens) + " tok" }));
  }

  var VERB = { read: "Read", grep: "Grep", search: "Search", edit: "Edit", run: "Run", verify: "Verify", recall: "Recall", remember: "Remember", ask: "Ask", connector: "Connector", describe: "Describe" };
  function tierColor(model) {
    var t = S && S.selection.tiers;
    if (!t || !model) return "";
    var tier = model === t.escalate ? "escalate" : model === t.execute ? "execute" : model === t.explore ? "explore" : null;
    return tier ? PHASE[tier][2] : "";
  }
  function stepBlock(m) {
    var target = m.action === "read" ? (m.path || "") + (m.start ? ":" + m.start + (m.end ? "-" + m.end : "") : "")
      : m.action === "run" ? m.command : m.action === "search" || m.action === "recall" ? m.query
      : m.action === "grep" ? (m.pattern || "") + (m.glob ? "  in " + m.glob : "") : m.path || "";
    var meta = el("span", { cls: "meta" });
    if (m.model) meta.appendChild(el("span", { cls: "chip", text: m.model, style: "color:" + tierColor(m.model) }));
    var head = el("div", { cls: "sh" }, el("span", { cls: "sd" }), el("span", { cls: "verb", text: VERB[m.action] || m.action }), el("span", { cls: "tgt", text: target || "" }), meta);
    var box = el("div", { cls: "step run" }, head);
    var s = { box: box, head: head, meta: meta, prev: null, body: null, open: false };
    head.onclick = function () { if (s.body) { s.open = !s.open; show(s.body, s.open); if (s.prev) show(s.prev, !s.open); } };
    return s;
  }
  // "Why is this in context?": everything the model was sent for the turn that chose this step, itemised.
  var CTX_KIND = { result: "result", task: "request", plan: "plan", digest: "summary", instructions: "instructions", nudge: "nudge", gate: "check", review: "review", note: "note" };
  var CTX_WHY = { result: "came back from the previous action", task: "what you asked", plan: "the lead's plan", digest: "a summary standing in for older turns", instructions: "Narrowbit's fixed rules (sent once per session, then cached)", nudge: "added by Narrowbit to keep it on track", gate: "the completion check refused 'done'", review: "the lead's feedback", note: "explains why a batch stopped" };
  function addContext(st, c, note) {
    var btn = el("button", { cls: "ctx-btn", title: "What the model was sent for this step", text: "context ~" + fmt(c.est) });
    var panel = el("div", { cls: "ctx hidden" });
    panel.appendChild(el("h5", { text: note ? "Why: " + note : "What the model was sent for this step" }));
    (c.parts || []).slice().sort(function (a, b) { return b.tokens - a.tokens; }).forEach(function (x) {
      panel.appendChild(el("div", { cls: "row", title: CTX_WHY[x.kind] || "" }, el("span", { cls: "k", text: CTX_KIND[x.kind] || x.kind }), el("span", { cls: "l", text: x.label + " — " + (CTX_WHY[x.kind] || "") }), el("span", { cls: "n", text: "~" + fmt(x.tokens) })));
    });
    var tk = c.tk || {};
    panel.appendChild(el("div", { cls: "foot", text: "Billed for this call: " + fmt(tk.inputTokens + tk.cacheCreationTokens) + " new + " + fmt(tk.cacheReadTokens) + " cached input, " + fmt(tk.outputTokens) + " output · " + (tk.model || "") + ". Itemised sizes are estimates; older turns ride along from the session's cache." }));
    btn.onclick = function (e) { e.stopPropagation(); panel.classList.toggle("hidden"); };
    st.meta.appendChild(btn);
    st.box.insertBefore(panel, st.head.nextSibling);
  }
  function attach(s, cls, preview, body, open) {
    s.box.classList.remove("run");
    if (cls) s.box.classList.add(cls);
    if (preview) { s.prev = el("div", { cls: "prev", text: preview }); s.box.appendChild(s.prev); }
    if (body) { s.body = body; body.classList.add("sb"); s.box.appendChild(body); s.open = !!open; show(body, s.open); if (s.prev) show(s.prev, !s.open); }
  }
  function pre(text) { return el("div", null, el("pre", { text: text })); }
  function diffBody(oldText, newText) {
    var a = oldText ? String(oldText).split("\n") : [], b = String(newText || "").split("\n");
    var p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    var q = 0; while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
    var box = el("div");
    a.slice(Math.max(0, p - 2), p).forEach(function (l) { box.appendChild(el("div", { cls: "dl c", text: "  " + l })); });
    a.slice(p, a.length - q).forEach(function (l) { box.appendChild(el("div", { cls: "dl d", text: "- " + l })); });
    b.slice(p, b.length - q).forEach(function (l) { box.appendChild(el("div", { cls: "dl a", text: "+ " + l })); });
    a.slice(a.length - q, Math.min(a.length, a.length - q + 2)).forEach(function (l) { box.appendChild(el("div", { cls: "dl c", text: "  " + l })); });
    return { node: box, added: b.length - q - p, removed: a.length - q - p };
  }
  function firstLine(t) { return String(t || "").split("\n").filter(function (l) { return l.trim(); })[0] || ""; }
  function afterFirst(t) { var i = String(t || "").indexOf("\n"); return i < 0 ? "" : String(t).slice(i + 1); }

  // Once a turn finishes, its reading/searching/editing steps fold into one line ("Worked for 25s · 4 steps")
  // above the answer, like Claude Code; click to look. While it runs everything stays visible, and a turn
  // that didn't finish cleanly stays open so the failure is in view.
  function countAction(m) {
    var a = view.acts || (view.acts = { read: 0, search: 0, edit: {}, run: 0, verify: 0, memory: 0 });
    var k = m.action;
    if (k === "read") a.read++;
    else if (k === "grep" || k === "search") a.search++;
    else if (k === "edit") a.edit[m.path || ("#" + Object.keys(a.edit).length)] = 1;
    else if (k === "run") a.run++;
    else if (k === "verify") a.verify++;
    else if (k === "recall" || k === "remember") a.memory++;
  }
  function actionSummary() {
    var a = view.acts || {}, out = [], n = function (c, one, many) { return c + " " + (c === 1 ? one : many); };
    var edits = a.edit ? Object.keys(a.edit).length : 0;
    if (a.read) out.push("read " + n(a.read, "file", "files"));
    if (a.search) out.push("searched " + n(a.search, "time", "times"));
    if (edits) out.push("edited " + n(edits, "file", "files"));
    if (a.run) out.push("ran " + n(a.run, "command", "commands"));
    if (a.verify) out.push("verified " + (a.verify === 1 ? "once" : a.verify + "×"));
    if (a.memory) out.push("used memory");
    return out.join(", ");
  }
  function collapseWork(finishedOk, endMs) {
    var items = $("items").children, start = 0, i;
    for (i = items.length - 1; i >= 0; i--) if (items[i].classList.contains("msg-user")) { start = i + 1; break; }
    var work = [];
    for (i = start; i < items.length; i++) {
      var c = items[i], k = c.classList;
      if (k.contains("final-wrap") || k.contains("final") || k.contains("outcome") || k.contains("errcard") || k.contains("bad") || c.id === "workingRow") continue;
      work.push(c);
    }
    if (!work.length) return;
    var body = el("div", { cls: "work-body" });
    var sum = actionSummary();
    var label = "Worked" + (view.segStart ? " for " + dur(endMs - view.segStart) : "") + " · " + (sum || view.segSteps + " step" + (view.segSteps === 1 ? "" : "s"));
    var group = el("details", { cls: "work" }, el("summary", { text: label }), body);
    if (!finishedOk) group.open = true;
    $("items").insertBefore(group, work[0]);
    work.forEach(function (n) { body.appendChild(n); });
    view.plan = null; view.step = null;
  }
  function renderPlan(meta) {
    if (!view.plan) { view.plan = { node: el("div", { cls: "plan" }) }; add(view.plan.node); }
    var steps = meta.steps || [], done = steps.filter(function (x) { return x.status === "done"; }).length;
    var n = clear(view.plan.node);
    var prog = el("span", { cls: "prog" }, el("i", { style: "width:" + (steps.length ? Math.round(done * 100 / steps.length) : 0) + "%" }));
    n.appendChild(el("div", { cls: "ph" }, el("strong", { text: "Plan" }), el("span", { cls: "chip", text: meta.by || "lead", style: "color:" + tierColor(meta.by) }), prog, el("span", { text: done + "/" + steps.length })));
    var ol = el("ol");
    steps.forEach(function (x) { ol.appendChild(el("li", { cls: x.status === "done" ? "done" : "" }, el("span", { cls: "box", text: x.status === "done" ? "✓" : "" }), el("span", { cls: "tx" }, rich(x.text)))); });
    n.appendChild(ol);
    if (meta.files && meta.files.length) n.appendChild(el("div", { cls: "pf mono", text: "Likely files: " + meta.files.join(", ") }));
    if (meta.risks) n.appendChild(el("div", { cls: "pf" }, rich("Watch out: " + meta.risks)));
    var mini = $("planMini");
    mini.textContent = "Plan " + done + "/" + steps.length; show(mini, true);
    mini.onclick = function () { view.plan.node.scrollIntoView({ behavior: "smooth", block: "start" }); };
  }

  function renderEvent(e, replay) {
    if (!view || view.seen[e.id]) return;
    view.seen[e.id] = true;
    var m = e.meta || {};
    if (e.type === "model_call" && e.tokens) {
      view.ctx = m.context ? { parts: m.context.parts || [], est: m.context.tokens || 0, tk: e.tokens } : null;
      var t = e.tokens.inputTokens + e.tokens.cacheCreationTokens + e.tokens.cacheReadTokens + e.tokens.outputTokens;
      view.tokens += t; view.cost += e.tokens.costUsd; view.segTokens += t; view.segCost += e.tokens.costUsd;
      updateUsage();
      // Planning drafts (planning.ts) have no separate "done: " decision event — the reply lives on this
      // event's own summary — so replaying a draft must render it here, unlike a normal task's model_call.
      if (e.actor === "model" && e.summary.indexOf("done: ") === 0) {
        var draftAnswer = e.summary.slice(6);
        add(el("div", { cls: "final-wrap" }, el("div", { cls: "final" }, rich(draftAnswer))));
      }
      return;
    }
    if (e.type === "decision" && e.actor === "user") {
      var text = m.goal || m.followUp || "";
      (view.asks = view.asks || []).push(text);
      if (m.goal) $("title").textContent = m.goal;
      show($("welcome"), false);
      view.acts = { read: 0, search: 0, edit: {}, run: 0, verify: 0, memory: 0 }; view.segTokens = 0; view.segCost = 0; view.segSteps = 0; view.segStart = new Date(e.at).getTime();
      add(el("div", { cls: "msg-user" }, el("div", { cls: "bubble" }, rich(text)), userActions(text, e.at)), true);
      if (!replay) setWorking(S && S.lead && m.goal ? "Lead is planning…" : "Thinking…");
      return;
    }
    if (e.type === "plan") { renderPlan(m); if (!replay) setWorking("Working…"); return; }
    if (e.type === "tool_call") {
      view.segSteps++;
      countAction(m);
      (view.did = view.did || []).push(m.action === "read" ? "read " + (m.path || "") : m.action === "edit" ? "edited " + (m.path || "") : m.action === "run" ? "ran: " + (m.command || "") : m.action === "verify" ? "ran verify" : m.action + (m.query ? ' "' + m.query + '"' : m.pattern ? ' "' + m.pattern + '"' : ""));
      if (m.note) add(el("div", { cls: "narr" }, rich(m.note)));
      view.step = stepBlock(m);
      add(view.step.box);
      if (view.ctx) { addContext(view.step, view.ctx, m.note); view.ctx = null; }
      if (!replay) setWorking((VERB[m.action] || m.action) + (m.model ? " · " + m.model : "") + "…");
      return;
    }
    var s = view.step;
    if (e.type === "edit" && s) {
      var d = diffBody(m.old, m.new);
      s.meta.insertBefore(el("span", null, el("span", { cls: "add", text: "+" + d.added }), " ", el("span", { cls: "rem", text: "−" + d.removed })), s.meta.firstChild);
      attach(s, "ok", null, d.node, true);
      view.step = null; return;
    }
    if (e.type === "command" && s) {
      var ex = /\(exit (\d+)/.exec(e.summary);
      var code = ex ? Number(ex[1]) : 0;
      if (ex) s.meta.insertBefore(el("span", { cls: code ? "o-blocked" : "", text: "exit " + code }), s.meta.firstChild);
      attach(s, code ? "fail" : "ok", firstLine(afterFirst(e.summary)) || firstLine(e.summary), pre(e.summary), !!code);
      view.step = null; return;
    }
    if (e.type === "verify" && s) {
      s.meta.insertBefore(el("span", { cls: m.ok ? "o-done" : "o-blocked", text: m.ok ? "passed" : "failed" }), s.meta.firstChild);
      attach(s, m.ok ? "ok" : "fail", firstLine(e.summary), pre(e.summary), !m.ok);
      view.step = null; return;
    }
    if ((e.type === "tool_result" || (e.type === "decision" && m.memoryId)) && s) {
      var refused = /: (refused|"old" text not found|file not found|file does not exist|"old" text matches)/.test(e.summary) || m.declined;
      if (m.declined) s.meta.insertBefore(el("span", { cls: "o-blocked", text: "denied" }), s.meta.firstChild);
      var lines = String(e.summary).split("\n");
      var prev = lines.length > 2 ? (lines.length - 1) + " lines · " + (lines[1] || "").trim() : lines.join(" ");
      attach(s, refused ? "fail" : "ok", prev, lines.length > 2 ? pre(e.summary) : null, false);
      view.step = null; return;
    }
    if (e.type === "decision" && m.review) {
      var ok = m.review === "approve";
      var r = el("div", { cls: "review" }, el("div", { cls: "rh" }, el("span", { text: "Lead review" }), el("span", { cls: "chip", text: m.by || "", style: "color:" + tierColor(m.by) }), el("span", { cls: ok ? "v-ok" : "v-rev", text: ok ? "✓ Approved" : "Changes requested" })));
      if (!ok && m.feedback) r.appendChild(el("div", { cls: "fb" }, rich(m.feedback)));
      add(r);
      if (!replay) setWorking(ok ? "Finishing…" : "Addressing the review…");
      return;
    }
    if (e.type === "decision" && e.actor === "model" && e.summary.indexOf("done: ") === 0) {
      if (m.note) add(el("div", { cls: "narr" }, rich(m.note)));
      var answer = e.summary.slice(6), ansCopy = iconBtn("copy", "Copy", function () { copyText(answer, ansCopy); });
      var saveSk = iconBtn("skill", "Save this as a skill", skillFromChat);
      add(el("div", { cls: "final-wrap" }, el("div", { cls: "final" }, rich(answer)), el("div", { cls: "msg-actions" }, ansCopy, saveSk)));
      return;
    }
    if (e.type === "blocker" && e.actor === "model") { add(el("div", { cls: "final", style: "color:var(--warn)" }, rich("Blocked: " + e.summary))); return; }
    if (e.type === "decision" && typeof m.outcome === "string") {
      view.working = null; placeWorking();
      var LBL = { done: "Done", blocked: "Blocked", error: "Error", stopped: "Stopped", max_steps: "Step budget reached" };
      var line = el("div", { cls: "outcome" },
        el("span", { cls: "lbl o-" + m.outcome }, el("span", { cls: "dot" }), LBL[m.outcome] || m.outcome),
        el("span", { text: view.segSteps + " steps" }),
        el("span", { text: fmt(view.segTokens) + " tokens" }),
        el("span", { text: money(view.segCost) + (S && S.selection.provider === "claude" ? " notional" : "") }));
      if (view.segStart) line.appendChild(el("span", { text: dur(new Date(e.at).getTime() - view.segStart) }));
      var known = m.errorKind === "limit" || m.errorKind === "auth" || m.errorKind === "network";
      if (m.outcome === "error" && m.summary && !known) line.appendChild(el("span", { cls: "o-blocked", text: m.summary }));
      add(line);
      if (m.outcome === "error" && known) add(errorCard(m));
      collapseWork(m.outcome === "done", new Date(e.at).getTime());
      return;
    }
    if (e.type === "decision" && Array.isArray(m.suggested)) { renderSuggested(e, m.suggested); return; }
    if (e.type === "decision" && typeof m.suggestedDone === "number") { markSuggested(m.suggestedDone, m.saved, e.summary); return; }
    if (e.type === "handoff") { add(el("div", { cls: "divider", text: m.manual ? e.summary : "context compacted — continuing in a fresh session" })); return; }
    if (e.type === "checkpoint") {
      if (e.actor === "user") { add(el("div", { cls: "divider", text: e.summary })); return; }
      var row = el("div", { cls: "ckpt" });
      var label = el("span", { cls: "ckpt-label", text: m.step === 0 ? "Checkpoint: before any changes" : "Checkpoint: after this edit" });
      row.appendChild(label);
      var askBtn = el("button", { cls: "link", text: "Rewind here", onclick: function () {
        if (run.active) { banner("warn", "Stop the task before rewinding."); return; }
        row.replaceChild(confirmRow(), askBtn);
      } });
      function confirmRow() {
        return el("span", { cls: "ckpt-confirm" }, el("span", { text: "Undo everything after this?" }),
          el("button", { cls: "danger", text: "Rewind", onclick: function () {
            api("/api/rewind", { task: view.taskId, checkpoint: e.id }).then(function (r) {
              showToast("Rewound — " + r.message);
            }).catch(function (er) { banner("bad", er.message); });
          } }),
          el("button", { cls: "link", text: "Cancel", onclick: function () { row.replaceChild(askBtn, row.lastChild); } }));
      }
      row.appendChild(askBtn);
      add(row);
      return;
    }
    if (e.type === "blocker") {
      var sm = e.summary;
      var parse = /could not parse a JSON action.*attempt (\d+)\/(\d+)/.exec(sm);
      var txt = parse ? "The model's reply wasn't a valid action — asked it to try again (" + parse[1] + "/" + parse[2] + ")"
        : sm.indexOf("done rejected: ") === 0 ? "Not done yet — " + sm.slice(15)
        : /without an edit/.test(sm) ? "Spinning on the same failing check — nudged toward the implementation"
        : sm;
      add(el("div", { cls: "notice" + (/model call failed/.test(sm) ? " bad" : parse ? "" : " warn") }, rich(txt)));
      return;
    }
    if (e.type === "tool_result" && /retrying/.test(e.summary)) { add(el("div", { cls: "notice warn", text: e.summary })); return; }
  }

  // ---------- approvals ----------
  function onApproval(ev) {
    if (!view || view.approvals[ev.id]) return;
    var isConn = ev.command.indexOf("connector: ") === 0;
    var box = el("div", { cls: "approval" }, el("div", { cls: "ah", text: isConn ? "Use this connector tool?" : "Run this command?" }), el("pre", { text: isConn ? ev.command.slice(11) : ev.command }));
    if (ev.warning) box.appendChild(el("div", { cls: "approval-warn", text: "⚠ " + ev.warning }));
    var btns = el("div", { cls: "btns" });
    var a = { box: box, btns: btns, done: false };
    a.decide = function (d) {
      if (a.done) return; a.done = true;
      Array.prototype.forEach.call(btns.querySelectorAll("button"), function (b) { b.disabled = true; });
      api("/api/approve", { id: ev.id, decision: d }).catch(function (e) { banner("bad", e.message); });
    };
    btns.appendChild(el("button", { cls: "primary", onclick: function () { a.decide("once"); } }, "Allow once ", el("kbd", { text: "1" })));
    btns.appendChild(el("button", { onclick: function () { a.decide("task"); } }, "Allow for this task ", el("kbd", { text: "2" })));
    btns.appendChild(el("button", { cls: "danger", onclick: function () { a.decide("deny"); } }, "Deny ", el("kbd", { text: "3" })));
    box.appendChild(btns);
    view.approvals[ev.id] = a;
    add(box, true);
    if (document.activeElement === input) input.blur();
    if (native) native.postMessage({ type: "attention", text: ev.command });
  }
  function onQuestion(ev) {
    if (!view || view.approvals[ev.id]) return;
    var box = el("div", { cls: "approval question" }, el("div", { cls: "ah", text: "Narrowbit has a question" }), el("div", { cls: "qt" }, rich(ev.question)));
    var q = { box: box, done: false };
    var btns = el("div", { cls: "btns" });
    var send = function (text) {
      if (q.done || !text.trim()) return; q.done = true;
      Array.prototype.forEach.call(box.querySelectorAll("button, input"), function (b) { b.disabled = true; });
      api("/api/answer", { id: ev.id, answer: text.trim() }).catch(function (e) { q.done = false; banner("bad", e.message); });
    };
    (ev.options || []).forEach(function (o) { btns.appendChild(el("button", { onclick: function () { send(o); } }, o)); });
    var free = el("input", { type: "text", placeholder: (ev.options && ev.options.length ? "Or type your own answer…" : "Type your answer…"), "aria-label": "Answer" });
    free.onkeydown = function (e) { if (e.key === "Enter") send(free.value); e.stopPropagation(); };
    box.appendChild(btns);
    box.appendChild(el("div", { cls: "btns" }, free, el("button", { cls: "primary", text: "Send", onclick: function () { send(free.value); } })));
    q.free = free; q.btns = btns;
    view.approvals[ev.id] = q;
    add(box, true);
    if (document.activeElement === input) input.blur();
    free.focus();
    if (native) native.postMessage({ type: "attention", text: ev.question });
  }
  function onQuestionResolved(ev) {
    var q = view && view.approvals[ev.id]; if (!q) return;
    q.done = true; q.box.classList.add("resolved");
    q.box.firstChild.textContent = ev.answer === null ? "Question skipped" : "You answered: " + ev.answer;
    Array.prototype.forEach.call(q.box.querySelectorAll(".btns"), function (b) { b.remove(); });
  }
  function onApprovalResolved(ev) {
    var a = view && view.approvals[ev.id]; if (!a) return;
    a.done = true; a.box.classList.add("resolved");
    a.box.firstChild.textContent = (a.box.firstChild.textContent.indexOf("connector") >= 0 ? "Connector tool " : "Command ") + (ev.allowed ? "allowed" : "denied");
    a.btns.remove();
  }

  // ---------- run stream ----------
  function connect() {
    if (!S || !S.root) return;
    es = new EventSource("/api/stream?t=" + encodeURIComponent(T));
    es.onmessage = function (msg) {
      var ev = JSON.parse(msg.data);
      if (ev.type === "start") { run.active = true; run.taskId = ev.continueTask; renderComposer(); renderSessions(); return; }
      if (ev.type === "event") {
        var id = ev.event.taskId;
        var newRun = run.taskId !== id;
        run.taskId = id; run.active = true;
        if (view && view.pendingNew && !view.taskId) { view.taskId = id; view.pendingNew = false; renderComposer(); }
        if (view && view.taskId === id) renderEvent(ev.event, false);
        if (newRun) load();
        return;
      }
      var mine = !!(view && run.taskId && view.taskId === run.taskId);
      if (ev.type === "approval" && mine) onApproval(ev);
      else if (ev.type === "approval_resolved" && mine) onApprovalResolved(ev);
      else if (ev.type === "question" && mine) onQuestion(ev);
      else if (ev.type === "question_resolved" && mine) onQuestionResolved(ev);
      else if (ev.type === "finished") {
        run.active = false;
        var key = ev.taskId + ":" + ev.steps + ":" + ev.outcome;
        if (view && view.taskId === ev.taskId && !view.finished[key]) {
          view.finished[key] = true;
          view.working = null; placeWorking();
          loadChanges();
          if (native) native.postMessage({ type: "finished", text: ev.outcome + ": " + ev.summary });
        }
        renderComposer(); load(); loadLimits();
      } else if (ev.type === "failed") {
        run.active = false;
        if (view && (view.pendingNew || mine)) { view.working = null; placeWorking(); add(el("div", { cls: "notice bad", text: "The run failed: " + ev.error })); view.pendingNew = false; }
        renderComposer(); load();
      }
    };
  }

  // ---------- changes ----------
  function clearChanges() { clear($("changesSlot")); }
  function loadChanges() {
    if (!view || !view.taskId) return;
    var id = view.taskId;
    api("/api/diff?task=" + encodeURIComponent(id)).then(function (d) {
      if (!view || view.taskId !== id) return;
      var slot = $("changesSlot");
      clear(slot);
      if (!d.files.length) return;
      var totalA = 0, totalR = 0;
      d.files.forEach(function (f) { var s = d.stats[f] || {}; totalA += s.added || 0; totalR += s.removed || 0; });
      var card = el("div", { cls: "changes" });
      card.appendChild(el("div", { cls: "chh" }, el("strong", { text: d.files.length + " file" + (d.files.length > 1 ? "s" : "") + " changed" + (d.isolated ? " in a separate copy — your folder is untouched" : " — review before committing") }), el("span", { cls: "mono", style: "color:var(--ok)", text: "+" + totalA }), el("span", { cls: "mono", style: "color:var(--bad)", text: "−" + totalR })));
      var fbSlot = el("div", { cls: "chh hidden" });
      card.appendChild(fbSlot);
      function renderFeedbackBtn() {
        clear(fbSlot);
        if (!comments.length) { show(fbSlot, false); return; }
        show(fbSlot, true);
        fbSlot.appendChild(el("strong", { text: comments.length + " comment" + (comments.length > 1 ? "s" : "") + " on this diff" }));
        fbSlot.appendChild(el("button", { cls: "primary", text: "Draft as feedback", onclick: function () {
          var msg = comments.map(function (c) { return c.file + ":\n  " + c.text.trim() + "\n  → " + c.comment; }).join("\n\n");
          input.value = (input.value ? input.value + "\n\n" : "") + "Feedback on the diff:\n\n" + msg;
          autosize();
          input.focus();
        } }));
      }
      var byFile = splitDiff(d.diff);
      var comments = []; // {file, line, text, comment}
      function renderCommentRow(file, line, text, saved) {
        var wrap = el("div");
        var draft = function () {
          var box = el("div", { cls: "dl-comment-row" });
          var ta = el("textarea", { placeholder: "What should change here?" });
          ta.value = saved || "";
          var cancel = el("button", { cls: "link", text: "Cancel", onclick: function () { wrap.replaceChild(saved ? savedRow() : addRow(), wrap.firstChild); } });
          var save = el("button", { cls: "primary", text: "Save", onclick: function () {
            if (!ta.value.trim()) return;
            comments = comments.filter(function (c) { return !(c.file === file && c.line === line); });
            comments.push({ file: file, line: line, text: text, comment: ta.value.trim() });
            wrap.replaceChild(savedRow(), wrap.firstChild);
            renderFeedbackBtn();
          } });
          box.appendChild(ta); box.appendChild(el("div", { cls: "btns" }, cancel, save));
          setTimeout(function () { ta.focus(); }, 0);
          return box;
        };
        var savedRow = function () {
          var c = comments.find(function (x) { return x.file === file && x.line === line; });
          return el("div", { cls: "dl-comment-saved" },
            el("span", { cls: "txt", text: c ? c.comment : "" }),
            el("button", { text: "Edit", onclick: function () { wrap.replaceChild(draft(), wrap.firstChild); } }),
            el("button", { text: "×", title: "Remove", onclick: function () { comments = comments.filter(function (x) { return !(x.file === file && x.line === line); }); wrap.remove(); renderFeedbackBtn(); } }));
        };
        var addRow = function () { return draft(); };
        wrap.appendChild(saved ? savedRow() : draft());
        return wrap;
      }
      d.files.forEach(function (f, i) {
        var st = d.stats[f] || { added: 0, removed: 0 };
        var b = el("div", { cls: "cfb" + (i === 0 && d.files.length <= 3 ? "" : " hidden") });
        (byFile[f] || []).forEach(function (l) {
          var cls = l[0] === "+" ? "dl a" : l[0] === "-" ? "dl d" : l.slice(0, 2) === "@@" ? "dl h" : "dl c";
          var row = el("div", { cls: cls, text: l || " " });
          if (cls !== "dl h") {
            row.appendChild(el("button", { cls: "dl-add", title: "Comment on this line", onclick: function (e) {
              e.stopPropagation();
              if (row.nextElementSibling && row.nextElementSibling.classList.contains("dl-comment-host")) return;
              var host = el("div", { cls: "dl-comment-host" }, renderCommentRow(f, l, l));
              b.insertBefore(host, row.nextSibling);
              row.classList.add("commented");
            } }, "+"));
          }
          b.appendChild(row);
        });
        var h = el("div", { cls: "cfh", onclick: function () { show(b, b.classList.contains("hidden")); } },
          el("span", { cls: "n", text: f }), el("span", { style: "color:var(--ok)", text: "+" + st.added }), el("span", { style: "color:var(--bad)", text: "−" + st.removed }));
        card.appendChild(el("div", { cls: "cfile" }, h, b));
      });
      if (d.isolated) {
        var applyBtn = el("button", { cls: "primary", text: "Apply to my folder", onclick: function () {
          applyBtn.disabled = true;
          api("/api/isolated/apply", { task: id }).then(function (r) { banner("", null); finishCard(card, r.message + " Review and commit it as usual."); load(); })
            .catch(function (e) { applyBtn.disabled = false; banner("bad", e.message); });
        } });
        var dropBtn = el("button", { cls: "danger", text: "Discard", onclick: function () {
          api("/api/isolated/discard", { task: id }).then(function (r) { banner("", null); finishCard(card, r.message); }).catch(function (e) { banner("bad", e.message); });
        } });
        card.appendChild(el("div", { cls: "commit" }, applyBtn, dropBtn));
        follow(function () { slot.appendChild(card); });
        return;
      }
      var firstAsk = document.querySelector("#items .bubble");
      var msg = el("input", { type: "text", placeholder: "Commit message", value: ($("title").textContent || (firstAsk ? firstAsk.textContent : "")).split("\n")[0].slice(0, 72) });
      var armed = null;
      // Discard undoes this task only. The first click asks the server what that means right now and shows it —
      // exactly which files go back, which move aside, which are left alone — and only the second click acts.
      var discardPlan = el("div", { cls: "discard-plan hidden" });
      var disarm = function () { armed = null; discard.classList.remove("armed"); discard.textContent = "Discard"; show(discardPlan, false); };
      var listLine = function (label, files) {
        if (!files.length) return null;
        return el("div", null, el("strong", { text: label + " (" + files.length + "): " }), el("span", { cls: "mono", text: files.slice(0, 8).join(", ") + (files.length > 8 ? ", …" : "") }));
      };
      var discard = el("button", { cls: "danger", text: "Discard", onclick: function () {
        if (!armed) {
          api("/api/discard", { task: id, preview: true }).then(function (pl) {
            clear(discardPlan);
            if (!pl.restore.length && !pl.remove.length) {
              discardPlan.appendChild(el("div", { text: pl.skipped.length ? "Nothing to undo: every file this task changed has changed again since, so it's left as it is." : "Nothing to undo — this task left no changes." }));
              show(discardPlan, true);
              return;
            }
            [listLine("Put back as before the task", pl.restore), listLine("Move to .narrowbit/rewind-trash (created by the task)", pl.remove), listLine("Leave alone (changed again after the task)", pl.skipped)]
              .forEach(function (n) { if (n) discardPlan.appendChild(n); });
            show(discardPlan, true);
            discard.classList.add("armed"); discard.textContent = "Click again to discard";
            armed = setTimeout(disarm, 8000);
          }).catch(function (e) { banner("bad", e.message); });
          return;
        }
        clearTimeout(armed); armed = null;
        api("/api/discard", { task: id }).then(function (r) {
          banner("", null); show(discardPlan, false);
          finishCard(card, r.message.charAt(0).toUpperCase() + r.message.slice(1) + ".");
          load();
        }).catch(function (e) { disarm(); banner("bad", e.message); });
      } });
      var commit = el("button", { cls: "primary", text: "Commit", onclick: function () {
        if (!msg.value.trim()) { msg.focus(); return; }
        var doCommit = function (force) {
          api("/api/commit", { message: msg.value.trim(), task: id, force: force }).then(function (r) { banner("", null); finishCard(card, "Committed " + r.head + " — " + msg.value.trim()); load(); }).catch(function (e) {
            if (e.status === 409 && e.data && e.data.error === "secrets") {
              var box = el("div");
              box.appendChild(el("strong", { text: "Possible secrets in this change — commit paused." }));
              box.appendChild(el("div", { text: "Once pushed, a leaked key can't be taken back; remove it (or add the file to .gitignore) and rotate it if it was real:" }));
              var ul = el("ul"); e.data.findings.forEach(function (f) { ul.appendChild(el("li", { text: f.check + (f.file ? " — " + f.file : "") })); });
              box.appendChild(ul);
              box.appendChild(el("button", { text: "Commit anyway (I've checked)", onclick: function () { doCommit(true); } }));
              banner("warn", box);
            } else banner("bad", e.message);
          });
        };
        doCommit(false);
      } });
      msg.addEventListener("keydown", function (e) { if (e.key === "Enter") commit.click(); });
      card.appendChild(el("div", { cls: "commit" }, msg, commit, discard));
      card.appendChild(discardPlan);
      if (d.skipped && d.skipped.length) card.appendChild(el("div", { cls: "cmsg", text: "Not included (untracked before this task): " + d.skipped.join(", ") }));
      follow(function () { slot.appendChild(card); });
    }).catch(function () {});
  }
  function finishCard(card, text) {
    Array.prototype.forEach.call(card.querySelectorAll(".cfile, .commit, .cmsg"), function (r) { r.remove(); });
    card.appendChild(el("div", { cls: "cmsg", style: "padding-top:10px", text: text }));
  }
  function splitDiff(text) {
    var out = {}, cur = null;
    String(text || "").split("\n").forEach(function (l) {
      var m = /^diff --git a\/(.*) b\//.exec(l);
      if (m) { cur = m[1]; out[cur] = []; return; }
      if (!cur || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) return;
      out[cur].push(l);
    });
    return out;
  }

  // ---------- repo picker ----------
  function openRepoPicker(cancellable) {
    var list = clear($("recentList"));
    var recent = (S && S.recent) || [];
    recent.forEach(function (r) {
      list.appendChild(el("button", { onclick: function () { openRepo(r); } }, el("strong", { text: r.split("/").filter(Boolean).pop() }), el("span", { cls: "path mono", text: r })));
    });
    if (!recent.length) list.appendChild(el("div", { cls: "muted", style: "font-size:13px", text: "No recent repositories." }));
    show($("pickFolder"), !!native); show($("closeRepo"), true); show($("repoErr"), false); show($("repoOverlay"), true);
    show($("startNoFolder"), !!(S && S.root));
    if (!native) $("repoPath").focus();
  }
  function startNoFolder() {
    api("/api/repo/close", {}).then(function (st) {
      if (es) { es.close(); es = null; }
      draft = null; S = null; modelLists = {};
      apply(st);
      resetView(null);
      show($("repoOverlay"), false);
    }).catch(function (e) { banner("bad", e.message); });
  }
  $("startNoFolder").onclick = startNoFolder;
  // One action for opening an existing folder or starting a new one there (an empty or not-yet-created
  // path is created rather than refused — see /api/repo) — mid-draft, it's seeded with the discussion so
  // far, the same "you stay in control" pattern as everywhere else: it fills the composer, never sends.
  function openRepo(path, trust, confirmCreate) {
    var body = { path: path };
    if (trust) body.trust = true;
    if (confirmCreate) body.confirmCreate = true;
    if (S && !S.root && view && view.taskId) body.taskId = view.taskId;
    api("/api/repo", body).then(function (st) {
      if (es) { es.close(); es = null; }
      draft = null; S = null; modelLists = {};
      var seed = st.seedTask;
      delete st.seedTask;
      apply(st);
      resetView(null);
      if (seed) { input.value = seed; autosize(); showToast("Created " + st.name + " — review the message below, then send it to start building."); }
    }).catch(function (e) {
      var n = $("repoErr");
      if (e.status === 409 && e.data && e.data.error === "untrusted") {
        // The repo's own git config names filter programs git would run on its own. Ask here, in the dialog,
        // rather than with window.confirm (unreliable in the native shell), and only proceed on an explicit yes.
        clear(n);
        n.appendChild(el("div", { cls: "trust-q" },
          el("div", { text: "Do you trust this repository?" }),
          el("pre", { cls: "trust-detail", text: e.data.message }),
          el("div", { cls: "btns" },
            el("button", { cls: "primary", id: "trustOpen", onclick: function () { openRepo(e.data.path || path, true, confirmCreate); } }, "Trust and open"),
            el("button", { id: "trustCancel", onclick: function () { clear(n); show(n, false); } }, "Cancel"))));
        show(n, true);
        return;
      }
      if (e.status === 409 && e.data && e.data.error === "confirm-create") {
        // Not a project yet but not empty either: starting one here commits everything in it. Show what's there
        // and make that an explicit choice rather than a side effect of opening a folder.
        clear(n);
        n.appendChild(el("div", { cls: "trust-q" },
          el("div", { text: "This folder isn't a project yet. Starting one here will commit the " + e.data.count + " file(s) already in it:" }),
          el("pre", { cls: "trust-detail", text: e.data.files.join("\n") + (e.data.count > e.data.files.length ? "\n… and " + (e.data.count - e.data.files.length) + " more" : "") }),
          el("div", { cls: "btns" },
            el("button", { cls: "primary", id: "createHere", onclick: function () { openRepo(e.data.path || path, trust, true); } }, "Create project here"),
            el("button", { id: "createCancel", onclick: function () { clear(n); show(n, false); } }, "Cancel"))));
        show(n, true);
        return;
      }
      n.textContent = e.message; show(n, true);
      banner("bad", e.message);
    });
  }
  function slugify(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }
  $("cpbarOpen").onclick = function () {
    openRepoPicker(true);
    var name = slugify($("title").textContent);
    if (name) $("repoPath").value = "~/Projects/" + name;
  };
  $("repoBtn").onclick = function () { openRepoPicker(true); };
  $("crumb").onclick = function () { openRepoPicker(true); };
  $("ghCrumb").onclick = function () {
    var u = $("ghCrumb").dataset.url;
    if (u) { if (native) native.postMessage({ type: "openUrl", url: u }); else window.open(u, "_blank", "noopener"); }
  };
  $("repoOverlay").onclick = function (e) { if (e.target === this) show(this, false); };
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { show($("repoOverlay"), false); show($("skillOverlay"), false); show($("ghCreateOverlay"), false); } });
  $("closeRepo").onclick = function () { show($("repoOverlay"), false); };
  $("openRepo").onclick = function () { var v = $("repoPath").value.trim(); if (v) openRepo(v); };
  $("repoPath").addEventListener("keydown", function (e) { if (e.key === "Enter") $("openRepo").click(); });
  $("pickFolder").onclick = function () { native.postMessage({ type: "pickFolder" }); };
  window.narrowbitFolderPicked = function (path) { if (path) openRepo(path); };
  $("locateBtn").onclick = function () { openRepoPicker(true); };
  $("initBtn").onclick = function () {
    var b = $("initBtn"); b.disabled = true; b.textContent = "Indexing…";
    api("/api/init", {}).then(function (st) { apply(st); resetView(null); }).catch(function (e) { banner("bad", e.message); }).then(function () { b.disabled = false; b.textContent = "Set up Narrowbit here"; });
  };
  function closeSide() { $("app").classList.remove("side-open"); }
  // Phones and narrow windows slide the sidebar over the page; wider windows hide it and give the space to the chat.
  function toggleSidebar() {
    var app = $("app");
    if (window.matchMedia("(max-width: 820px)").matches) { app.classList.toggle("side-open"); return; }
    var hidden = app.classList.toggle("side-hidden");
    try { localStorage.setItem("nb-side-hidden", hidden ? "1" : "0"); } catch (e) {}
  }
  try { if (localStorage.getItem("nb-side-hidden") === "1") $("app").classList.add("side-hidden"); } catch (e) {}
  $("menuBtn").onclick = toggleSidebar;
  $("hideSideBtn").onclick = toggleSidebar;
  // Skills list can grow long (built-ins + imports); collapse it independently of hiding the whole sidebar.
  function setSkillsCollapsed(on) {
    $("skillsLabel").classList.toggle("collapsed", on);
    show($("skillsList"), !on);
    store("skillsCollapsed", on ? "1" : "0");
  }
  $("skillsLabel").addEventListener("click", function (e) {
    if (e.target.closest("#addSkillBtn")) return;
    setSkillsCollapsed(!$("skillsLabel").classList.contains("collapsed"));
  });
  // Hidden by default on a fresh launch (nothing stored yet) — only an explicit "0" (the user expanded it
  // once) keeps it open; unlike most such flags here, "unset" doesn't mean "off".
  setSkillsCollapsed(store("skillsCollapsed") !== "0");
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") { e.preventDefault(); toggleSidebar(); }
  });

  // ---------- examples ----------
  ["Fix the failing test in …", "Add input validation to …", "Rename … and update every caller", "Why does … return the wrong value? Fix it."].forEach(function (x) {
    $("examples").appendChild(el("button", { text: x, onclick: function () { input.value = x; autosize(); input.focus(); var i = x.indexOf("…"); input.setSelectionRange(i, i + 1); } }));
  });

  // ---------- subscription limits ----------
  function until(t) {
    if (!t) return "";
    var mm = Math.round((t * 1000 - Date.now()) / 60000);
    return mm <= 0 ? "resetting" : mm < 90 ? "resets in " + mm + "m" : mm < 2880 ? "resets in " + Math.round(mm / 60) + "h" : "resets " + new Date(t * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric" });
  }
  function renderLimits(L) {
    var box = clear($("limits")), tips = [], anyStale = false;
    [["claude", "Claude"], ["codex", "Codex"]].forEach(function (pair) {
      var l = L[pair[0]];
      var row = el("div", { cls: "lrow" }, el("span", { cls: "name", text: pair[1] }));
      if (!l || (!l.fiveHour && !l.weekly)) {
        row.appendChild(el("span", { style: "grid-column: span 2", text: l && l.error ? (/login/.test(l.error) ? "log in to see limits" : "unavailable") : "no reading yet" }));
        tips.push(pair[1] + ": " + (l && l.error ? l.error : "no reading yet"));
      } else {
        // Codex's reading is actively re-checked (free); Claude's only updates as a side effect of an actual
        // Claude call through Narrowbit, so it can go stale for a while if nothing's called it recently —
        // the number shown may not reflect the current rolling window. Flag it rather than show it as current.
        var ageMin = l.checkedAt ? Math.round((Date.now() - new Date(l.checkedAt).getTime()) / 60000) : null;
        var stale = pair[0] === "claude" && ageMin !== null && ageMin > 10;
        if (stale) anyStale = true;
        [["5h", l.fiveHour, "5-hour"], ["wk", l.weekly, "Weekly"]].forEach(function (w) {
          if (!w[1]) { row.appendChild(el("span")); return; }
          var pct = w[1].usedPercent;
          row.appendChild(el("span", { cls: "win" + (stale ? " stale" : "") }, el("span", { text: w[0] }), el("span", { cls: "bar" }, el("i", { cls: pct >= 90 ? "high" : pct >= 70 ? "mid" : "", style: "width:" + Math.min(100, pct) + "%" })), el("span", { text: Math.round(pct) + "%" + (stale ? "?" : "") })));
          tips.push(pair[1] + " " + w[2] + ": " + pct + "% used, " + until(w[1].resetsAt) + (stale ? " — as of " + ageMin + "m ago, may be out of date" : ""));
        });
      }
      box.appendChild(row);
    });
    box.title = tips.join("\n") + (anyStale ? "\n\nClaude's number may be stale (it only updates when Narrowbit makes a Claude call) —" : "") + "\n\nClick to check now (Claude: one tiny Haiku call).";
  }
  function loadLimits() { api("/api/limits").then(renderLimits).catch(function () {}); }
  $("limits").onclick = function () {
    $("limits").style.opacity = ".5";
    api("/api/limits/refresh", {}).then(renderLimits).catch(function (e) { banner("bad", e.message); }).then(function () { $("limits").style.opacity = ""; });
  };
  loadLimits();
  setInterval(loadLimits, 60000);
  loadReadiness(false);
  loadUpdate(false);
  setInterval(function () { loadUpdate(true); }, 3 * 60 * 60 * 1000);

  load();
})();
</script>
</body>
</html>
`;
