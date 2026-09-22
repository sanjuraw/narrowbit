import { spawn } from "node:child_process";
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
 */
export interface ModelCallOptions {
  cwd: string;
  /** Full system prompt override (context.ts's project() output) — not appended to Claude Code's default. */
  systemPrompt: string;
  prompt: string;
  model?: string;
  /** Usage-ledger attribution bucket, e.g. "planning" | "retrieval" | "execution" | "verification". */
  role: string;
  claudeBin?: string;
  timeoutMs?: number;
}

export interface ModelCallResult {
  text: string;
  usage: { input: number; cacheCreate: number; cacheRead: number; output: number };
  costUsd: number | null;
  turns: number;
  isError: boolean;
  errorMessage?: string;
}

export function callModel(opts: ModelCallOptions): Promise<ModelCallResult> {
  const bin = opts.claudeBin ?? process.env.NARROWBIT_CLAUDE ?? "claude";
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--safe-mode", // disable Claude Code's own CLAUDE.md/skills/memory auto-load — see file header
    "--system-prompt",
    opts.systemPrompt,
    "--model",
    opts.model ?? "sonnet",
    "--tools",
    "", // no built-in tools: this call is a pure text turn, Narrowbit executes every action itself
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--",
    opts.prompt,
  ];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 120_000);
    child.on("close", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const s = parseStream(raw);
      const fatal = /"error":"authentication_failed"|Not logged in|Invalid API key/.test(raw + stderr);
      resolve({
        text: extractText(raw),
        usage: s.usage,
        costUsd: s.costUsd,
        turns: s.turns,
        isError: s.isError || fatal,
        errorMessage: fatal ? "claude CLI is not logged in to your subscription (run `claude` then /login)" : s.isError ? stderr.trim().slice(0, 500) || undefined : undefined,
      });
    });
    child.on("error", (e) => resolve({ text: "", usage: { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 }, costUsd: null, turns: 0, isError: true, errorMessage: String((e as Error).message ?? e) }));
  });
}
