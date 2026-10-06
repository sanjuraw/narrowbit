import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { readAttachment } from "../attachments.js";
import { recordClaudeLimits } from "../limits.js";
import { isPermanentModelError } from "../errors.js";
import { extractText, parseStream } from "../streamjson.js";

/**
 * Model adapter for the owned runtime, backed by the `claude` CLI under the user's Claude
 * subscription — not a direct Anthropic API key. Every call is one stateless, tool-free turn:
 * `--tools ""` and an empty MCP config strip out Claude Code's own agentic loop, so it is used
 * purely as a text-completion oracle. Narrowbit's runtime (events.ts/context.ts) decides and
 * executes every action itself; this keeps every model call attributable in the usage ledger,
 * per CLAUDE.md's constraint, instead of letting a sub-agent do work off the books.
 *
 * "Cost" here is subscription rate-limit usage, not dollars: `costUsd` (when present) is
 * Claude Code's own notional dollar-equivalent for the call, useful for comparing against past
 * $-denominated benchmark runs, but nothing is actually billed per token.
 *
 * `--safe-mode` is required, not optional: without it, Claude Code auto-loads CLAUDE.md, skills
 * and memory on every single call regardless of `--system-prompt`/`--tools ""` — measured at
 * ~12.5k fresh cache-creation tokens per call from this repo's own CLAUDE.md, none of it reused
 * since each call is a fresh, non-persisted session. That's the exact fixed-injection-tax failure
 * the three benchmark runs diagnosed, reappearing at the CLI layer; `--safe-mode` avoids it while
 * leaving subscription auth, model selection and built-in tools working normally.
 *
 * Session persistence: a fresh, non-persisted call per step (the original design) pays full,
 * uncached price on every single turn — measured directly in a bench.ts A/B (`narrowbit-runtime`
 * vs `native`, one Hono task): native's 11 turns shared one session and were 96% cache reads;
 * the fresh-per-step design had zero cache reads across 9 turns, actually *worse* on fresh tokens
 * than native despite a much lower raw total. `sessionId`/`resume` let a caller keep one Claude
 * Code session alive across an entire task's turns — first call passes `sessionId` (fresh),
 * later calls pass the same id with `resume: true` and no `systemPrompt` (the CLI's
 * `--system-prompt-snapshot`, on by default, replays the first call's system prompt verbatim on
 * every resume, so it never needs resending) — so ordinary Anthropic prompt caching applies
 * across a task's steps the same way it does for native Claude Code.
 */
export interface ModelCallOptions {
  cwd: string;
  /** Ask an API provider for a pure JSON object reply (`response_format: json_object`). Ignored by the CLIs. */
  jsonObject?: boolean;
  /** Full system prompt override. Required on the first call of a session; omit on `resume` calls
   * — it would be ignored anyway (see session-persistence note above) and just wastes an argument. */
  systemPrompt?: string;
  prompt: string;
  model?: string;
  /** low | medium | high | xhigh | max. Passed straight through to `--effort`. */
  effort?: string;
  /** Usage-ledger attribution bucket, e.g. "planning" | "retrieval" | "execution" | "verification". */
  role: string;
  claudeBin?: string;
  timeoutMs?: number;
  /** Keep one Claude Code session alive across calls instead of a fresh one per call. Omit both
   * `sessionId`/`resume` for a one-off stateless call (uses `--no-session-persistence`, the
   * original behavior). Pass `sessionId` alone to start a resumable session; pass it again with
   * `resume: true` on later calls in the same task to continue it. */
  sessionId?: string;
  resume?: boolean;
  /** Absolute paths of attached images/PDFs, sent with this call only (the runtime passes them on the first call). */
  attachments?: string[];
  /** The reply as it is being written (Claude: `--include-partial-messages`), for a live display. Other providers ignore it. */
  onDelta?: (d: { text?: string; thinkingTokens?: number }) => void;
}

/**
 * Stall watchdog. About 1 Claude call in 37 (16 of 587 on 2026-10-06, history entry 53) produced no response at all and
 * sat until the 180 s timeout before the retry answered in seconds: on average that cost ~5 s per call, more than any
 * other per-turn delay. With partial messages on, a live call shows progress within seconds (the stream starts, thinking
 * is counted, text arrives), so silence for this long means a stuck call: it is ended and the runtime's retry asks again.
 * Start-up lines (system init, status, rate limits) don't count as progress.
 */
export function stallMs(): number {
  const v = Number(process.env.NARROWBIT_CLAUDE_STALL_MS);
  return Number.isFinite(v) && v > 0 ? v : 45_000;
}
export function isProgress(line: string): boolean {
  if (line.includes('"type":"stream_event"') || line.includes('"type":"assistant"') || line.includes('"type":"result"')) return true;
  return line.includes('"subtype":"thinking_tokens"');
}

/**
 * A reply stuck in a loop. Live traces (2026-10-06, history entry 55) showed what the earlier "stalls" were: the model
 * writing `<invoke name="grep">\n</invoke>` over and over (55,212 characters in 3 minutes) until the call timed out.
 * Before partial messages were streamed this looked like silence. A real reply here is one JSON object, so a long reply
 * whose last 40 lines hold at most three different lines is a loop: the call is ended and the runtime retries it.
 */
export function isRunaway(text: string): boolean {
  // The loops seen so far start with empty tool-call tags (`<invoke name="recall">\n</invoke>`), which no valid reply
  // contains (even well-formed native tool markup carries parameters): three of them end the call at once, ~1-2 s in
  // instead of after 3,000 characters (~12 s). History entry 59.
  if ((text.match(/<invoke name="[^"]*">\s*<\/invoke>/g) ?? []).length >= 3) return true;
  if (text.length < 3000) return false;
  const lines = text.slice(-6000).split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 40) return false;
  return new Set(lines.slice(-40)).size <= 3;
}
const RUNAWAY = "the model's reply ran away (the same lines repeated over and over)";

/** The live part of one stream-json line, if any: a piece of reply text, or the running thinking-token estimate. */
export function deltaOf(line: string): { text?: string; thinkingTokens?: number } | null {
  if (!line.includes("_delta") && !line.includes("thinking_tokens")) return null;
  try {
    const o = JSON.parse(line);
    if (o.type === "stream_event" && o.event?.type === "content_block_delta" && o.event.delta?.type === "text_delta") return { text: String(o.event.delta.text ?? "") };
    if (o.type === "system" && o.subtype === "thinking_tokens" && typeof o.estimated_tokens === "number") return { thinkingTokens: o.estimated_tokens };
  } catch {}
  return null;
}

export interface ModelCallResult {
  text: string;
  usage: { input: number; cacheCreate: number; cacheRead: number; output: number };
  /** Of `usage.output`, the part spent on hidden reasoning, when the provider reports it (DeepSeek, OpenAI-style APIs). */
  reasoningTokens?: number;
  costUsd: number | null;
  turns: number;
  isError: boolean;
  errorMessage?: string;
  /** True only for errors a retry cannot fix (not logged in). Any other isError — a timeout, a
   * killed process, no result event — is presumed transient and worth retrying; observed directly
   * in a 25-task batch run: 2 failures, both a bare "model call failed" with empty stderr (no
   * result event, most likely the default timeout under sustained load), not an auth problem. */
  fatal: boolean;
  /** Set only when the provider assigns its own session/thread id rather than accepting the
   * caller's requested `sessionId` (e.g. codex-cli.ts — `codex exec` always mints its own thread
   * id). The caller should adopt this for subsequent resume calls. Claude's own adapter never sets
   * this: `--session-id` already lets the caller pick the id, so what was requested is what was used. */
  sessionId?: string;
}

/**
 * One long-lived `claude` process per session, fed each turn as a stream-json message on stdin. Starting a new
 * process per turn and resuming the session cost 2.6-3.8 s of every turn (measured 2026-10-06, history entry 49):
 * about a third of a typical task's time. The process is reused while the model, effort and folder stay the same;
 * a model switch, a failure, a timeout, or the process ending on its own all fall back to starting a new one that
 * resumes the session, which is what every turn did before. Turn usage is reported per turn and the cost as a
 * running total for the session, as with separate processes.
 *
 * On by default (`NARROWBIT_CLAUDE_PERSIST=0` turns it off). Besides the start-up time it fixes prompt caching: a new
 * process that resumes the session reads only the system prompt from cache and writes the whole conversation again on
 * every turn, while one process reads its growing conversation from cache like Claude Code itself. Measured on 6 Hono
 * tasks (history entry 57): uncached tokens per call 2,293 → 919, cost for the six $0.907 → $0.357, task time 58 → 47 s,
 * 6/6 both. The "stalls" first blamed on this mode (entry 50) were runaway replies, now cut off (entry 55).
 * `NARROWBIT_CLAUDE_TRACE=<file>` records every message and line sent to and received from the process.
 */
interface LiveSession {
  child: ReturnType<typeof spawn>;
  key: string;
  lines: string[];
  partial: string;
  stderr: string;
  busy: boolean;
  dead: boolean;
  onLine?: (line: string) => void;
  onClose?: () => void;
  idle?: ReturnType<typeof setTimeout>;
}
const live = new Map<string, LiveSession>();
/** Debugging aid: NARROWBIT_CLAUDE_TRACE=<file> appends every message sent to and line received from a long-lived process. */
function trace(sessionId: string, dir: string, text: string): void {
  const f = process.env.NARROWBIT_CLAUDE_TRACE;
  if (!f) return;
  try {
    appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), session: sessionId.slice(0, 8), dir, text: text.slice(0, 400000) }) + "\n");
  } catch {}
}
const IDLE_MS = 5 * 60_000;
let exitHook = false;

function setRef(s: LiveSession, on: boolean): void {
  // While idle the process must not keep a finished `narrowbit agent` from exiting.
  for (const h of [s.child, s.child.stdout, s.child.stderr, s.child.stdin] as any[]) (on ? h?.ref : h?.unref)?.call(h);
}

/** Ends a session's process; the promise settles once it has exited (or after 3 s), so a successor can resume the session. */
function endSession(sessionId: string): Promise<void> {
  const s = live.get(sessionId);
  if (!s) return Promise.resolve();
  live.delete(sessionId);
  s.dead = true;
  if (s.idle) clearTimeout(s.idle);
  const exited = s.child.exitCode !== null || s.child.signalCode !== null;
  // Held (not unref'd) while waiting: an idle process is unref'd, and nothing else may be keeping the event loop alive.
  if (!exited) setRef(s, true);
  const done = exited ? Promise.resolve() : new Promise<void>((r) => {
    const t = setTimeout(r, 3000);
    s.child.once("close", () => {
      clearTimeout(t);
      r();
    });
  });
  try {
    s.child.stdin?.end();
    s.child.kill("SIGTERM");
  } catch {}
  return done;
}

/** Stops the long-lived process of a session (task finished, session replaced by compaction). Safe to call for any id. */
export function endClaudeSession(sessionId: string): Promise<void> {
  return endSession(sessionId);
}

function startLive(bin: string, args: string[], cwd: string, key: string, sessionId: string): LiveSession {
  const child = spawn(bin, args, { cwd, env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"] });
  const s: LiveSession = { child, key, lines: [], partial: "", stderr: "", busy: false, dead: false };
  child.stdin!.on("error", () => {});
  child.stdout!.on("data", (d: Buffer) => {
    const parts = (s.partial + d.toString("utf8")).split("\n");
    s.partial = parts.pop() ?? "";
    for (const line of parts) if (line.trim()) {
      trace(sessionId, "in", line);
      s.onLine?.(line);
    }
  });
  child.stderr!.on("data", (d: Buffer) => {
    trace(sessionId, "err", d.toString("utf8"));
    s.stderr = (s.stderr + d.toString("utf8")).slice(-4000);
  });
  trace(sessionId, "spawn", JSON.stringify(args.filter((a) => a.length < 200)));
  const gone = () => {
    trace(sessionId, "exit", `code ${child.exitCode} signal ${child.signalCode}`);
    if (s.partial.trim()) s.onLine?.(s.partial);
    s.partial = "";
    s.dead = true;
    if (live.get(sessionId) === s) live.delete(sessionId);
    if (s.idle) clearTimeout(s.idle);
    s.onClose?.();
  };
  child.on("close", gone);
  child.on("error", (e) => {
    s.stderr += String((e as Error).message ?? e);
    gone();
  });
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => {
      for (const id of [...live.keys()]) void endSession(id);
    });
  }
  return s;
}

async function persistentTurn(bin: string, args: string[], opts: ModelCallOptions, stdinMessage: string): Promise<ModelCallResult> {
  const sessionId = opts.sessionId!;
  const key = JSON.stringify([bin, opts.model ?? "sonnet", opts.effort ?? "", opts.cwd]);
  let s = live.get(sessionId);
  if (s && (s.dead || s.busy || s.key !== key)) {
    await endSession(sessionId);
    s = undefined;
  }
  const reused = !!s;
  if (!s) {
    s = startLive(bin, args, opts.cwd, key, sessionId);
    live.set(sessionId, s);
  }
  const first = await runTurn(s, sessionId, opts, stdinMessage);
  // A kept process that ended before answering (it crashed or quit between turns, and the exit hadn't been seen yet)
  // says nothing about the turn: run it once more on a fresh process that resumes the session.
  if (!(reused && first.endedSilently)) return first.result;
  await endSession(sessionId);
  const again = startLive(bin, args.map((a) => (a === "--session-id" ? "--resume" : a)), opts.cwd, key, sessionId);
  live.set(sessionId, again);
  return (await runTurn(again, sessionId, opts, stdinMessage)).result;
}

function runTurn(session: LiveSession, sessionId: string, opts: ModelCallOptions, stdinMessage: string): Promise<{ result: ModelCallResult; endedSilently: boolean }> {
  if (session.idle) clearTimeout(session.idle);
  setRef(session, true);
  session.busy = true;
  session.lines = [];
  session.stderr = "";
  return new Promise((resolve) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let stalled = "";
    const finish = (timedOut: boolean, closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      session.onLine = undefined;
      session.onClose = undefined;
      session.busy = false;
      const raw = session.lines.join("\n");
      const r = toResult(raw, session.stderr, stalled || (timedOut && !raw.includes('"type":"result"') ? "the model call timed out" : ""));
      // Anything but a clean turn: start over next time, resuming the session from disk.
      if (r.isError || session.dead) void endSession(sessionId);
      else {
        setRef(session, false);
        session.idle = setTimeout(() => endSession(sessionId), IDLE_MS);
        session.idle.unref?.();
      }
      resolve({ result: r, endedSilently: closed && !raw.trim() });
    };
    const timer = setTimeout(() => finish(true, false), opts.timeoutMs ?? 180_000);
    const quiet = stallMs();
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        stalled = `the model call stalled: no response for ${Math.round(quiet / 1000)} s`;
        finish(true, false);
      }, quiet);
    };
    arm();
    let reply = "";
    session.onLine = (line) => {
      if (isProgress(line)) arm();
      const d = deltaOf(line);
      if (d) {
        try {
          opts.onDelta?.(d);
        } catch {}
        if (d.text && (reply += d.text) && isRunaway(reply)) {
          stalled = RUNAWAY;
          finish(true, false);
        }
        return; // a partial chunk; the full message follows in its own event
      }
      session.lines.push(line);
      if (line.includes('"type":"result"')) {
        try {
          if (JSON.parse(line).type === "result") finish(false, false);
        } catch {}
      }
    };
    session.onClose = () => finish(false, true);
    trace(sessionId, "out", stdinMessage);
    session.child.stdin!.write(stdinMessage, () => {});
  });
}

function toResult(raw: string, stderr: string, note: string): ModelCallResult {
  const s = parseStream(raw);
  // Every call reports the subscription's 5-hour/weekly usage; keep the latest for `narrowbit limits` and the app.
  recordClaudeLimits(raw);
  const loggedOut = /"error":"authentication_failed"|Not logged in|Invalid API key/.test(raw + stderr);
  const detail = (stderr.trim() || s.errorText.trim() || note).slice(0, 500);
  // A usage limit or sign-in problem can't be fixed by retrying the same call.
  const fatal = loggedOut || (s.isError && isPermanentModelError(detail));
  return {
    text: extractText(raw),
    usage: s.usage,
    costUsd: s.costUsd,
    turns: s.turns,
    isError: s.isError || loggedOut,
    errorMessage: loggedOut ? "claude CLI is not logged in to your subscription (run `claude` then /login)" : s.isError ? detail || undefined : undefined,
    fatal,
  };
}

/**
 * The environment for the `claude` processes Narrowbit starts: the user's own, minus the markers Claude Code sets for
 * the sessions it hosts. Run from inside Claude Code (its desktop app or terminal), `CLAUDE_CODE_ENTRYPOINT=claude-desktop`
 * and friends were inherited, and every call then also wrote a background turn summary for the desktop app before
 * its result: +1.1-1.2 s per turn (measured 2026-10-06, history entry 52). Sign-in variables are left alone.
 */
const HOST_MARKERS = ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDECODE", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_EAGER_FLUSH", "CLAUDE_CODE_TERMINAL_MCP_TOOLS", "CLAUDE_CODE_REPORT_FINDINGS", "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES", "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "CLAUDE_CODE_SSE_PORT"];
export function claudeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of HOST_MARKERS) delete env[k];
  return env;
}

export function callModel(opts: ModelCallOptions): Promise<ModelCallResult> {
  const bin = opts.claudeBin ?? process.env.NARROWBIT_CLAUDE ?? "claude";
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--safe-mode"];
  if (opts.sessionId && opts.resume) args.push("--resume", opts.sessionId);
  else if (opts.sessionId) args.push("--session-id", opts.sessionId);
  else args.push("--no-session-persistence");
  if (opts.systemPrompt !== undefined) args.push("--system-prompt", opts.systemPrompt);
  if (opts.effort) args.push("--effort", opts.effort);
  args.push(
    "--model",
    opts.model ?? "sonnet",
    "--tools",
    "", // no built-in tools: this call is a pure text turn, Narrowbit executes every action itself
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
  );
  // Partial messages carry the reply as it is written; only asked for when someone is watching.
  // Always streamed: the pieces show progress, which the stall watchdog needs even when nobody is watching the text.
  args.push("--include-partial-messages");
  // Attachments go as content blocks in a stream-json user message on stdin (a plain prompt argument is text only).
  const files = (opts.attachments ?? []).map(readAttachment).filter((f): f is NonNullable<ReturnType<typeof readAttachment>> => !!f);
  if (opts.sessionId && process.env.NARROWBIT_CLAUDE_PERSIST !== "0") {
    args.push("--input-format", "stream-json");
    const content = files.length
      ? [...files.map((f) => ({ type: f.kind === "pdf" ? "document" : "image", source: { type: "base64", media_type: f.mime, data: f.base64 } })), { type: "text", text: opts.prompt }]
      : opts.prompt;
    return persistentTurn(bin, args, opts, JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  }
  let stdinMessage: string | undefined;
  if (files.length) {
    args.push("--input-format", "stream-json");
    const content = [
      ...files.map((f) => ({ type: f.kind === "pdf" ? "document" : "image", source: { type: "base64", media_type: f.mime, data: f.base64 } })),
      { type: "text", text: opts.prompt },
    ];
    stdinMessage = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
  } else args.push("--", opts.prompt);
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    child.stdin.end(stdinMessage);
    const lines: string[] = [];
    let stderr = "";
    let partial = "";
    let settled = false;
    const settle = (r: ModelCallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      resolve(r);
    };
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const quiet = stallMs();
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        settle(toResult(lines.join("\n"), stderr, `the model call stalled: no response for ${Math.round(quiet / 1000)} s`));
        child.kill("SIGTERM");
      }, quiet);
    };
    let reply = "";
    const take = (line: string) => {
      if (!line.trim()) return;
      if (isProgress(line)) arm();
      const delta = deltaOf(line);
      if (delta) {
        try {
          opts.onDelta?.(delta);
        } catch {}
        if (delta.text && (reply += delta.text) && isRunaway(reply)) {
          settle(toResult(lines.join("\n"), stderr, RUNAWAY));
          child.kill("SIGTERM");
        }
        return;
      }
      lines.push(line);
      // The answer is complete at the result line; the process takes about another second to exit, and nothing
      // after the result changes the answer, so don't wait for it (measured 0.8-1.0 s per turn, history entry 52).
      if (line.includes('"type":"result"')) {
        try {
          if (JSON.parse(line).type === "result") settle(toResult(lines.join("\n"), stderr, ""));
        } catch {}
      }
    };
    child.stdout.on("data", (d: Buffer) => {
      const parts = (partial + d.toString("utf8")).split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts) take(line);
    });
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 180_000);
    arm();
    child.on("close", () => {
      take(partial);
      partial = "";
      settle(toResult(lines.join("\n"), stderr, ""));
    });
    child.on("error", (e) => resolve({ text: "", usage: { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 }, costUsd: null, turns: 0, isError: true, errorMessage: String((e as Error).message ?? e), fatal: false }));
  });
}
