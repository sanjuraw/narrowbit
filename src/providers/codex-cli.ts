import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
/**
 * Codex features that add tool definitions (and their instructions) to every request. Narrowbit executes every action
 * itself, so the model needs none of them — the Codex equivalent of Claude's `--tools ""`. Measured on codex-cli
 * 0.156 with gpt-6-luna: a one-word reply cost 13.5k input tokens by default, 6.8k with these off and Codex's base
 * instructions replaced by ours. Unknown feature names (older/newer CLIs) are ignored without --strict-config.
 * Not `code_mode_host`: with it off, gpt-6 models end every real task with "Code Mode is unavailable… will fail closed".
 */
const LEAN_OFF = ["apps", "browser_use", "browser_use_external", "computer_use", "goals", "image_generation", "multi_agent", "plugins", "remote_plugin", "shell_tool", "skill_search", "sleep_tool", "tool_suggest", "view_image", "unified_exec", "workspace_dependencies", "worktrees", "in_app_browser", "hooks", "skill_mcp_dependency_install"];

/** Our instructions file per Codex thread, so resumed calls keep the same replacement for Codex's base instructions. */
const instructionsFor = new Map<string, string>();
/** `codex exec resume` reports usage for the whole thread so far, not for the call: remember the last totals per thread. */
const lastTotals = new Map<string, { input: number; cached: number; output: number; reasoning: number }>();

function instructionsFile(text: string): string {
  const dir = join(tmpdir(), "narrowbit-codex");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, `${createHash("sha1").update(text).digest("hex").slice(0, 16)}.md`);
  if (!existsSync(f)) writeFileSync(f, text, { mode: 0o600 });
  return f;
}

export function callCodex(opts: ModelCallOptions): Promise<ModelCallResult> {
  const bin = process.env.NARROWBIT_CODEX ?? "codex";
  const modelFlags: string[] = [];
  if (opts.model) modelFlags.push("-m", opts.model);
  if (opts.effort) modelFlags.push("-c", `model_reasoning_effort=${opts.effort}`);
  const lean = process.env.NARROWBIT_CODEX_LEAN !== "0";
  if (lean) for (const f of LEAN_OFF) modelFlags.push("-c", `features.${f}=false`);

  let args: string[];
  let instr: string | undefined;
  if (opts.sessionId && opts.resume) {
    instr = instructionsFor.get(opts.sessionId);
    if (lean && instr) modelFlags.push("-c", `model_instructions_file=${JSON.stringify(instr)}`);
    args = ["exec", "resume", opts.sessionId, opts.prompt, "--json", "--skip-git-repo-check", ...modelFlags];
  } else if (lean && opts.systemPrompt !== undefined) {
    instr = instructionsFile(opts.systemPrompt);
    // Lean mode has Codex's own shell and file tools switched off, so its sandbox grants it nothing — but the model reads
    // the sandbox policy and, told "read-only", refused to make the edit (7 of 40 Hono tasks ended "blocked: the workspace
    // is mounted read-only"). Narrowbit applies every edit itself; say the workspace is writable so the model plans edits.
    args = ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", ...modelFlags, "-c", `model_instructions_file=${JSON.stringify(instr)}`, opts.prompt];
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
      const thread = parsed.sessionId ?? opts.sessionId;
      if (thread && instr) instructionsFor.set(thread, instr);
      // Turn the thread's running totals into this call's own usage. A thread we haven't seen in this process (a
      // follow-up after a restart) can't be split, so its first call is counted whole — an overcount, never an under.
      const tot = parsed.totals;
      const prev = thread && opts.resume ? lastTotals.get(thread) : undefined;
      if (thread && tot) lastTotals.set(thread, tot);
      const d = tot ? { input: tot.input - (prev?.input ?? 0), cached: tot.cached - (prev?.cached ?? 0), output: tot.output - (prev?.output ?? 0), reasoning: tot.reasoning - (prev?.reasoning ?? 0) } : null;
      const usage = d ? { input: Math.max(0, d.input - d.cached), cacheCreate: 0, cacheRead: Math.max(0, d.cached), output: Math.max(0, d.output) } : parsed.usage;
      const authFailed = /401 Unauthorized|Not logged in|not authenticated/i.test(raw + stderr);
      resolve({
        text: parsed.text,
        usage,
        reasoningTokens: d && d.reasoning > 0 ? d.reasoning : undefined,
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
  totals?: { input: number; cached: number; output: number; reasoning: number };
}

/** Parses `codex exec --json`'s JSONL event stream. Deliberately lenient about field names — see
 * the file-level comment on what's confirmed vs. inferred. */
export function parseCodexStream(raw: string): ParsedCodexStream {
  let sessionId: string | undefined;
  let text = "";
  let isError = false;
  let errorMessage: string | undefined;
  const usage = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
  let totals: { input: number; cached: number; output: number; reasoning: number } | undefined;

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
      // Codex's input_tokens already include the cached ones (OpenAI semantics); these are the raw thread totals.
      totals = { input: usage.input, cached: usage.cacheRead, output: usage.output, reasoning: Number(u.reasoning_output_tokens ?? 0) || 0 };
    }
  }
  if (!text && !isError) {
    isError = true;
    errorMessage = errorMessage ?? "codex produced no output";
  }
  return { text, usage, isError, errorMessage, sessionId, totals };
}
