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
 * Off by default, on with `NARROWBIT_CLAUDE_PERSIST=1`. In real agent runs on Hono (2026-10-06, history entry 50) about
 * one turn in twelve stalled: the process acknowledged the message (`system/init`) and then sent nothing until the
 * 180 s timeout, while a fresh process answered the same message in seconds. Replaying the captured messages outside
 * the agent never stalled. Until the cause is found the stalls cost more than the ~1-1.5 s per turn this saves.
 * `NARROWBIT_CLAUDE_TRACE=<file>` records every message and line to help find it.
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
  const child = spawn(bin, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
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
    const finish = (timedOut: boolean, closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.onLine = undefined;
      session.onClose = undefined;
      session.busy = false;
      const raw = session.lines.join("\n");
      const r = toResult(raw, session.stderr, timedOut && !raw.includes('"type":"result"') ? "the model call timed out" : "");
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
    session.onLine = (line) => {
      const d = opts.onDelta && deltaOf(line);
      if (d) {
        try {
          opts.onDelta!(d);
        } catch {}
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
  if (opts.onDelta) args.push("--include-partial-messages");
  // Attachments go as content blocks in a stream-json user message on stdin (a plain prompt argument is text only).
  const files = (opts.attachments ?? []).map(readAttachment).filter((f): f is NonNullable<ReturnType<typeof readAttachment>> => !!f);
  if (opts.sessionId && process.env.NARROWBIT_CLAUDE_PERSIST === "1") {
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
    const child = spawn(bin, args, { cwd: opts.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    child.stdin.end(stdinMessage);
    const chunks: Buffer[] = [];
    let stderr = "";
    let partial = "";
    child.stdout.on("data", (d: Buffer) => {
      chunks.push(d);
      if (!opts.onDelta) return;
      const parts = (partial + d.toString("utf8")).split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts) {
        const delta = deltaOf(line);
        if (delta) {
          try {
            opts.onDelta(delta);
          } catch {}
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 180_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(toResult(Buffer.concat(chunks).toString("utf8"), stderr, ""));
    });
    child.on("error", (e) => resolve({ text: "", usage: { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 }, costUsd: null, turns: 0, isError: true, errorMessage: String((e as Error).message ?? e), fatal: false }));
  });
}
