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
.side-label { font-size: 11px; font-weight: 600; color: var(--faint); text-transform: uppercase; letter-spacing: .07em; padding: 8px 18px 4px; }
.sessions { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
.sess { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 7px 10px; border-radius: 8px; margin-bottom: 1px; }
.sess:hover { background: var(--panel-2); }
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

/* ---------- main ---------- */
main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.topbar { height: 48px; flex: none; display: flex; align-items: center; gap: 10px; padding: 0 16px; border-bottom: 1px solid transparent; }
.topbar.scrolled { border-bottom-color: var(--line); }
.topbar .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.repo-bar { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.repo-bar .rb-label { font-weight: 600; white-space: nowrap; flex: none; }
.repo-bar .rb-recent { display: flex; align-items: center; gap: 4px; overflow-x: auto; flex: none; }
.repo-bar .rb-recent button { font-size: 12px; padding: 4px 8px; border-radius: 6px; background: var(--panel-2); white-space: nowrap; }
.repo-bar .rb-recent button:hover { background: var(--line); }
.repo-bar input { flex: 1; min-width: 80px; font-size: 12.5px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); }
.repo-bar button.primary { flex: none; padding: 5px 10px; font-size: 12.5px; }
.pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 2px 9px; border-radius: 99px; background: var(--panel-2); color: var(--muted); white-space: nowrap; border: 0; }
.pill.ok { color: var(--ok); } .pill.warn { color: var(--warn); }
#menuBtn { display: none; }
.scroll { flex: 1; overflow-y: auto; min-height: 0; }
.thread { max-width: 780px; margin: 0 auto; padding: 8px 24px 32px; }

.welcome { text-align: center; padding: 12vh 0 24px; }
.welcome h1 { font-family: var(--serif); font-weight: 400; font-size: 30px; margin: 0 0 8px; letter-spacing: -.01em; }
.welcome p { color: var(--muted); margin: 0 auto 22px; max-width: 480px; }
.examples { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.examples button { border-radius: 99px; font-size: 13px; color: var(--muted); }
.setup { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 20px 0; box-shadow: var(--shadow); }

.msg-user { display: flex; justify-content: flex-end; margin: 22px 0 14px; }
.msg-user .bubble { background: var(--panel-2); border-radius: 14px; padding: 10px 14px; max-width: 85%; white-space: pre-wrap; word-break: break-word; }
.narr { margin: 12px 0 4px; font-family: var(--serif); font-size: 15.5px; line-height: 1.55; }
.final { margin: 16px 0 6px; font-family: var(--serif); font-size: 15.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.final code, .narr code, .bubble code, .plan code, .review code { font-family: var(--mono); font-size: .85em; background: var(--panel-2); padding: 1px 5px; border-radius: 5px; }
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
.step .prev { font-family: var(--mono); font-size: 12px; color: var(--muted); padding: 0 0 2px 22px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.step .prev::before { content: "⎿  "; color: var(--faint); }
.step .sb { margin: 4px 0 8px 22px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); overflow: auto; max-height: 360px; }
.step .sb pre { margin: 0; padding: 8px 10px; font: 12px/1.5 var(--mono); white-space: pre-wrap; word-break: break-word; }
.dl { font: 12px/1.55 var(--mono); white-space: pre; padding: 0 10px; min-height: 18px; }
.dl.a { background: var(--add-bg); color: var(--add-fg); } .dl.d { background: var(--del-bg); color: var(--del-fg); } .dl.c { color: var(--muted); }
.dl.h { color: var(--faint); background: var(--panel-2); }
.notice { font-size: 12.5px; color: var(--muted); margin: 6px 0 6px 22px; font-style: italic; }
.notice.warn { color: var(--warn); } .notice.bad { color: var(--bad); font-style: normal; }
.divider { display: flex; align-items: center; gap: 10px; color: var(--faint); font-size: 11.5px; margin: 14px 0; }
.divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--line); }

.review { border-left: 3px solid var(--t-escalate); background: color-mix(in srgb, var(--t-escalate) 7%, transparent); border-radius: 0 10px 10px 0; padding: 8px 12px; margin: 10px 0; font-size: 13.5px; }
.review .rh { display: flex; gap: 8px; align-items: center; font-weight: 600; }
.review .rh .v-ok { color: var(--ok); } .review .rh .v-rev { color: var(--warn); }
.review .fb { margin-top: 4px; color: var(--muted); white-space: pre-wrap; }

.approval { border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--line)); background: color-mix(in srgb, var(--accent) 6%, var(--panel)); border-radius: 12px; padding: 12px 14px; margin: 10px 0; box-shadow: var(--shadow); }
.approval .ah { font-weight: 600; }
.approval pre { margin: 8px 0 10px; padding: 8px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; white-space: pre-wrap; word-break: break-all; font: 12.5px var(--mono); }
.approval .btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.approval.resolved { box-shadow: none; opacity: .75; padding: 8px 12px; }
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
.composer { max-width: 780px; margin: 0 auto; background: var(--panel); border: 1px solid var(--line-2); border-radius: 16px; box-shadow: var(--shadow); padding: 10px 12px 8px; }
.composer:focus-within { border-color: color-mix(in srgb, var(--accent) 50%, var(--line-2)); }
.banner { font-size: 12.5px; border-radius: 9px; padding: 8px 10px; margin-bottom: 8px; }
.banner.warn { background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--text); }
.banner.bad { background: color-mix(in srgb, var(--bad) 12%, transparent); color: var(--bad); }
.banner ul { margin: 4px 0 6px; padding-left: 18px; }
#input { width: 100%; border: 0; background: transparent; resize: none; outline: none; font-size: 15px; line-height: 1.5; max-height: 240px; min-height: 26px; padding: 2px 2px; }
.cbar { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.cbar .mchip { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; padding: 4px 8px; border-radius: 8px; font-size: 12.5px; color: var(--muted); max-width: 320px; }
.cbar .mchip:hover { background: var(--panel-2); color: var(--text); }
.cbar .mchip span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tog { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--muted); padding: 4px 8px; border-radius: 8px; cursor: pointer; user-select: none; }
.tog:hover { background: var(--panel-2); }
.tog input { accent-color: var(--accent); margin: 0; }
.cbar .spacer { flex: 1; }
.usage { font-size: 11.5px; color: var(--faint); white-space: nowrap; }
.send { width: 32px; height: 32px; border-radius: 10px; padding: 0; display: grid; place-items: center; background: var(--accent); border: 0; color: var(--on-accent); font-size: 16px; font-weight: 700; }
.send:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
.stop { width: 32px; height: 32px; border-radius: 10px; padding: 0; display: grid; place-items: center; background: var(--text); color: var(--bg); border: 0; }
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
.pinfo { font-size: 12px; color: var(--muted); margin: 6px 0 8px; }
.pinfo a { color: var(--accent); }
.subrow { display: flex; gap: 6px; margin: 2px 0 8px; align-items: center; flex-wrap: wrap; }
.subrow input { flex: 1 1 140px; width: auto; }
.subrow .status { font-size: 12px; color: var(--ok); flex: 1 1 auto; }
.slot { display: grid; grid-template-columns: 24px 1fr; gap: 3px 10px; align-items: center; margin-bottom: 10px; }
.slot .num { width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; font-weight: 700; font-size: 12px; color: #fff; }
.slot label { font-size: 12px; color: var(--muted); }
.slot input { grid-column: 2; }
.freeonly { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); margin: -2px 0 8px 34px; }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 3px; }
.check { display: flex; gap: 9px; align-items: flex-start; margin: 8px 0; font-size: 13px; }
.check input { margin-top: 3px; accent-color: var(--accent); }
.check small { display: block; color: var(--muted); font-size: 12px; }
.note { font-size: 12px; color: var(--warn); margin-top: 6px; }
.saved { font-size: 12px; color: var(--ok); min-height: 16px; }
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--bg) 70%, transparent); backdrop-filter: blur(6px); display: grid; place-items: center; z-index: 40; padding: 16px; }
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
  .thread { padding: 8px 16px 24px; }
  .composer-wrap { padding: 0 12px 12px; }
  .cbar .mchip { max-width: 160px; }
}
</style>
</head>
<body>
<div class="app" id="app">
  <aside>
    <div class="side-top"><span class="brand"><svg class="mark" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="20" y="25" width="8" height="50"/><rect x="20" y="25" width="20" height="8"/><rect x="20" y="67" width="20" height="8"/><rect x="72" y="25" width="8" height="50"/><rect x="60" y="25" width="20" height="8"/><rect x="60" y="67" width="20" height="8"/><rect x="44" y="44" width="12" height="12"/></svg>Narrowbit</span></div>
    <button class="new-btn" id="newBtn"><span class="plus">+</span>New task <span style="margin-left:auto"><kbd>⌘</kbd> <kbd>K</kbd></span></button>
    <button class="repo-btn" id="repoBtn" title="Switch repository"><span class="rn" id="repoName">No repository</span><span class="rb" id="repoBranch"></span></button>
    <div class="side-label">Sessions</div>
    <div class="sessions" id="sessions"></div>
    <div class="side-foot">
      <button class="settings" id="settingsBtn"><span style="font-size:16px">⚙</span><span style="min-width:0"><span>Models &amp; settings</span><span class="sub" id="settingsSub"></span></span></button>
      <button class="limits" id="limits" title="Subscription usage"></button>
    </div>
  </aside>

  <main>
    <div class="topbar" id="topbar">
      <button class="ghost" id="menuBtn" aria-label="Menu">☰</button>
      <div class="repo-bar hidden" id="repoBar">
        <span class="rb-label">Choose a folder to get started</span>
        <div class="rb-recent" id="repoBarRecent"></div>
        <input type="text" id="repoBarPath" placeholder="/path/to/your/project" class="mono">
        <button id="repoBarPick" class="hidden">Choose…</button>
        <button class="primary" id="repoBarOpen">Open</button>
      </div>
      <span class="title" id="title"></span>
      <button class="pill hidden" id="planMini"></button>
      <span class="pill hidden" id="treePill"></span>
    </div>
    <div class="scroll" id="scroll">
      <div class="thread" id="thread">
        <div class="welcome hidden" id="welcome">
          <h1 id="welcomeTitle">What should we work on?</h1>
          <p>Narrowbit plans with your strongest model, does the work with cheaper ones, and asks before running commands. You review the diff before anything is committed.</p>
          <div class="examples" id="examples"></div>
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
      <div class="composer">
        <div id="banner" class="banner hidden"></div>
        <textarea id="input" rows="1" placeholder="Describe a task…"></textarea>
        <div class="cbar">
          <button class="mchip" id="modelChip" title="Models &amp; settings"><span id="modelChipText"></span>▾</button>
          <label class="tog" title="Model 3 plans the task first and reviews the diff before it's done"><input type="checkbox" id="leadTog"> Lead</label>
          <label class="tog" title="Shell commands wait for your approval"><input type="checkbox" id="askTog"> Ask before commands</label>
          <span class="spacer"></span>
          <span class="usage" id="usage"></span>
          <button class="stop hidden" id="stopBtn" title="Stop after the current step"><i></i></button>
          <button class="send" id="sendBtn" title="Send (Enter)">↑</button>
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
    <h3>Behaviour</h3>
    <label class="check"><input type="checkbox" id="leadChk"><span>Lead mode<small>Model 3 writes a plan before work starts and reviews the diff before it's reported done. Two extra calls to your strongest model per task.</small></span></label>
    <label class="check"><input type="checkbox" id="askChk"><span>Ask before running commands<small>Reads, edits and verify run freely; shell commands wait for you.</small></span></label>
    <div class="note hidden" id="providerNote"></div>
    <div class="saved" id="savedMsg"></div>
  </div>
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

<script>
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
    show($("repoOverlay"), false);
    showRepoBar(!S.root);
    if (!S.root) { show($("welcome"), true); show($("setupCard"), false); renderComposer(); return; }
    if (!draft || draft.root !== S.root) draft = { root: S.root, provider: S.selection.provider, effort: S.selection.effort };
    run.active = S.running; if (S.running) run.taskId = S.runningTask;
    renderSessions(); renderSettings(); renderComposer();
    show($("setupCard"), !S.initialized);
    if (first) {
      if (S.running && S.runningTask) openSession(S.runningTask);
      else newTask();
    }
    if (!es) connect();
  }
  // Non-blocking: unlike switching repositories later (openRepoPicker's overlay), the app is fully
  // visible behind this — it's a bar in the topbar, not a gate you have to clear before anything works.
  function showRepoBar(on) {
    show($("repoBar"), on);
    show($("title"), !on);
    if (!on) return;
    var list = clear($("repoBarRecent"));
    ((S && S.recent) || []).slice(0, 4).forEach(function (r) {
      list.appendChild(el("button", { title: r, onclick: function () { openRepo(r); } }, r.split("/").filter(Boolean).pop()));
    });
    show($("repoBarPick"), !!native);
  }
  function renderRepo() {
    $("repoName").textContent = S && S.root ? S.name : "No repository";
    $("repoBranch").textContent = S && S.git && S.git.branch ? S.git.branch + (S.git.head ? " · " + S.git.head : "") : "";
    $("welcomeTitle").textContent = S && S.root ? "What should we work on in " + S.name + "?" : "What should we work on?";
    var t = $("treePill");
    if (S && S.git && S.git.isRepo) {
      var n = S.git.changed.length + S.git.untracked.filter(function (f) { return f !== ".narrowbitignore"; }).length;
      clear(t).appendChild(el("span", { cls: "dot" }));
      t.appendChild(document.createTextNode(n ? n + " uncommitted" : "clean"));
      t.className = "pill " + (n ? "warn" : "ok");
      show(t, true);
    } else show(t, false);
  }
  function renderSessions() {
    var box = clear($("sessions"));
    if (!S || !S.history || !S.history.length) { box.appendChild(el("div", { cls: "muted", style: "font-size:12.5px;padding:6px 10px", text: "No sessions yet." })); return; }
    S.history.forEach(function (r) {
      var live = run.active && run.taskId === r.id;
      var b = el("button", { cls: "sess" + (view && view.taskId === r.id ? " on" : ""), title: r.goal, onclick: function () { openSession(r.id); closeSide(); } },
        el("div", { cls: "st" }, el("span", { cls: "dot o-" + (live ? "running" : r.outcome) }), el("span", { text: r.goal })),
        el("div", { cls: "sm", text: (live ? "running" : ago(r.last)) + (r.turns > 1 ? " · " + r.turns + " messages" : "") + " · " + fmt(r.tokens) + " tok" }));
      box.appendChild(b);
    });
  }

  // ---------- settings drawer ----------
  var KIND = { subscription: "Subscriptions", free: "APIs with a free tier", paid: "Paid APIs", local: "Local models — free, offline" };
  var PHASE = {
    explore: ["1", "Explore — reads and orients, before any edit", "var(--t-explore)"],
    execute: ["2", "Execute — edits and verifies", "var(--t-execute)"],
    escalate: ["3", "Lead — plans, reviews, takes over when stuck", "var(--t-escalate)"]
  };
  function openDrawer() { show($("drawer"), true); show($("scrim"), true); }
  function closeDrawer() { show($("drawer"), false); show($("scrim"), false); }
  $("settingsBtn").onclick = openDrawer; $("modelChip").onclick = openDrawer;
  $("closeDrawer").onclick = closeDrawer; $("scrim").onclick = function () { closeDrawer(); closeSide(); };

  function renderSettings() {
    if (!S || !S.providers) return;
    var sel = clear($("providerSel"));
    ["subscription", "free", "paid", "local"].forEach(function (group) {
      var g = el("optgroup", { label: KIND[group] });
      Object.keys(S.providers).forEach(function (prov) {
        var P = S.providers[prov];
        if ((P.kind === "api" ? (P.free ? "free" : "paid") : P.kind) !== group) return;
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
    if (hasUrl) {
      var u = el("input", { type: "text", cls: "mono", value: P.baseUrl || "", placeholder: "http://127.0.0.1:8080/v1", "aria-label": "Base URL" });
      urlRow.appendChild(u);
      urlRow.appendChild(el("button", { text: "Set URL", onclick: function () {
        api("/api/endpoint", { provider: draft.provider, baseUrl: u.value }).then(function (st) { delete modelLists[draft.provider]; apply(st); flash($("savedMsg"), "Endpoint saved"); }).catch(function (e) { flash($("savedMsg"), e.message); });
      } }));
    }

    var slots = clear($("slots"));
    var list = modelLists[draft.provider];
    S.phases.forEach(function (ph) {
      var inp = el("input", { type: "text", id: "slot-" + ph, list: "modelList", value: P.tiers[ph] || "", placeholder: list && !list.models.length ? "type a model id" : "choose a model", autocomplete: "off", spellcheck: "false", onchange: function () { saveModels(); } });
      slots.appendChild(el("div", { cls: "slot" },
        el("span", { cls: "num", style: "background:" + PHASE[ph][2], text: PHASE[ph][0] }),
        el("label", { for: "slot-" + ph, text: PHASE[ph][1] }), inp));
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
    $("leadChk").checked = S.lead;
    var notes = [];
    if (P.unavailable) notes.push(P.unavailable);
    if (list && !list.models.length) notes.push(list.note);
    if (S.selectionError) notes.push(S.selectionError);
    $("providerNote").textContent = notes.join(" "); show($("providerNote"), notes.length > 0);
    var t = S.selection.tiers, lbl = S.providers[S.selection.provider].label;
    var line = lbl + " · " + (t.explore || "?") + " / " + (t.execute || "?") + " / " + (t.escalate || "?");
    $("settingsSub").textContent = line; $("modelChipText").textContent = line;
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
    if (!tiers) { tiers = {}; S.phases.forEach(function (ph) { tiers[ph] = $("slot-" + ph).value.trim(); }); }
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
  $("leadChk").onchange = function () { setLead($("leadChk").checked); };
  $("leadTog").onchange = function () { setLead($("leadTog").checked); };
  $("maxSteps").value = store("maxSteps") || "20";
  $("maxSteps").onchange = function () { store("maxSteps", $("maxSteps").value); };
  function askOn() { return store("askCmd") !== "0"; }
  function setAsk(on) { store("askCmd", on ? "1" : "0"); $("askChk").checked = on; $("askTog").checked = on; }
  setAsk(askOn());
  $("askChk").onchange = function () { setAsk($("askChk").checked); };
  $("askTog").onchange = function () { setAsk($("askTog").checked); };

  // ---------- composer ----------
  var input = $("input");
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(240, input.scrollHeight) + "px"; }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(false); }
  });
  function viewingRun() { return !!(view && run.active && (view.pendingNew || (view.taskId && run.taskId === view.taskId))); }
  function renderComposer() {
    var busy = run.active;
    var P = S && S.providers && S.providers[S.selection.provider];
    show($("stopBtn"), viewingRun());
    show($("sendBtn"), !viewingRun());
    $("sendBtn").disabled = !S || !S.root || !S.initialized || busy || !!(P && P.unavailable);
    $("leadTog").checked = !!(S && S.lead);
    input.placeholder = view && view.taskId ? "Ask for a follow-up or a change…" : "Describe a task…";
    $("hint").textContent = !S || !S.root ? "Choose a folder above to get started" : busy && !viewingRun() ? "Another task is running — open it from the sidebar to watch or stop it." : P && P.unavailable ? P.unavailable : "Enter to send · Shift+Enter for a new line";
  }
  function send(force) {
    var text = input.value.trim();
    if (!text || $("sendBtn").disabled) return;
    banner("", null);
    var cont = view && view.taskId ? view.taskId : null;
    // The server logs the task's first event before this request returns, so the view must already
    // be waiting for it.
    if (!cont) { resetView(null); view.pendingNew = true; show($("welcome"), false); }
    api("/api/run", { task: text, force: !!force, continueTask: cont, maxSteps: Number($("maxSteps").value) || 20, askBeforeCommands: askOn() })
      .then(function () {
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

  // ---------- conversation view ----------
  function resetView(taskId) {
    view = { taskId: taskId, seen: {}, step: null, plan: null, tokens: 0, cost: 0, segTokens: 0, segCost: 0, segSteps: 0, segStart: null, approvals: {}, pendingNew: false, working: null, finished: {} };
    clear($("items")); clearChanges();
    show($("welcome"), !taskId && !!(S && S.initialized));
    $("title").textContent = "";
    show($("planMini"), false);
    updateUsage();
    renderComposer();
  }
  function newTask() { resetView(null); renderSessions(); input.focus(); closeSide(); }
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
  function updateUsage() { $("usage").textContent = view && view.tokens ? fmt(view.tokens) + " tokens · " + money(view.cost) : ""; }

  var VERB = { read: "Read", grep: "Grep", search: "Search", edit: "Edit", run: "Run", verify: "Verify", recall: "Recall", remember: "Remember" };
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
      var t = e.tokens.inputTokens + e.tokens.cacheCreationTokens + e.tokens.cacheReadTokens + e.tokens.outputTokens;
      view.tokens += t; view.cost += e.tokens.costUsd; view.segTokens += t; view.segCost += e.tokens.costUsd;
      updateUsage();
      return;
    }
    if (e.type === "decision" && e.actor === "user") {
      var text = m.goal || m.followUp || "";
      if (m.goal) $("title").textContent = m.goal;
      show($("welcome"), false);
      view.segTokens = 0; view.segCost = 0; view.segSteps = 0; view.segStart = new Date(e.at).getTime();
      add(el("div", { cls: "msg-user" }, el("div", { cls: "bubble" }, rich(text))), true);
      if (!replay) setWorking(S && S.lead && m.goal ? "Lead is planning…" : "Thinking…");
      return;
    }
    if (e.type === "plan") { renderPlan(m); if (!replay) setWorking("Working…"); return; }
    if (e.type === "tool_call") {
      view.segSteps++;
      if (m.note) add(el("div", { cls: "narr" }, rich(m.note)));
      view.step = stepBlock(m);
      add(view.step.box);
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
      add(el("div", { cls: "final" }, rich(e.summary.slice(6))));
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
      if (m.outcome === "error" && m.summary) line.appendChild(el("span", { cls: "o-blocked", text: m.summary }));
      add(line);
      return;
    }
    if (e.type === "handoff") { add(el("div", { cls: "divider", text: "context compacted — continuing in a fresh session" })); return; }
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
    var box = el("div", { cls: "approval" }, el("div", { cls: "ah", text: "Run this command?" }), el("pre", { text: ev.command }));
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
  function onApprovalResolved(ev) {
    var a = view && view.approvals[ev.id]; if (!a) return;
    a.done = true; a.box.classList.add("resolved");
    a.box.firstChild.textContent = ev.allowed ? "Command allowed" : "Command denied";
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
      card.appendChild(el("div", { cls: "chh" }, el("strong", { text: d.files.length + " file" + (d.files.length > 1 ? "s" : "") + " changed — review before committing" }), el("span", { cls: "mono", style: "color:var(--ok)", text: "+" + totalA }), el("span", { cls: "mono", style: "color:var(--bad)", text: "−" + totalR })));
      var byFile = splitDiff(d.diff);
      d.files.forEach(function (f, i) {
        var st = d.stats[f] || { added: 0, removed: 0 };
        var b = el("div", { cls: "cfb" + (i === 0 && d.files.length <= 3 ? "" : " hidden") });
        (byFile[f] || []).forEach(function (l) {
          var cls = l[0] === "+" ? "dl a" : l[0] === "-" ? "dl d" : l.slice(0, 2) === "@@" ? "dl h" : "dl c";
          b.appendChild(el("div", { cls: cls, text: l || " " }));
        });
        var h = el("div", { cls: "cfh", onclick: function () { show(b, b.classList.contains("hidden")); } },
          el("span", { cls: "n", text: f }), el("span", { style: "color:var(--ok)", text: "+" + st.added }), el("span", { style: "color:var(--bad)", text: "−" + st.removed }));
        card.appendChild(el("div", { cls: "cfile" }, h, b));
      });
      var firstAsk = document.querySelector("#items .bubble");
      var msg = el("input", { type: "text", placeholder: "Commit message", value: ($("title").textContent || (firstAsk ? firstAsk.textContent : "")).split("\n")[0].slice(0, 72) });
      var armed = null;
      var discard = el("button", { cls: "danger", text: "Discard", onclick: function () {
        if (!armed) { discard.classList.add("armed"); discard.textContent = "Click again to discard"; armed = setTimeout(function () { armed = null; discard.classList.remove("armed"); discard.textContent = "Discard"; }, 4000); return; }
        clearTimeout(armed); armed = null;
        api("/api/discard", { task: id }).then(function (r) {
          var t = "Reverted " + r.restored.length + " file(s)" + (r.deleted.length ? ", removed " + r.deleted.length + " new file(s)" : "") + (r.kept.length ? "; left " + r.kept.length + " untracked file(s) this task didn't create" : "") + ".";
          banner("", null); finishCard(card, t); load();
        }).catch(function (e) { banner("bad", e.message); });
      } });
      var commit = el("button", { cls: "primary", text: "Commit", onclick: function () {
        if (!msg.value.trim()) { msg.focus(); return; }
        api("/api/commit", { message: msg.value.trim(), task: id }).then(function (r) { banner("", null); finishCard(card, "Committed " + r.head + " — " + msg.value.trim()); load(); }).catch(function (e) { banner("bad", e.message); });
      } });
      msg.addEventListener("keydown", function (e) { if (e.key === "Enter") commit.click(); });
      card.appendChild(el("div", { cls: "commit" }, msg, commit, discard));
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
    show($("pickFolder"), !!native); show($("closeRepo"), cancellable); show($("repoErr"), false); show($("repoOverlay"), true);
    if (!native) $("repoPath").focus();
  }
  function openRepo(path) {
    api("/api/repo", { path: path }).then(function (st) {
      if (es) { es.close(); es = null; }
      draft = null; S = null; modelLists = {};
      apply(st);
    }).catch(function (e) {
      var n = $("repoErr"); n.textContent = e.message; show(n, true);
      banner("bad", e.message);
    });
  }
  $("repoBtn").onclick = function () { openRepoPicker(!!(S && S.root)); };
  $("closeRepo").onclick = function () { show($("repoOverlay"), false); };
  $("openRepo").onclick = function () { var v = $("repoPath").value.trim(); if (v) openRepo(v); };
  $("repoPath").addEventListener("keydown", function (e) { if (e.key === "Enter") $("openRepo").click(); });
  $("pickFolder").onclick = function () { native.postMessage({ type: "pickFolder" }); };
  $("repoBarOpen").onclick = function () { var v = $("repoBarPath").value.trim(); if (v) openRepo(v); };
  $("repoBarPath").addEventListener("keydown", function (e) { if (e.key === "Enter") $("repoBarOpen").click(); });
  $("repoBarPick").onclick = function () { native.postMessage({ type: "pickFolder" }); };
  window.narrowbitFolderPicked = function (path) { if (path) openRepo(path); };
  $("initBtn").onclick = function () {
    var b = $("initBtn"); b.disabled = true; b.textContent = "Indexing…";
    api("/api/init", {}).then(function (st) { apply(st); resetView(null); }).catch(function (e) { banner("bad", e.message); }).then(function () { b.disabled = false; b.textContent = "Set up Narrowbit here"; });
  };
  function closeSide() { $("app").classList.remove("side-open"); }
  $("menuBtn").onclick = function () { $("app").classList.toggle("side-open"); };

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
    var box = clear($("limits")), tips = [];
    [["claude", "Claude"], ["codex", "Codex"]].forEach(function (pair) {
      var l = L[pair[0]];
      var row = el("div", { cls: "lrow" }, el("span", { cls: "name", text: pair[1] }));
      if (!l || (!l.fiveHour && !l.weekly)) {
        row.appendChild(el("span", { style: "grid-column: span 2", text: l && l.error ? (/login/.test(l.error) ? "log in to see limits" : "unavailable") : "no reading yet" }));
        tips.push(pair[1] + ": " + (l && l.error ? l.error : "no reading yet"));
      } else {
        [["5h", l.fiveHour, "5-hour"], ["wk", l.weekly, "Weekly"]].forEach(function (w) {
          if (!w[1]) { row.appendChild(el("span")); return; }
          var pct = w[1].usedPercent;
          row.appendChild(el("span", { cls: "win" }, el("span", { text: w[0] }), el("span", { cls: "bar" }, el("i", { cls: pct >= 90 ? "high" : pct >= 70 ? "mid" : "", style: "width:" + Math.min(100, pct) + "%" })), el("span", { text: Math.round(pct) + "%" })));
          tips.push(pair[1] + " " + w[2] + ": " + pct + "% used, " + until(w[1].resetsAt));
        });
      }
      box.appendChild(row);
    });
    box.title = tips.join("\n") + "\n\nClick to check now (Claude: one tiny Haiku call).";
  }
  function loadLimits() { api("/api/limits").then(renderLimits).catch(function () {}); }
  $("limits").onclick = function () {
    $("limits").style.opacity = ".5";
    api("/api/limits/refresh", {}).then(renderLimits).catch(function (e) { banner("bad", e.message); }).then(function () { $("limits").style.opacity = ""; });
  };
  loadLimits();
  setInterval(loadLimits, 60000);

  load();
})();
</script>
</body>
</html>
`;
