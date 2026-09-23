import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { loadConfig, type Paths } from "./config.js";
import { runCommand } from "./compress.js";
import { project } from "./context.js";
import { writeEvidence } from "./evidence.js";
import { appendEvent, fold, readEvents } from "./events.js";
import { indexRepo, openStore } from "./indexer.js";
import { MEMORY_TYPES, openMemory, renderMemory, type MemoryType } from "./memory.js";
import { callModel } from "./providers/claude-cli.js";
import { readLines } from "./package.js";
import { grepText, searchText } from "./query.js";
import { termsOf } from "./terms.js";
import { estimateTokens, shortId } from "./util.js";
import { verify } from "./verify.js";

/**
 * Stage 2 milestone (CLAUDE.md "Handoff"): the smallest owned agent loop. One tool per step
 * (read/grep/search/edit/run/verify), no planning sophistication yet.
 *
 * One Claude Code session is kept alive across a task's steps (`sessionId`/`resume` in
 * providers/claude-cli.ts), not a fresh session per step: a bench.ts A/B on a real Hono task
 * showed a fresh-per-step design paying full, uncached price on every turn — worse on fresh
 * tokens than plain native Claude Code, which caches heavily across its own turns within one
 * session. Resuming lets ordinary Anthropic prompt caching apply the same way. The static
 * SYSTEM_INSTRUCTIONS are sent once per session; each later turn's prompt is just that step's
 * actual, capped tool result — the model sees its own prior turns natively via the resumed
 * conversation, so there is no need to re-derive and resend a state summary every turn.
 *
 * Deterministic compaction (no LLM call, unlike Claude Code's own `/compact`): a session grows
 * unboundedly if never retired, the same problem Claude Code solves by summarizing the transcript
 * with a model call. Here, once a call's total context (input + cache-creation + cache-read)
 * crosses `compactThreshold`, the NEXT call starts a brand-new session, seeded with a summary
 * built purely from the already-logged event/evidence data (context.ts's project() over
 * events.ts's fold()) — no summarization call needed, since every turn's result was already
 * captured as a short summary at write time. events.ts/evidence.ts log every call and action for
 * the usage ledger and for evidence handles, independent of what the model itself remembers.
 *
 * Model routing (`ModelTiers`): Haiku while exploring (no edit made yet — reading, searching,
 * orienting), Sonnet once actually editing/verifying, Opus specifically when the loop is stalling
 * (one turn before STALL_THRESHOLD's nudge would fire). The escalation isn't a cost optimization
 * on its own — it directly targets a measured gap: two genuinely hard Hono tasks failed on Sonnet
 * alone even at a 35-step budget, not a step-budget problem but a reasoning one; escalating only
 * when stuck, not by default, spends the stronger model where it was shown to matter. Verified
 * that `--model` can change mid-session on a `--resume` call (the CLI honors it per-call; it does
 * not lock a session to its first model). `--effort` (default "medium") is passed to every call.
 */

const SYSTEM_INSTRUCTIONS = `You are driving a coding task through a tool-free reasoning interface. You cannot run tools yourself — instead, on every turn, respond with EXACTLY ONE JSON object (no markdown fences, no prose outside the JSON) describing the next action for the runtime to take on your behalf:

{"action":"read","path":"<repo-relative path>","start"?:<line>,"end"?:<line>}
{"action":"grep","pattern":"<text>","glob"?:"<pathspec>"}
{"action":"search","query":"<text>"}
{"action":"edit","path":"<repo-relative path>","old":"<exact existing text to replace, or \"\" only to create a new file>","new":"<replacement text>"}
{"action":"run","command":"<shell command>"}
{"action":"verify"}
{"action":"recall","query":"<topic, e.g. the area of code or kind of problem>"}
{"action":"remember","type":"fact"|"decision"|"constraint"|"convention"|"failure"|"bug"|"command"|"environment","text":"<durable knowledge, one or two sentences>","reason"?:"<why>","attempt"?:"<for failures: what was tried>","result"?:"<for failures: what happened>","files"?:["<path>"]}
{"action":"done","summary":"<what changed and why it satisfies the task>"}
{"action":"blocked","reason":"<what you need that you don't have>"}

Read before you edit. "old" must match the file's current text EXACTLY (including whitespace) and must appear
exactly once — copy it verbatim from what you last read, quoting only as much surrounding context as needed to
make it unique. Never restate the whole file: "old"/"new" should cover only the lines that actually change. If a
previous edit is rejected, re-read the file before retrying — do not guess at the current content.
Verify after you edit. Do not edit files the task tells you not to modify — if a task says tests currently fail
and to make them pass, the fix belongs in the implementation file the tests exercise, never in the test file
itself, even if that would be the easier edit. If verification keeps failing the same way after you've already
edited something, that is a sign you edited the wrong file or the wrong thing — re-read the actual implementation
before trying again, rather than re-running the same check hoping for a different result.
Prefer the smallest edit that satisfies the task.
Memory persists across tasks, not just this one — use "recall" early if the task touches an area you might have
notes on, and "remember" for anything a future task would benefit from knowing: a failed approach (so it isn't
retried), a non-obvious constraint or convention, or a decision and its reason. Don't remember routine facts
already obvious from the code.`;

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
  type?: string;
  text?: string;
  attempt?: string;
  result?: string;
  files?: string[];
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

export interface ModelTiers {
  /** Turns before the first edit of the task: reading, searching, orienting. Cheap by design. */
  explore?: string;
  /** Turns after at least one edit has happened: normal editing/verification decisions. */
  execute?: string;
  /** Turns at or past the stall threshold (context.ts's project() saw the loop spinning): the one
   * place a stronger model is worth its cost. Directly motivated by a real result: two genuinely
   * hard Hono tasks failed even at a 35-step budget on Sonnet alone — not a budget problem, a
   * reasoning one. Escalating specifically when stuck, not by default, is the targeted fix. */
  escalate?: string;
}

export interface RuntimeOptions {
  maxSteps?: number;
  budget?: number;
  /** Back-compat: a single model for every turn. Ignored if `models` is given. */
  model?: string;
  /** Per-phase model routing. Defaults to {explore: "haiku", execute: "sonnet", escalate: "opus"}. */
  models?: ModelTiers;
  /** --effort passed to every call: low | medium | high | xhigh | max. Defaults to "medium". */
  effort?: string;
  claudeBin?: string;
  role?: string;
  /** Context size (input + cache-creation + cache-read tokens, from the most recent call) above
   * which the next call starts a fresh, deterministically-summarized session. Defaults to
   * `cfg.budget.max`. */
  compactThreshold?: number;
  /** Called with one line per step as the loop runs, for live CLI progress. Optional — the
   * event log (events.ts) is always the durable record regardless of whether this is set. */
  log?: (line: string) => void;
}

const DEFAULT_MODEL_TIERS: Required<ModelTiers> = { explore: "haiku", execute: "sonnet", escalate: "opus" };

export interface RuntimeResult {
  taskId: string;
  outcome: "done" | "blocked" | "max_steps" | "error";
  summary: string;
  steps: number;
  /** Count of executed actions by name (read/grep/search/edit/run/verify) — every one is Narrowbit's own, not Claude Code's. */
  actionCounts: Record<string, number>;
  /** How many times the session was retired and restarted with a deterministic summary. */
  compactions: number;
}

const MAX_PARSE_RETRIES = 3;
/** Consecutive run/verify actions without an intervening edit before the loop nudges instead of letting it spin. */
const STALL_THRESHOLD = 4;
/** Retries for a non-fatal model-call failure (timeout, killed process) before giving up on the task. */
const MAX_TRANSIENT_RETRIES = 2;

export async function runTask(p: Paths, taskText: string, opts: RuntimeOptions = {}): Promise<RuntimeResult> {
  const cfg = loadConfig(p);
  const taskId = `rt-${shortId()}`;
  const store = openStore(p);
  indexRepo(p, store);
  const maxSteps = opts.maxSteps ?? 20;
  const role = opts.role ?? "execution";
  const tiers = opts.model ? { explore: opts.model, execute: opts.model, escalate: opts.model } : { ...DEFAULT_MODEL_TIERS, ...opts.models };
  const effort = opts.effort ?? "medium";
  const compactThreshold = opts.compactThreshold ?? cfg.budget.max;
  const log = opts.log ?? (() => {});
  let hasEdited = false;

  appendEvent(p, taskId, { actor: "user", type: "decision", summary: "task received", meta: { goal: taskText } });

  let outcome: RuntimeResult["outcome"] = "max_steps";
  let summary = "";
  let steps = 0;
  let parseRetries = 0;
  let compactions = 0;
  // Anti-spin guard: counts run/verify/read/grep/search/recall actions since the last edit. A
  // real failure observed on a real Hono task: the model re-ran the same failing test 13 times in
  // a row instead of ever editing the actual implementation file, burning the whole step budget.
  // Past STALL_THRESHOLD consecutive non-edit actions, the next prompt gets an explicit nudge.
  let sinceLastEdit = 0;
  const actionCounts: Record<string, number> = {};
  let sessionId = randomUUID();
  // true at the start of every session (the task's first, or right after a compaction): the next
  // call must send SYSTEM_INSTRUCTIONS and must NOT resume, since there is nothing to resume yet.
  let freshSessionPending = true;
  let nextPrompt = `Task: ${taskText}\n\nRespond with your first action as JSON.`;
  // callModel's costUsd is Claude Code's CUMULATIVE cost for the whole resumed session, not a
  // per-call charge (confirmed by direct measurement: it strictly increases call over call, unlike
  // every other usage field, which the Anthropic API reports per-request). Track the running total
  // and log only each call's own delta, so summing costUsd across events (events.ts's fold()) stays
  // correct instead of re-counting every prior call's cost on every later one. Reset at each
  // compaction, since a new session's costUsd is again cumulative from zero for that new session.
  let cumulativeCost = 0;

  for (; steps < maxSteps; steps++) {
    // Escalate a turn early (one short of the stall nudge) rather than after — the point is to
    // get unstuck, not to confirm it's stuck. Otherwise: cheap while exploring, normal once editing.
    const turnModel = sinceLastEdit >= STALL_THRESHOLD - 1 ? tiers.escalate : hasEdited ? tiers.execute : tiers.explore;
    const callOpts = {
      cwd: p.root,
      systemPrompt: freshSessionPending ? SYSTEM_INSTRUCTIONS : undefined,
      prompt: nextPrompt,
      model: turnModel,
      effort,
      role,
      claudeBin: opts.claudeBin,
      sessionId,
      resume: !freshSessionPending,
    };
    let res = await callModel(callOpts);
    // A non-fatal error (timeout, killed process, no result event) is presumed transient, not a
    // real problem with the request — retry the identical call before giving up on the task.
    for (let transientRetries = 0; res.isError && !res.fatal && transientRetries < MAX_TRANSIENT_RETRIES; transientRetries++) {
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `step ${steps}: model call failed (${res.errorMessage ?? "no result"}), retrying (${transientRetries + 1}/${MAX_TRANSIENT_RETRIES})` });
      res = await callModel(callOpts);
    }
    freshSessionPending = false;
    const totalCost = res.costUsd ?? cumulativeCost;
    const callCost = Math.max(0, totalCost - cumulativeCost);
    cumulativeCost = totalCost;
    appendEvent(p, taskId, {
      actor: "model",
      type: "model_call",
      summary: res.isError ? `step ${steps}: model call failed` : `step ${steps}: ${res.text.slice(0, 120)}`,
      tokens: {
        model: turnModel,
        role,
        inputTokens: res.usage.input,
        cacheCreationTokens: res.usage.cacheCreate,
        cacheReadTokens: res.usage.cacheRead,
        outputTokens: res.usage.output,
        costUsd: callCost,
      },
    });
    if (res.isError) {
      appendEvent(p, taskId, { actor: "system", type: "blocker", summary: `model call failed: ${res.errorMessage ?? "unknown error"}` });
      outcome = "error";
      summary = res.errorMessage ?? "model call failed";
      log(`[${steps}] model call failed: ${summary}`);
      break;
    }

    const decision = parseDecision(res.text);
    if (!decision) {
      parseRetries++;
      appendEvent(p, taskId, { actor: "system", type: "blocker", summary: `could not parse a JSON action from the model's response (attempt ${parseRetries}/${MAX_PARSE_RETRIES}): ${res.text.slice(0, 200)}` });
      log(`[${steps}] (${turnModel}) unparseable response, retry ${parseRetries}/${MAX_PARSE_RETRIES}`);
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
      log(`[${steps}] (${turnModel}) done: ${summary}`);
      break;
    }
    if (decision.action === "blocked") {
      outcome = "blocked";
      summary = decision.reason ?? "blocked";
      appendEvent(p, taskId, { actor: "model", type: "blocker", summary });
      log(`[${steps}] (${turnModel}) blocked: ${summary}`);
      break;
    }

    actionCounts[decision.action] = (actionCounts[decision.action] ?? 0) + 1;
    sinceLastEdit = decision.action === "edit" ? 0 : sinceLastEdit + 1;
    if (decision.action === "edit") hasEdited = true;
    log(`[${steps}] (${turnModel}) ${decision.action}${decision.path ? ` ${decision.path}` : decision.query ? ` "${decision.query}"` : decision.pattern ? ` "${decision.pattern}"` : ""}`);
    let resultText: string;
    try {
      resultText = await executeAction(p, taskId, decision);
    } catch (e: any) {
      resultText = `error: ${String(e?.message ?? e).slice(0, 300)}`;
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: resultText });
    }
    log(`      → ${resultText.split("\n")[0].slice(0, 100)}`);
    const stalling = sinceLastEdit >= STALL_THRESHOLD && (decision.action === "run" || decision.action === "verify");
    if (stalling) {
      appendEvent(p, taskId, { actor: "system", type: "blocker", summary: `${sinceLastEdit} steps without an edit — nudging toward the implementation file` });
      log(`      ! stalling (${sinceLastEdit} steps without an edit) — nudging`);
    }
    const nudge = stalling
      ? `\n\nSTOP: you've taken ${sinceLastEdit} steps without editing anything. Re-running the same check will not fix it. Read the actual implementation file the test exercises (not the test file) and make a real change before checking again.`
      : "";

    // Compact on the context the model just processed, not a fixed turn count: a task with big
    // reads compacts sooner than one with small ones, and a cheap task may never compact at all.
    const contextTokens = res.usage.input + res.usage.cacheCreate + res.usage.cacheRead;
    if (contextTokens >= compactThreshold) {
      const previousSessionId = sessionId;
      sessionId = randomUUID();
      freshSessionPending = true;
      cumulativeCost = 0;
      compactions++;
      const digest = project(fold(taskId, readEvents(p, taskId)), { budget: cfg.budget.initial });
      appendEvent(p, taskId, {
        actor: "system",
        type: "handoff",
        summary: `compacted after ${steps + 1} turn(s), ~${contextTokens} context tokens — starting a new session`,
        meta: { previousSessionId, contextTokens },
      });
      log(`      ~ compacted (${contextTokens} context tokens) — new session`);
      nextPrompt = `You are continuing this task after a context compaction. Nothing was lost, only compacted — use read/grep/search again for anything you need in full, rather than assuming what you remember is still current. Progress so far:\n\n${digest}\n\nMost recent result:\n${resultText}${nudge}\n\nWhat is the next action? Respond with JSON only.`;
    } else {
      nextPrompt = `${resultText}${nudge}\n\nWhat is the next action? Respond with JSON only.`;
    }
  }

  if (outcome === "max_steps") log(`[${steps}] hit the step budget (${maxSteps}) without finishing`);
  store.close();
  return { taskId, outcome, summary, steps, actionCounts, compactions };
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
    case "recall": {
      const query = String(d.query ?? "");
      const memory = openMemory(p);
      const hits = query ? memory.relevant(termsOf(query), [], 8).map((h) => h.entry) : memory.load().filter((e) => e.status === "active").slice(-8);
      const raw = hits.length ? hits.map(renderMemory).join("\n") : "no matching memory";
      const capped = capSummary(raw);
      const text = `recall "${query}":\n${capped}`;
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text });
      return text;
    }
    case "remember": {
      const type = String(d.type ?? "");
      if (!MEMORY_TYPES.includes(type as MemoryType)) {
        const text = `remember: refused — unknown type "${type}" (expected ${MEMORY_TYPES.join(", ")})`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text });
        return text;
      }
      const memory = openMemory(p);
      const e = memory.add({
        type: type as MemoryType,
        text: String(d.text ?? ""),
        reason: d.reason,
        attempt: d.attempt,
        result: d.result,
        files: d.files,
        source: taskId,
      });
      const text = `remembered [${e.id}] (${type}): ${e.text.slice(0, 100)}`;
      appendEvent(p, taskId, { actor: "system", type: "decision", summary: text, meta: { memoryId: e.id, memoryType: type } });
      return text;
    }
    default: {
      const text = `unknown action "${d.action}"; ignored`;
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text });
      return text;
    }
  }
}
