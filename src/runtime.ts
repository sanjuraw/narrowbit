import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { loadConfig, type Paths } from "./config.js";
import { runCommand } from "./compress.js";
import { writeEvidence } from "./evidence.js";
import { appendEvent } from "./events.js";
import { indexRepo, openStore } from "./indexer.js";
import { callModel } from "./providers/claude-cli.js";
import { readLines } from "./package.js";
import { grepText, searchText } from "./query.js";
import { estimateTokens, shortId } from "./util.js";
import { verify } from "./verify.js";

/**
 * Stage 2 milestone (CLAUDE.md "Handoff"): the smallest owned agent loop. One tool per step
 * (read/grep/search/edit/run/verify), no planning sophistication yet.
 *
 * One Claude Code session is kept alive for the whole task (`sessionId`/`resume` in
 * providers/claude-cli.ts), not a fresh session per step: a bench.ts A/B on a real Hono task
 * showed a fresh-per-step design paying full, uncached price on every turn — worse on fresh
 * tokens than plain native Claude Code, which caches heavily across its own turns within one
 * session. Resuming lets ordinary Anthropic prompt caching apply the same way. The static
 * SYSTEM_INSTRUCTIONS are sent once (turn 0); each later turn's prompt is just that step's
 * actual, capped tool result — the model sees its own prior turns natively via the resumed
 * conversation, so there is no need to re-derive and resend a state summary every turn.
 * events.ts/evidence.ts still log every call and action for the usage ledger and for evidence
 * handles, independent of what the model itself remembers in-session.
 */

const SYSTEM_INSTRUCTIONS = `You are driving a coding task through a tool-free reasoning interface. You cannot run tools yourself — instead, on every turn, respond with EXACTLY ONE JSON object (no markdown fences, no prose outside the JSON) describing the next action for the runtime to take on your behalf:

{"action":"read","path":"<repo-relative path>","start"?:<line>,"end"?:<line>}
{"action":"grep","pattern":"<text>","glob"?:"<pathspec>"}
{"action":"search","query":"<text>"}
{"action":"edit","path":"<repo-relative path>","old":"<exact existing text to replace, or \"\" only to create a new file>","new":"<replacement text>"}
{"action":"run","command":"<shell command>"}
{"action":"verify"}
{"action":"done","summary":"<what changed and why it satisfies the task>"}
{"action":"blocked","reason":"<what you need that you don't have>"}

Read before you edit. "old" must match the file's current text EXACTLY (including whitespace) and must appear
exactly once — copy it verbatim from what you last read, quoting only as much surrounding context as needed to
make it unique. Never restate the whole file: "old"/"new" should cover only the lines that actually change. If a
previous edit is rejected, re-read the file before retrying — do not guess at the current content.
Verify after you edit. Do not edit files the task tells you not to modify. Prefer the smallest edit that satisfies the task.`;

interface Decision {
  action: string;
  path?: string;
  start?: number;
  end?: number;
  old?: string;
  new?: string;
  pattern?: string;
  glob?: string;
  query?: string;
  command?: string;
  summary?: string;
  reason?: string;
}

export function parseDecision(text: string): Decision | null {
  const trimmed = text.trim();
  const candidate = trimmed.startsWith("{") ? trimmed : (/\{[\s\S]*\}/.exec(trimmed)?.[0] ?? null);
  if (!candidate) return null;
  try {
    const d = JSON.parse(candidate);
    return typeof d.action === "string" ? d : null;
  } catch {
    return null;
  }
}

/** Cap what re-enters context directly; anything longer is still fully available via the evidence handle. */
export function capSummary(text: string, capTokens = 800): string {
  if (estimateTokens(text) <= capTokens) return text;
  return text.slice(0, Math.floor(capTokens * 3.6)) + "\n… (truncated here; ask again with a narrower range/query if you need more)";
}

/** Refuse any path that would escape the repo root. */
export function safeAbsPath(p: Paths, path: string): string | null {
  const abs = resolve(p.root, path);
  const rel = relative(p.root, abs);
  return rel.startsWith("..") || resolve(p.root) === abs ? null : abs;
}

export interface RuntimeOptions {
  maxSteps?: number;
  budget?: number;
  model?: string;
  claudeBin?: string;
  role?: string;
}

export interface RuntimeResult {
  taskId: string;
  outcome: "done" | "blocked" | "max_steps" | "error";
  summary: string;
  steps: number;
  /** Count of executed actions by name (read/grep/search/edit/run/verify) — every one is Narrowbit's own, not Claude Code's. */
  actionCounts: Record<string, number>;
}

const MAX_PARSE_RETRIES = 3;

export async function runTask(p: Paths, taskText: string, opts: RuntimeOptions = {}): Promise<RuntimeResult> {
  const taskId = `rt-${shortId()}`;
  const store = openStore(p);
  indexRepo(p, store);
  const maxSteps = opts.maxSteps ?? 20;
  const role = opts.role ?? "execution";
  const model = opts.model ?? "sonnet";
  const sessionId = randomUUID();

  appendEvent(p, taskId, { actor: "user", type: "decision", summary: "task received", meta: { goal: taskText } });

  let outcome: RuntimeResult["outcome"] = "max_steps";
  let summary = "";
  let steps = 0;
  let parseRetries = 0;
  const actionCounts: Record<string, number> = {};
  // First call carries the static instructions + the task; every later call is just that step's
  // result, since the resumed session already has the rest of the conversation natively.
  let nextPrompt = `${SYSTEM_INSTRUCTIONS}\n\nTask: ${taskText}\n\nRespond with your first action as JSON.`;
  let nextSystemPrompt: string | undefined = undefined;

  for (; steps < maxSteps; steps++) {
    const res = await callModel({
      cwd: p.root,
      systemPrompt: nextSystemPrompt,
      prompt: nextPrompt,
      model,
      role,
      claudeBin: opts.claudeBin,
      sessionId,
      resume: steps > 0,
    });
    nextSystemPrompt = undefined; // only the first call ever sends one — see providers/claude-cli.ts
    appendEvent(p, taskId, {
      actor: "model",
      type: "model_call",
      summary: res.isError ? `step ${steps}: model call failed` : `step ${steps}: ${res.text.slice(0, 120)}`,
      tokens: {
        model,
        role,
        inputTokens: res.usage.input,
        cacheCreationTokens: res.usage.cacheCreate,
        cacheReadTokens: res.usage.cacheRead,
        outputTokens: res.usage.output,
        costUsd: res.costUsd ?? 0,
      },
    });
    if (res.isError) {
      appendEvent(p, taskId, { actor: "system", type: "blocker", summary: `model call failed: ${res.errorMessage ?? "unknown error"}` });
      outcome = "error";
      summary = res.errorMessage ?? "model call failed";
      break;
    }

    const decision = parseDecision(res.text);
    if (!decision) {
      parseRetries++;
      appendEvent(p, taskId, { actor: "system", type: "blocker", summary: `could not parse a JSON action from the model's response (attempt ${parseRetries}/${MAX_PARSE_RETRIES}): ${res.text.slice(0, 200)}` });
      if (parseRetries >= MAX_PARSE_RETRIES) {
        outcome = "error";
        summary = "unparseable model response";
        break;
      }
      nextPrompt = "Your last response was not valid JSON. Respond with EXACTLY one JSON object as instructed, nothing else — no prose, no markdown fences.";
      continue;
    }
    parseRetries = 0;

    if (decision.action === "done") {
      outcome = "done";
      summary = decision.summary ?? "done";
      appendEvent(p, taskId, { actor: "model", type: "decision", summary: `done: ${summary}` });
      break;
    }
    if (decision.action === "blocked") {
      outcome = "blocked";
      summary = decision.reason ?? "blocked";
      appendEvent(p, taskId, { actor: "model", type: "blocker", summary });
      break;
    }

    actionCounts[decision.action] = (actionCounts[decision.action] ?? 0) + 1;
    try {
      const resultText = await executeAction(p, taskId, decision);
      nextPrompt = `${resultText}\n\nWhat is the next action? Respond with JSON only.`;
    } catch (e: any) {
      const errText = `error: ${String(e?.message ?? e).slice(0, 300)}`;
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: errText });
      nextPrompt = `${errText}\n\nWhat is the next action? Respond with JSON only.`;
    }
  }

  store.close();
  return { taskId, outcome, summary, steps, actionCounts };
}

/** Executes one action and returns the (capped) result text to feed back as the next turn's prompt. */
async function executeAction(p: Paths, taskId: string, d: Decision): Promise<string> {
  switch (d.action) {
    case "read": {
      const path = String(d.path ?? "");
      const abs = safeAbsPath(p, path);
      if (!abs || !existsSync(abs)) {
        const text = `read ${path}: file not found`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, meta: { path } });
        return text;
      }
      const lines = readFileSync(abs, "utf8").split("\n").length;
      const start = d.start ?? 1;
      const end = d.end ?? lines;
      const raw = readLines(p.root, path, start, end);
      const capped = capSummary(raw);
      const text = `read ${path}:${start}-${end}\n${capped}`;
      const handle = writeEvidence(p, taskId, "file", raw, capped, path);
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, evidenceRef: handle.id, meta: { path } });
      return text;
    }
    case "grep": {
      const store = openStore(p);
      const raw = grepText(p, store, String(d.pattern ?? ""), { glob: d.glob });
      store.close();
      const capped = capSummary(raw);
      const text = `grep "${d.pattern}":\n${capped}`;
      const handle = writeEvidence(p, taskId, "other", raw, capped);
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, evidenceRef: handle.id });
      return text;
    }
    case "search": {
      const store = openStore(p);
      const raw = searchText(p, store, String(d.query ?? ""));
      store.close();
      const capped = capSummary(raw);
      const text = `search "${d.query}":\n${capped}`;
      const handle = writeEvidence(p, taskId, "other", raw, capped);
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, evidenceRef: handle.id });
      return text;
    }
    case "edit": {
      const path = String(d.path ?? "");
      const abs = safeAbsPath(p, path);
      const oldText = d.old ?? "";
      const newText = d.new ?? "";
      if (!abs) {
        const text = `edit ${path}: refused — path escapes repo root`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, meta: { path } });
        return text;
      }
      const exists = existsSync(abs);
      if (!exists) {
        if (oldText !== "") {
          const text = `edit ${path}: file does not exist; "old" must be "" to create it`;
          appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, meta: { path } });
          return text;
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, newText, "utf8");
      } else {
        const current = readFileSync(abs, "utf8");
        const count = oldText ? current.split(oldText).length - 1 : 0;
        if (oldText === "") {
          const text = `edit ${path}: refused — "old" is empty but the file already exists; quote the exact text to replace`;
          appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, meta: { path } });
          return text;
        }
        if (count === 0) {
          const text = `edit ${path}: "old" text not found — re-read the file and copy it exactly`;
          appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, meta: { path } });
          return text;
        }
        if (count > 1) {
          const text = `edit ${path}: "old" text matches ${count} places — include more surrounding context to make it unique`;
          appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, meta: { path } });
          return text;
        }
        writeFileSync(abs, current.replace(oldText, newText), "utf8");
      }
      const store = openStore(p);
      indexRepo(p, store);
      store.close();
      const deltaLines = Math.max(oldText.split("\n").length, newText.split("\n").length);
      const text = `edited ${path} (~${deltaLines} line(s) changed)`;
      appendEvent(p, taskId, { actor: "system", type: "edit", summary: text, meta: { path } });
      return text;
    }
    case "run": {
      const r = await runCommand(p, String(d.command ?? ""));
      const capped = capSummary(r.rendered);
      const handle = writeEvidence(p, taskId, "command", r.rendered, capped);
      appendEvent(p, taskId, { actor: "system", type: "command", summary: capped, evidenceRef: handle.id, meta: { command: d.command, exit: r.exit } });
      return capped;
    }
    case "verify": {
      const cfg = loadConfig(p);
      const store = openStore(p);
      const v = await verify(p, cfg, store, null);
      store.close();
      const capped = capSummary(v.report);
      const handle = writeEvidence(p, taskId, "command", v.report, capped);
      appendEvent(p, taskId, { actor: "system", type: "verify", summary: capped, evidenceRef: handle.id, meta: { ok: v.ok } });
      return capped;
    }
    default: {
      const text = `unknown action "${d.action}"; ignored`;
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text });
      return text;
    }
  }
}
