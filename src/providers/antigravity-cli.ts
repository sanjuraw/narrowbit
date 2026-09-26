import { spawn } from "node:child_process";
import type { ModelCallOptions, ModelCallResult } from "./claude-cli.js";
import { promptWithFiles } from "../attachments.js";

/**
 * Model adapter backed by Google's Antigravity CLI (`agy`, signed in with a Google account), the same role
 * codex-cli.ts fills for ChatGPT. One call = one `agy -p` turn; Narrowbit's runtime executes every action.
 *
 * Measured on agy 1.2.11: it has no flag to switch its own tools off (~55 tool definitions cost ~12k input tokens
 * per call) and no system-prompt flag, so our instructions are prepended to the first prompt and `--mode plan` keeps
 * it from acting on its own; told to answer with JSON only, it did not use a tool. `--conversation <id>` resumes, and
 * the usage in a resumed call's result is the running total for the conversation, so per-call usage is the difference.
 */
const lastTotals = new Map<string, { input: number; output: number; thinking: number; cached: number }>();

export function callAntigravity(opts: ModelCallOptions): Promise<ModelCallResult> {
  const bin = process.env.NARROWBIT_AGY ?? `${process.env.HOME ?? ""}/.local/bin/agy`;
  // agy has no image flag (its stream-json input refuses a prompt argument, which -p requires), so images are not sent.
  const prompt = promptWithFiles(opts.prompt, opts.attachments, { images: false, pdfs: false });
  const args = ["-p", opts.resume && opts.sessionId ? prompt : opts.systemPrompt !== undefined ? `${opts.systemPrompt}\n\n${prompt}` : prompt, "--output-format", "stream-json", "--mode", "plan"];
  if (opts.resume && opts.sessionId) args.push("--conversation", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
  // Model ids already end in -low/-medium/-high for the Gemini family; --effort is for the ones that don't.
  if (opts.effort && opts.model && !/-(low|medium|high)$/.test(opts.model)) args.push("--effort", opts.effort);
  const timeoutMs = opts.timeoutMs ?? 180_000;

  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const p = parseAgyStream(raw);
      const authFailed = /Authentication required|Please sign in|authentication failed/i.test(raw + stderr);
      const id = p.sessionId ?? opts.sessionId;
      const prev = id && opts.resume ? lastTotals.get(id) : undefined;
      if (id && p.totals) lastTotals.set(id, p.totals);
      const t = p.totals;
      const d = t ? { input: t.input - (prev?.input ?? 0), output: t.output - (prev?.output ?? 0), thinking: t.thinking - (prev?.thinking ?? 0), cached: t.cached - (prev?.cached ?? 0) } : null;
      const usage = d ? { input: Math.max(0, d.input), cacheCreate: 0, cacheRead: Math.max(0, d.cached), output: Math.max(0, d.output) } : { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
      resolve({
        text: p.text,
        usage,
        reasoningTokens: d && d.thinking > 0 ? d.thinking : undefined,
        costUsd: null,
        turns: 1,
        isError: p.isError || authFailed || (!p.text && !p.isError),
        errorMessage: authFailed ? "Antigravity CLI is not signed in (run `agy` once in a terminal and sign in)" : (p.errorMessage ?? (p.text ? undefined : (stderr.trim().slice(0, 300) || "agy produced no output"))),
        fatal: authFailed,
        sessionId: p.sessionId,
      });
    });
    child.on("error", (e) => resolve({ text: "", usage: { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 }, costUsd: null, turns: 0, isError: true, errorMessage: String((e as Error).message ?? e), fatal: (e as any).code === "ENOENT" }));
  });
}

export function parseAgyStream(raw: string): { text: string; sessionId?: string; isError: boolean; errorMessage?: string; totals?: { input: number; output: number; thinking: number; cached: number } } {
  let text = "";
  let sessionId: string | undefined;
  let isError = false;
  let errorMessage: string | undefined;
  let totals: { input: number; output: number; thinking: number; cached: number } | undefined;
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    let e: any;
    try {
      e = JSON.parse(s);
    } catch {
      continue;
    }
    if (e.event === "init" && e.conversation_id) sessionId = e.conversation_id;
    if (e.event === "result" && e.result) {
      const r = e.result;
      if (r.conversation_id) sessionId = r.conversation_id;
      if (typeof r.response === "string") text = r.response.trim();
      if (r.status && r.status !== "SUCCESS") {
        isError = true;
        errorMessage = String(r.error ?? r.status).slice(0, 500);
      }
      const u = r.usage;
      if (u) totals = { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, thinking: Number(u.thinking_tokens) || 0, cached: Number(u.cache_read_tokens) || 0 };
    }
  }
  return { text, sessionId, isError, errorMessage, totals };
}
