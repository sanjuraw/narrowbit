import { spawn } from "node:child_process";
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
  // Attachments go as content blocks in a stream-json user message on stdin (a plain prompt argument is text only).
  const files = (opts.attachments ?? []).map(readAttachment).filter((f): f is NonNullable<ReturnType<typeof readAttachment>> => !!f);
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
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 180_000);
    child.on("close", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const s = parseStream(raw);
      // Every call reports the subscription's 5-hour/weekly usage; keep the latest for `narrowbit limits` and the app.
      recordClaudeLimits(raw);
      const loggedOut = /"error":"authentication_failed"|Not logged in|Invalid API key/.test(raw + stderr);
      const detail = (stderr.trim() || s.errorText.trim()).slice(0, 500);
      // A usage limit or sign-in problem can't be fixed by retrying the same call.
      const fatal = loggedOut || (s.isError && isPermanentModelError(detail));
      resolve({
        text: extractText(raw),
        usage: s.usage,
        costUsd: s.costUsd,
        turns: s.turns,
        isError: s.isError || loggedOut,
        errorMessage: loggedOut ? "claude CLI is not logged in to your subscription (run `claude` then /login)" : s.isError ? detail || undefined : undefined,
        fatal,
      });
    });
    child.on("error", (e) => resolve({ text: "", usage: { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 }, costUsd: null, turns: 0, isError: true, errorMessage: String((e as Error).message ?? e), fatal: false }));
  });
}
