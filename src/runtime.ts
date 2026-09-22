import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { loadConfig, type Paths } from "./config.js";
import { runCommand } from "./compress.js";
import { project } from "./context.js";
import { writeEvidence } from "./evidence.js";
import { appendEvent, fold, readEvents } from "./events.js";
import { indexRepo, openStore } from "./indexer.js";
import { callModel } from "./providers/claude-cli.js";
import { readLines } from "./package.js";
import { grepText, searchText } from "./query.js";
import { estimateTokens, now, shortId } from "./util.js";
import { verify } from "./verify.js";

/**
 * Stage 2 milestone (CLAUDE.md "Handoff"): the smallest owned agent loop. One tool per step
 * (read/grep/search/edit/run/verify), no planning sophistication yet. The model never sees a
 * transcript — every turn gets a fresh, budget-bounded projection (context.ts) built from the
 * event log (events.ts); every model call and tool execution is one attributable Event.
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
}

export async function runTask(p: Paths, taskText: string, opts: RuntimeOptions = {}): Promise<RuntimeResult> {
  const cfg = loadConfig(p);
  const taskId = `rt-${shortId()}`;
  const store = openStore(p);
  indexRepo(p, store);
  const maxSteps = opts.maxSteps ?? 20;
  const budget = opts.budget ?? cfg.budget.initial;
  const role = opts.role ?? "execution";
  const model = opts.model ?? "sonnet";

  appendEvent(p, taskId, { actor: "user", type: "decision", summary: "task received", meta: { goal: taskText } });

  let outcome: RuntimeResult["outcome"] = "max_steps";
  let summary = "";
  let steps = 0;

  for (; steps < maxSteps; steps++) {
    const state = fold(taskId, readEvents(p, taskId));
    const projected = project(state, { budget });
    const sys = `${SYSTEM_INSTRUCTIONS}\n\n${projected}`;
    const prompt = steps === 0 ? `Task: ${taskText}\n\nRespond with your first action as JSON.` : "What is the next action? Respond with JSON only.";

    const res = await callModel({ cwd: p.root, systemPrompt: sys, prompt, model, role, claudeBin: opts.claudeBin });
    appendEvent(p, taskId, {
      actor: "model",
      type: "model_call",
      summary: res.isError ? `step ${steps}: model call failed` : `step ${steps}: ${res.text.slice(0, 120)}`,
      tokens: { model, role, promptTokens: res.usage.input + res.usage.cacheCreate + res.usage.cacheRead, completionTokens: res.usage.output, costUsd: res.costUsd ?? 0 },
    });
    if (res.isError) {
      appendEvent(p, taskId, { actor: "system", type: "blocker", summary: `model call failed: ${res.errorMessage ?? "unknown error"}` });
      outcome = "error";
      summary = res.errorMessage ?? "model call failed";
      break;
    }

    const decision = parseDecision(res.text);
    if (!decision) {
      appendEvent(p, taskId, { actor: "system", type: "blocker", summary: `could not parse a JSON action from the model's response: ${res.text.slice(0, 200)}` });
      outcome = "error";
      summary = "unparseable model response";
      break;
    }

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

    try {
      await executeAction(p, taskId, decision);
    } catch (e: any) {
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `error: ${String(e?.message ?? e).slice(0, 300)}` });
    }
  }

  store.close();
  return { taskId, outcome, summary, steps };
}

async function executeAction(p: Paths, taskId: string, d: Decision): Promise<void> {
  switch (d.action) {
    case "read": {
      const path = String(d.path ?? "");
      const abs = safeAbsPath(p, path);
      if (!abs || !existsSync(abs)) {
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `read ${path}: file not found`, meta: { path } });
        return;
      }
      const lines = readFileSync(abs, "utf8").split("\n").length;
      const start = d.start ?? 1;
      const end = d.end ?? lines;
      const raw = readLines(p.root, path, start, end);
      const capped = capSummary(raw);
      const handle = writeEvidence(p, taskId, "file", raw, capped, path);
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `read ${path}:${start}-${end}\n${capped}`, evidenceRef: handle.id, meta: { path } });
      return;
    }
    case "grep": {
      const store = openStore(p);
      const text = grepText(p, store, String(d.pattern ?? ""), { glob: d.glob });
      store.close();
      const capped = capSummary(text);
      const handle = writeEvidence(p, taskId, "other", text, capped);
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `grep "${d.pattern}":\n${capped}`, evidenceRef: handle.id });
      return;
    }
    case "search": {
      const store = openStore(p);
      const text = searchText(p, store, String(d.query ?? ""));
      store.close();
      const capped = capSummary(text);
      const handle = writeEvidence(p, taskId, "other", text, capped);
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `search "${d.query}":\n${capped}`, evidenceRef: handle.id });
      return;
    }
    case "edit": {
      const path = String(d.path ?? "");
      const abs = safeAbsPath(p, path);
      const oldText = d.old ?? "";
      const newText = d.new ?? "";
      if (!abs) {
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `edit ${path}: refused — path escapes repo root`, meta: { path } });
        return;
      }
      const exists = existsSync(abs);
      if (!exists) {
        if (oldText !== "") {
          appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `edit ${path}: file does not exist; "old" must be "" to create it`, meta: { path } });
          return;
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, newText, "utf8");
      } else {
        const current = readFileSync(abs, "utf8");
        const count = oldText ? current.split(oldText).length - 1 : 0;
        if (oldText === "") {
          appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `edit ${path}: refused — "old" is empty but the file already exists; quote the exact text to replace`, meta: { path } });
          return;
        }
        if (count === 0) {
          appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `edit ${path}: "old" text not found — re-read the file and copy it exactly`, meta: { path } });
          return;
        }
        if (count > 1) {
          appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `edit ${path}: "old" text matches ${count} places — include more surrounding context to make it unique`, meta: { path } });
          return;
        }
        writeFileSync(abs, current.replace(oldText, newText), "utf8");
      }
      const store = openStore(p);
      indexRepo(p, store);
      store.close();
      const deltaLines = Math.max(oldText.split("\n").length, newText.split("\n").length);
      appendEvent(p, taskId, { actor: "system", type: "edit", summary: `edited ${path} (~${deltaLines} line(s) changed)`, meta: { path } });
      return;
    }
    case "run": {
      const r = await runCommand(p, String(d.command ?? ""));
      const capped = capSummary(r.rendered);
      const handle = writeEvidence(p, taskId, "command", r.rendered, capped);
      appendEvent(p, taskId, { actor: "system", type: "command", summary: capped, evidenceRef: handle.id, meta: { command: d.command, exit: r.exit } });
      return;
    }
    case "verify": {
      const cfg = loadConfig(p);
      const store = openStore(p);
      const v = await verify(p, cfg, store, null);
      store.close();
      const capped = capSummary(v.report);
      const handle = writeEvidence(p, taskId, "command", v.report, capped);
      appendEvent(p, taskId, { actor: "system", type: "verify", summary: capped, evidenceRef: handle.id, meta: { ok: v.ok } });
      return;
    }
    default:
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `unknown action "${d.action}"; ignored` });
  }
}
