import { spawn } from "node:child_process";
import type { ModelCallOptions, ModelCallResult } from "./claude-cli.js";

/**
 * Model adapter for the owned runtime, backed by the `codex` CLI under the user's ChatGPT
 * subscription (`codex exec`, not the OpenAI API). Mirrors providers/claude-cli.ts's contract:
 * every call should be one stateless, tool-free turn, with Narrowbit's own runtime deciding and
 * executing every action.
 *
 * Unlike Claude Code, `codex exec` has no documented flag to fully disable its own tool-calling
 * (no equivalent of Claude's `--tools ""`) — probed directly via `--strict-config` against several
 * plausible -c keys (tools.shell.enabled, shell_tool_enabled, disable_tools, include_apply_patch_tool,
 * include_plan_tool, tools_web_search — all rejected as unknown fields). The safety net used instead
 * is `-s read-only`: Codex can still attempt a tool call, but nothing it does through one can write
 * or execute destructively — a sandboxed attempt just wastes a turn rather than causing harm. The
 * system prompt also explicitly tells it this is a text-only interface. This is a real gap versus
 * the Claude adapter's hard guarantee, not a design choice; note it if this needs tightening later.
 *
 * Session persistence: `codex exec` assigns its own thread id (there is no equivalent of passing a
 * caller-chosen `--session-id` the way Claude Code allows) — the first call's `thread.started` event
 * carries it, returned here as `ModelCallResult.sessionId` for the caller to adopt for later
 * `codex exec resume <id>` calls. `--effort` has no direct flag either; `-c
 * model_reasoning_effort=<level>` is the config override (confirmed valid, not fabricated, via
 * `--strict-config`: an intentionally-wrong key name was rejected while this one was accepted).
 *
 * UNVERIFIED end to end as of writing: this machine has no `codex login` session, so the exact
 * shape of a *successful* turn's JSONL (the assistant text event's field names, usage/token-count
 * event) could only be inferred, not observed — only the error path (`turn.failed`) and the
 * pre-auth events (`thread.started`, `turn.started`) were seen directly. parseCodexStream() below is
 * deliberately lenient (tries several plausible field names) for exactly that reason. Needs a live
 * task once logged in before this is trusted the way the Claude adapter is.
 */
export function callCodex(opts: ModelCallOptions): Promise<ModelCallResult> {
  const bin = process.env.NARROWBIT_CODEX ?? "codex";
  const modelFlags: string[] = [];
  if (opts.model) modelFlags.push("-m", opts.model);
  if (opts.effort) modelFlags.push("-c", `model_reasoning_effort=${opts.effort}`);

  let args: string[];
  if (opts.sessionId && opts.resume) {
    args = ["exec", "resume", opts.sessionId, opts.prompt, "--json", "--skip-git-repo-check", ...modelFlags];
  } else {
    const promptText = opts.systemPrompt !== undefined ? `${opts.systemPrompt}\n\n${opts.prompt}` : opts.prompt;
    args = ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", ...modelFlags, promptText];
  }

  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 180_000);
    child.on("close", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed = parseCodexStream(raw);
      const authFailed = /401 Unauthorized|Not logged in|not authenticated/i.test(raw + stderr);
      resolve({
        text: parsed.text,
        usage: parsed.usage,
        costUsd: null, // ChatGPT subscription usage has no reported per-call dollar figure, unlike Claude Code's costUsd
        turns: 1,
        isError: parsed.isError || authFailed,
        errorMessage: authFailed ? "codex CLI is not logged in to your ChatGPT subscription (run `codex login`)" : parsed.errorMessage,
        fatal: authFailed,
        sessionId: parsed.sessionId,
      });
    });
    child.on("error", (e) => resolve({ text: "", usage: { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 }, costUsd: null, turns: 0, isError: true, errorMessage: String((e as Error).message ?? e), fatal: false }));
  });
}

interface ParsedCodexStream {
  text: string;
  usage: { input: number; cacheCreate: number; cacheRead: number; output: number };
  isError: boolean;
  errorMessage?: string;
  sessionId?: string;
}

/** Parses `codex exec --json`'s JSONL event stream. Deliberately lenient about field names — see
 * the file-level comment on what's confirmed vs. inferred. */
export function parseCodexStream(raw: string): ParsedCodexStream {
  let sessionId: string | undefined;
  let text = "";
  let isError = false;
  let errorMessage: string | undefined;
  const usage = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let e: any;
    try {
      e = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof e.thread_id === "string") sessionId = e.thread_id;
    if (e.type === "item.completed" && e.item) {
      const kind = String(e.item.type ?? "");
      if (kind === "agent_message" || kind === "assistant_message" || kind === "message") {
        const t = e.item.text ?? e.item.content ?? e.item.message;
        if (typeof t === "string" && t.trim()) text = t;
      } else if (kind === "error") {
        isError = true;
        errorMessage = String(e.item.message ?? "codex reported an error").slice(0, 500);
      }
    }
    if (e.type === "turn.failed") {
      isError = true;
      errorMessage = String(e.error?.message ?? "codex turn failed").slice(0, 500);
    }
    if (e.type === "error" && !text) {
      // A reconnect/transport warning, not necessarily fatal on its own — only treated as the
      // failure if no successful text ever arrived and no turn.failed already set a clearer message.
      errorMessage = errorMessage ?? String(e.message ?? "codex error").slice(0, 500);
    }
    // Usage: tried under a few plausible names since the real shape is unconfirmed (see file header).
    const u = e.usage ?? (e.type === "turn.completed" ? e.token_usage ?? e.tokens : undefined);
    if (u && typeof u === "object") {
      usage.input = Number(u.input_tokens ?? u.input ?? usage.input) || usage.input;
      usage.output = Number(u.output_tokens ?? u.output ?? usage.output) || usage.output;
      usage.cacheRead = Number(u.cached_input_tokens ?? u.cache_read_input_tokens ?? usage.cacheRead) || usage.cacheRead;
    }
  }
  if (!text && !isError) {
    isError = true;
    errorMessage = errorMessage ?? "codex produced no output";
  }
  return { text, usage, isError, errorMessage, sessionId };
}
