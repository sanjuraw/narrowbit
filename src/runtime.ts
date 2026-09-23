import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { loadConfig, type Paths } from "./config.js";
import { runCommand } from "./compress.js";
import { project } from "./context.js";
import { writeEvidence } from "./evidence.js";
import { appendEvent, fold, readEvents, subscribe, type Event, type PlanStep } from "./events.js";
import { indexRepo, openStore } from "./indexer.js";
import { MEMORY_TYPES, openMemory, renderMemory, type MemoryType } from "./memory.js";
import { callModel, type ModelCallOptions, type ModelCallResult } from "./providers/claude-cli.js";
import { DEFAULT_TIERS, resolveEndpoint, unavailableReason, type ModelTiers, type ProviderName } from "./providers/models.js";
import { callOpenAICompat, hasSession } from "./providers/openai-compat.js";
import { redact } from "./redact.js";
import { readLines } from "./package.js";
import { grepText, searchText } from "./query.js";
import { termsOf } from "./terms.js";
import { estimateTokens, sh, shortId } from "./util.js";
import { verify } from "./verify.js";

/**
 * Stage 2 milestone (CLAUDE.md "Handoff"): the smallest owned agent loop.
 *
 * Action batching (`MAX_BATCH_ACTIONS`): each turn is one model call but can carry up to N actions
 * (read/grep/search/edit/run/verify/recall/remember), executed in order, before the next model
 * call. Built because two genuinely hard Hono tasks kept failing under the original one-action-
 * per-turn loop even with model escalation and lead-mode review (see CLAUDE.md's "Owned runtime,
 * remaining 25 tasks" and "Lead mode A/B'd" entries) — neither a stronger model nor a plan/review
 * pass changes the mechanism of needing 15-20 model calls to do what a human would do in 4-5 edits.
 * A batch stops early — the model sees exactly why and everything already executed, not silently
 * dropped — the moment continuing would build on a wrong assumption: an edit refused, verify
 * failed, or a command exited non-zero. Not yet re-measured against the two hard tasks it was
 * built for; that comparison is the actual test of whether this closes the gap.
 *
 * Lead mode (`boss`, default on): the escalate model acts as the lead — one stateless call writes
 * a short plan from the task plus local search results before the loop starts, and one reviews
 * the diff when the worker reports done (at most MAX_REVIEWS times; "revise" sends the feedback
 * back into the loop). The worker marks plan steps with "steps_done". Two extra strong-model calls
 * per task. A/B'd directly against the two hard tasks (CLAUDE.md, 2026-09-23): partial help on the
 * harder one (1/2 vs 0/2 success), no effect on the other, at a real 24-27% token/cost premium —
 * it doesn't touch the one-action-per-turn mechanism, batching does.
 *
 * Lead mode (`boss`, default on): the escalate model acts as the lead — one stateless call writes
 * a short plan from the task plus local search results before the loop starts, and one reviews
 * the diff when the worker reports done (at most MAX_REVIEWS times; "revise" sends the feedback
 * back into the loop). The worker marks plan steps with "steps_done". Two extra strong-model calls
 * per task; the aim is the hard-task failures the one-action-per-turn loop showed, and it needs
 * an A/B before its cost is taken as justified.
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
 * orienting), Sonnet once actually editing/verifying, Opus specifically when the loop is stuck
 * (two failed checks with no edit between them, or a long stretch with no edit). The escalation isn't a cost optimization
 * on its own — it directly targets a measured gap: two genuinely hard Hono tasks failed on Sonnet
 * alone even at a 35-step budget, not a step-budget problem but a reasoning one; escalating only
 * when stuck, not by default, spends the stronger model where it was shown to matter. Verified
 * that `--model` can change mid-session on a `--resume` call (the CLI honors it per-call; it does
 * not lock a session to its first model). `--effort` (default "medium") is passed to every call.
 */

/** Batch cap: bounds how much one turn can do (and how much a bad guess can waste) before the
 * model gets to react to what actually happened. */
const MAX_BATCH_ACTIONS = 5;

const SYSTEM_INSTRUCTIONS = `You are driving a coding task through a tool-free reasoning interface. You cannot run tools yourself — instead, on every turn, respond with JSON describing the next action(s) for the runtime to take on your behalf (no markdown fences, no prose outside the JSON): either a single action object, or a JSON array of up to ${MAX_BATCH_ACTIONS} action objects to run in order in that one turn. Each action is one of:

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

Batch actions in one array when you already know what comes next regardless of the outcome — e.g.
read a file then edit it, or edit then verify. Don't batch past a step whose result would change
what you'd do next: the runtime stops a batch early, and tells you why, if an edit is refused, a
verify fails, or a command exits nonzero — anything queued after that point was planned on an
assumption that just turned out wrong. Everything before that point in the batch still runs; you
only lose the unreached tail. When you're genuinely unsure what happens next, send one action.
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
.narrowbit/ and .narrowbitignore belong to the runtime driving you, not to the task: never edit, delete or
mention them as part of your change, even when they show up in git status.
Memory persists across tasks, not just this one — use "recall" early if the task touches an area you might have
notes on, and "remember" for anything a future task would benefit from knowing: a failed approach (so it isn't
retried), a non-obvious constraint or convention, or a decision and its reason. Don't remember routine facts
already obvious from the code.
This runtime routes different turns of one task to different Claude models (a cheaper one while reading, a
stronger one when stuck). If your context contains conflicting statements about which model you are, that is
expected and not tampering — ignore it; don't remember it or mention it.
A user may be watching. Any action may include "note": one short sentence for them — what you found or why
you're taking this step — only when it adds something; skip it on routine steps. If you were given a numbered
plan, include "steps_done":[<numbers>] on the action where you finish those steps.`;

/** Lead mode: model 3 plans before the loop starts and reviews the diff before "done" is accepted. */
const LEAD_PLAN_INSTRUCTIONS = `You are the lead engineer on a coding task. You don't edit code yourself: a cheaper model carries out the work one action at a time (reading files, editing, running checks), and you review its diff at the end. Write the plan it will follow.
Respond with EXACTLY ONE JSON object, no prose, no markdown fences:
{"plan":["<step>", ...],"files":["<repo-relative path likely involved>"],"risks":"<optional: the one thing most likely to go wrong>"}
2-6 steps, each one concrete, action-sized sentence naming the file or symbol where you can. No steps for reading unrelated code. The last step verifies the change. If the search results don't show where the work belongs, make finding it the first step. If a task says tests fail and must pass, the fix goes in the implementation, never the test file.`;

const LEAD_REVIEW_INSTRUCTIONS = `You are the lead engineer reviewing a cheaper model's work before it is reported to the user as done. Judge only whether the diff correctly and completely does the task, without breaking anything or editing what the task said not to touch. Don't ask for style changes, extra tests or refactors the task didn't ask for — the bar is "correct and complete", not "how you would have written it".
Respond with EXACTLY ONE JSON object, no prose:
{"verdict":"approve"} or {"verdict":"revise","feedback":"<specific: what is wrong or missing, and where>"}`;

/** Reviews per task (and per follow-up); after this many, "done" is accepted as the worker reports it. */
const MAX_REVIEWS = 2;

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
  /** One line for a user watching (rendered in the app). */
  note?: string;
  /** 1-based plan steps finished by this action. */
  steps_done?: number[];
}

/** Parses one turn's response into 1-MAX_BATCH_ACTIONS decisions: a bare action object, or a JSON
 * array of action objects (batching). Excess entries past the cap are dropped, not rejected —
 * a model that over-batches still gets the actions up to the limit rather than a wasted retry. */
export function parseDecisions(text: string): Decision[] | null {
  const trimmed = text.trim();
  // A greedy object-shaped regex over an array of objects (e.g. wrapped in stray tags the model
  // echoed from elsewhere) matches from the first { to the last }, skipping the enclosing [ ] and
  // producing invalid JSON — so the array candidate must be tried, not just the object one, and
  // whichever candidate actually parses wins rather than picking one by a fixed priority alone.
  const candidates = [trimmed, /\[[\s\S]*\]/.exec(trimmed)?.[0], /\{[\s\S]*\}/.exec(trimmed)?.[0]];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const decisions = items.filter((d): d is Decision => !!d && typeof d === "object" && typeof (d as any).action === "string");
    if (decisions.length) return decisions.slice(0, MAX_BATCH_ACTIONS);
  }
  return null;
}

export function parseDecision(text: string): Decision | null {
  return parseDecisions(text)?.[0] ?? null;
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
  /** Which provider drives the model calls. Defaults to "claude". */
  provider?: ProviderName;
  /** A single model for every phase. Ignored if `models` is given. */
  model?: string;
  /** Per-phase models (explore = before any edit, execute = editing/verifying, escalate = stuck);
   * missing phases fall back to the provider's defaults in providers/models.ts. */
  models?: Partial<ModelTiers>;
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
  /** Asked before every `run` action. Resolving false refuses the command and tells the model so;
   * unset means commands run without asking (benchmarks, trusted CLI use). */
  approve?: (command: string) => Promise<boolean>;
  /** Aborting stops the loop before its next model call (a call already in flight finishes first). */
  signal?: AbortSignal;
  /** Lead mode: the escalate model plans up front and reviews the diff before "done". Default true. */
  boss?: boolean;
  /** Continue an earlier task with `taskText` as a follow-up request, in the same event log —
   * resuming its model session when it still exists, else from a deterministic digest. */
  continueTask?: string;
  /** Every event appended for this task, as it happens (the app renders these). */
  onEvent?: (e: Event) => void;
}


export interface RuntimeResult {
  taskId: string;
  outcome: "done" | "blocked" | "max_steps" | "error" | "stopped";
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
  const taskId = opts.continueTask ?? `rt-${shortId()}`;
  const unsubscribe = opts.onEvent ? subscribe(taskId, opts.onEvent) : null;
  try {
    return await runLoop(p, taskId, taskText, opts);
  } finally {
    unsubscribe?.();
  }
}

async function runLoop(p: Paths, taskId: string, taskText: string, opts: RuntimeOptions): Promise<RuntimeResult> {
  const provider = opts.provider ?? "claude";
  const cfg = loadConfig(p);
  const tiers = opts.models ? { ...DEFAULT_TIERS[provider], ...opts.models } : opts.model ? { explore: opts.model, execute: opts.model, escalate: opts.model } : DEFAULT_TIERS[provider];
  const effort = opts.effort ?? "medium";
  // Refuse clearly up front (Codex without its adapter, a missing key, an unchosen model) rather
  // than silently running on a different provider or failing on the first call.
  const unavailable = unavailableReason({ provider, tiers, effort }, cfg.agent);
  if (unavailable) throw new Error(unavailable);
  const endpoint = resolveEndpoint(provider, cfg.agent);
  const call = endpoint ? (o: ModelCallOptions) => callOpenAICompat(endpoint, o) : callModel;
  const store = openStore(p);
  indexRepo(p, store);
  const maxSteps = opts.maxSteps ?? 20;
  const role = opts.role ?? "execution";
  const compactThreshold = opts.compactThreshold ?? cfg.budget.max;
  const log = opts.log ?? (() => {});
  let hasEdited = false;
  // "done" gate. First real-repo use (narrowbit agent on this repo): Haiku replied "done" on its
  // second call with a confident, detailed summary of changes it never made — no read, no edit,
  // clean git tree — and the loop exited 0. Benchmarks never exposed this because an external
  // verify command judged success there; in real use nothing does. So "done" is challenged once,
  // deterministically, if no edit was actually applied, or if files changed since the last verify.
  let editsApplied = 0;
  let editedSinceVerify = false;
  const doneChallenges = new Set<string>();

  const prior = opts.continueTask ? readEvents(p, taskId) : [];
  const continuing = prior.length > 0;
  const boss = opts.boss ?? true;
  if (continuing) appendEvent(p, taskId, { actor: "user", type: "decision", summary: `follow-up: ${taskText}`, meta: { followUp: taskText } });
  else
    appendEvent(p, taskId, {
      actor: "user",
      type: "decision",
      summary: "task received",
      // Untracked files that predate the task aren't its work; the lead review must not judge them.
      meta: { goal: taskText, untrackedAtStart: untrackedFiles(p) },
    });
  const goal = continuing ? (fold(taskId, prior).goal ?? taskText) : taskText;
  let plan: LeadPlan | null = continuing ? planFromEvents(prior) : null;
  const firstEvent = continuing ? prior[0] : readEvents(p, taskId)[0];
  const preexisting = new Set<string>(Array.isArray(firstEvent?.meta?.untrackedAtStart) ? (firstEvent.meta.untrackedAtStart as string[]) : []);
  const lead = { p, taskId, call, model: tiers.escalate, effort, role, preexisting };
  if (boss && !continuing) {
    log(`[plan] (${tiers.escalate}) planning`);
    plan = await leadPlan(lead, taskText, store);
    if (plan) log(`      → ${plan.steps.length} steps`);
  }

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
  let checksSinceEdit = 0;
  const actionCounts: Record<string, number> = {};
  let sessionId: string = randomUUID();
  // true at the start of every session (the task's first, or right after a compaction): the next
  // call must send SYSTEM_INSTRUCTIONS and must NOT resume, since there is nothing to resume yet.
  let freshSessionPending = true;
  let nextPrompt = `Task: ${taskText}\n\n${plan ? renderPlanForWorker(plan) + "\n\n" : ""}Respond with your first action as JSON.`;
  // callModel's costUsd is Claude Code's CUMULATIVE cost for the whole resumed session, not a
  // per-call charge (confirmed by direct measurement: it strictly increases call over call, unlike
  // every other usage field, which the Anthropic API reports per-request). Track the running total
  // and log only each call's own delta, so summing costUsd across events (events.ts's fold()) stays
  // correct instead of re-counting every prior call's cost on every later one. Reset at each
  // compaction, since a new session's costUsd is again cumulative from zero for that new session.
  let cumulativeCost = 0;
  if (continuing) {
    // Resume the earlier session when it still exists (cheaper: the conversation is cached);
    // otherwise start fresh from the same deterministic digest compaction uses.
    const last = [...prior].reverse().find((e) => e.type === "model_call" && typeof e.meta?.sessionId === "string" && e.tokens?.role === role);
    const lastSession = last?.meta?.sessionId as string | undefined;
    const resumable = lastSession && last?.meta?.provider === provider && (provider === "claude" || hasSession(lastSession));
    if (resumable) {
      sessionId = lastSession;
      freshSessionPending = false;
      cumulativeCost = Number(last?.meta?.sessionCost ?? 0);
      nextPrompt = `Follow-up request from the user: ${taskText}\n\nThe earlier work is already in the files. Respond with your next action as JSON.`;
    } else {
      const digest = project(fold(taskId, prior), { budget: cfg.budget.initial });
      nextPrompt = `You are continuing an earlier task (original goal: ${goal}). Progress so far:\n\n${digest}\n\nNew request from the user: ${taskText}\n\nUse read/grep/search for anything you need in full. Respond with your next action as JSON.`;
    }
  }
  let reviews = 0;

  for (; steps < maxSteps; steps++) {
    if (opts.signal?.aborted) {
      outcome = "stopped";
      summary = "stopped by the user";
      appendEvent(p, taskId, { actor: "user", type: "blocker", summary });
      log(`[${steps}] stopped by the user`);
      break;
    }
    // Escalate only on signs of being stuck: repeated run/verify with no edit between them, or an
    // unusually long stretch without any edit. Counting every non-edit step (the first version)
    // put ordinary reading on Opus — on this repo's first real task, 5 plain reads/greps in a row
    // escalated, most of a 143k-token run for a one-file change.
    const stuck = checksSinceEdit >= 2 || sinceLastEdit >= 2 * STALL_THRESHOLD;
    const turnModel = stuck ? tiers.escalate : hasEdited ? tiers.execute : tiers.explore;
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
    let res = await call(callOpts);
    // A non-fatal error (timeout, killed process, no result event) is presumed transient, not a
    // real problem with the request — retry the identical call before giving up on the task.
    // One exception: a fresh (non-resumed) session-id that Claude Code reports as already in use
    // would fail identically on every retry with the same id — observed once in a 40-task run
    // (cause unconfirmed; regenerating is a cheap, safe guard either way) — so that specific error
    // gets a new random id before the retry instead of repeating the same doomed call.
    for (let transientRetries = 0; res.isError && !res.fatal && transientRetries < MAX_TRANSIENT_RETRIES; transientRetries++) {
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `step ${steps}: model call failed (${res.errorMessage ?? "no result"}), retrying (${transientRetries + 1}/${MAX_TRANSIENT_RETRIES})` });
      if (freshSessionPending && /session id .* already in use/i.test(res.errorMessage ?? "")) {
        sessionId = randomUUID();
        callOpts.sessionId = sessionId;
      }
      res = await call(callOpts);
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
      meta: { sessionId, sessionCost: totalCost, provider },
    });
    if (res.isError) {
      appendEvent(p, taskId, { actor: "system", type: "blocker", summary: `model call failed: ${res.errorMessage ?? "unknown error"}` });
      outcome = "error";
      summary = res.errorMessage ?? "model call failed";
      log(`[${steps}] model call failed: ${summary}`);
      break;
    }

    const decisions = parseDecisions(res.text);
    if (!decisions) {
      parseRetries++;
      appendEvent(p, taskId, { actor: "system", type: "blocker", summary: `could not parse a JSON action from the model's response (attempt ${parseRetries}/${MAX_PARSE_RETRIES}): ${res.text.slice(0, 200)}` });
      log(`[${steps}] (${turnModel}) unparseable response, retry ${parseRetries}/${MAX_PARSE_RETRIES}`);
      if (parseRetries >= MAX_PARSE_RETRIES) {
        outcome = "error";
        summary = "unparseable model response";
        break;
      }
      nextPrompt = "Your last response was not valid JSON. Respond with a single action object, or a JSON array of action objects, nothing else — no prose, no markdown fences.";
      continue;
    }
    parseRetries = 0;

    // Execute the batch in order. batchResults accumulates every executed action's result text;
    // stopReason is set (and the loop broken) the moment continuing would build on a wrong
    // assumption — an edit refused, a failed verify/command — so the tail of the batch goes
    // unexecuted rather than compounding a mistake the model hasn't seen yet.
    const batchResults: string[] = [];
    let stopReason: string | null = null;
    let doneRejected: string | null = null;
    let taskEnded = false;
    let lastCheckFailed = false;

    for (let i = 0; i < decisions.length; i++) {
      const decision = decisions[i];
      const tag = decisions.length > 1 ? `[${i + 1}/${decisions.length}] ` : "";

      if (plan && Array.isArray(decision.steps_done) && decision.steps_done.length) {
        const marked = markSteps(plan, decision.steps_done);
        if (marked) appendEvent(p, taskId, { actor: "model", type: "plan", summary: `plan: ${plan.steps.filter((x) => x.status === "done").length}/${plan.steps.length} done`, meta: planMeta(plan) });
      }

      if (decision.action === "done") {
        let challenge: string | null = null;
        if (editsApplied === 0 && !doneChallenges.has("no-edit")) {
          doneChallenges.add("no-edit");
          challenge = Object.keys(actionCounts).length === 0
            ? "You have not taken a single action yet — nothing has been read or changed, so the task cannot be complete. Start by reading the relevant file."
            : 'No file has been changed in this task. If the task requires a code change, you have not made it yet — continue working. If it genuinely needs no change, reply "done" again and say why.';
        } else if (editedSinceVerify && !doneChallenges.has("no-verify")) {
          doneChallenges.add("no-verify");
          challenge = 'You changed files but have not run "verify" since your last edit. Verify before declaring done.';
        }
        if (challenge) {
          appendEvent(p, taskId, { actor: "system", type: "blocker", summary: `done rejected: ${challenge}` });
          log(`[${steps}] (${turnModel}) ${tag}done rejected — ${challenge.split(/[.—]/)[0].trim()}`);
          doneRejected = `${challenge}\n\nWhat is the next action? Respond with JSON only.`;
          break;
        }
        if (boss && editsApplied > 0 && reviews < MAX_REVIEWS) {
          reviews++;
          log(`[${steps}] (${tiers.escalate}) lead review`);
          const review = await leadReview(lead, goal, taskText !== goal ? taskText : null, plan, decision.summary ?? "");
          if (review?.verdict === "revise") {
            log(`      → changes requested: ${review.feedback.slice(0, 100)}`);
            // A revision reopens the verify challenge: the fix must be checked again.
            doneChallenges.delete("no-verify");
            doneRejected = `The lead engineer reviewed your diff and asked for changes:\n${review.feedback}\n\nMake them, verify, then report done again. What is the next action? Respond with JSON only.`;
            break;
          }
          if (review) log("      → approved");
        }
        outcome = "done";
        summary = decision.summary ?? "done";
        if (plan && plan.steps.some((x) => x.status !== "done")) {
          markSteps(plan, plan.steps.map((_, i2) => i2 + 1));
          appendEvent(p, taskId, { actor: "model", type: "plan", summary: `plan: ${plan.steps.length}/${plan.steps.length} done`, meta: planMeta(plan) });
        }
        appendEvent(p, taskId, { actor: "model", type: "decision", summary: `done: ${summary}`, meta: { note: decision.note } });
        log(`[${steps}] (${turnModel}) ${tag}done: ${summary}`);
        taskEnded = true;
        break;
      }
      if (decision.action === "blocked") {
        outcome = "blocked";
        summary = decision.reason ?? "blocked";
        appendEvent(p, taskId, { actor: "model", type: "blocker", summary });
        log(`[${steps}] (${turnModel}) ${tag}blocked: ${summary}`);
        taskEnded = true;
        break;
      }

      actionCounts[decision.action] = (actionCounts[decision.action] ?? 0) + 1;
      sinceLastEdit = decision.action === "edit" ? 0 : sinceLastEdit + 1;
      if (decision.action === "edit") hasEdited = true;
      log(`[${steps}] (${turnModel}) ${tag}${decision.action}${decision.path ? ` ${decision.path}` : decision.query ? ` "${decision.query}"` : decision.pattern ? ` "${decision.pattern}"` : decision.command ? ` ${decision.command}` : ""}`);
      appendEvent(p, taskId, {
        actor: "model",
        type: "tool_call",
        summary: `${decision.action}${decision.path ? ` ${decision.path}` : decision.command ? ` ${decision.command}` : decision.query ? ` "${decision.query}"` : decision.pattern ? ` "${decision.pattern}"` : ""}`,
        meta: { action: decision.action, path: decision.path, command: decision.command, query: decision.query, pattern: decision.pattern, glob: decision.glob, start: decision.start, end: decision.end, note: decision.note, model: turnModel },
      });
      let resultText: string;
      try {
        resultText = await executeAction(p, taskId, decision, opts.approve);
      } catch (e: any) {
        resultText = `error: ${String(e?.message ?? e).slice(0, 300)}`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: resultText });
      }
      log(`      → ${resultText.split("\n")[0].slice(0, 100)}`);
      batchResults.push(`${tag}${resultText}`);
      // executeAction returns "edited <path>" only when the file was actually written; a refused
      // edit (old text not found / not unique) doesn't count as progress for the done gate.
      const editRefused = decision.action === "edit" && !resultText.startsWith("edited ");
      if (decision.action === "edit" && !editRefused) {
        editsApplied++;
        editedSinceVerify = true;
      }
      // Running one of the repo's own verify commands (e.g. `npm test`) and passing counts as verifying:
      // making the model repeat it through "verify" just to satisfy the done gate wastes a turn.
      const verifyCommands = Object.values(cfg.verify).filter(Boolean) as string[];
      const ranVerifyCommand = decision.action === "run" && /^\$ .*\(exit 0/.test(resultText) && verifyCommands.some((c) => (decision.command ?? "").trim() === c || (decision.command ?? "").trim() === c.replace(/ --silent$/, ""));
      if ((decision.action === "verify" && !resultText.startsWith("VERIFICATION FAILED")) || ranVerifyCommand) editedSinceVerify = false;
      // Only a *failed* check counts toward escalation — edit → typecheck → verify → done is normal,
      // not stuck. The markers are our own output formats: verify.ts's report header and
      // compress.ts's "$ cmd  (exit N; …)" head line.
      const checkFailed =
        (decision.action === "verify" && resultText.startsWith("VERIFICATION FAILED")) || (decision.action === "run" && /^\$ .*\(exit [1-9]/.test(resultText));
      if (decision.action === "edit") checksSinceEdit = 0;
      else if (checkFailed) checksSinceEdit++;
      lastCheckFailed = checkFailed;

      // Stop the batch here if what comes next in it was planned on an assumption this action
      // just disproved — anything still queued goes unexecuted, and the model sees why.
      if (editRefused) stopReason = "the edit above was refused";
      else if (decision.action === "verify" && checkFailed) stopReason = "verification failed";
      else if (decision.action === "run" && checkFailed) stopReason = "the command above exited non-zero";
      if (stopReason) break;
    }

    if (taskEnded) break;

    if (doneRejected) {
      nextPrompt = doneRejected;
      continue;
    }

    // Only a failing check signals spinning; a passing verify after cleanup steps is just finishing.
    const stalling = sinceLastEdit >= STALL_THRESHOLD && lastCheckFailed;
    if (stalling) {
      appendEvent(p, taskId, { actor: "system", type: "blocker", summary: `${sinceLastEdit} steps without an edit — nudging toward the implementation file` });
      log(`      ! stalling (${sinceLastEdit} steps without an edit) — nudging`);
    }
    const nudge = stalling
      ? `\n\nSTOP: you've taken ${sinceLastEdit} steps without editing anything. Re-running the same check will not fix it. Read the actual implementation file the test exercises (not the test file) and make a real change before checking again.`
      : "";
    const combined = batchResults.join("\n\n") || "(no actions executed)";
    const stopNote = stopReason
      ? `\n\n(stopped the batch early — ${stopReason}; ${decisions.length - batchResults.length} planned action(s) after it were not run)`
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
      nextPrompt = `You are continuing this task after a context compaction. Nothing was lost, only compacted — use read/grep/search again for anything you need in full, rather than assuming what you remember is still current. Progress so far:\n\n${digest}\n\nMost recent result(s):\n${combined}${stopNote}${nudge}\n\nWhat is the next action? Respond with JSON only.`;
    } else {
      nextPrompt = `${combined}${stopNote}${nudge}\n\nWhat is the next action? Respond with JSON only.`;
    }
  }

  if (outcome === "max_steps") log(`[${steps}] hit the step budget (${maxSteps}) without finishing`);
  appendEvent(p, taskId, { actor: "system", type: "decision", summary: `outcome: ${outcome}`, meta: { outcome, summary, steps } });
  store.close();
  return { taskId, outcome, summary, steps, actionCounts, compactions };
}

/** Executes one action and returns the (capped) result text to feed back as the next turn's prompt. */
async function executeAction(p: Paths, taskId: string, d: Decision, approve?: RuntimeOptions["approve"]): Promise<string> {
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
      if (/^\.narrowbit(ignore$|\/)/.test(relative(p.root, abs ?? ""))) {
        const text = `edit ${path}: refused — that's Narrowbit's own file, not part of the task`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, meta: { path } });
        return text;
      }
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
      // old/new are kept (capped, redacted) so the app can show the change inline; never re-sent to a model.
      appendEvent(p, taskId, { actor: "system", type: "edit", summary: text, meta: { path, old: redact(oldText.slice(0, 6000)), new: redact(newText.slice(0, 6000)) } });
      return text;
    }
    case "run": {
      const command = String(d.command ?? "");
      if (approve && !(await approve(command))) {
        const text = `run: the user declined \`${command}\` — do not retry it; take a different approach, or report "blocked" if you can't continue without it`;
        appendEvent(p, taskId, { actor: "user", type: "tool_result", summary: text, meta: { command, declined: true } });
        return text;
      }
      const r = await runCommand(p, command);
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

interface LeadPlan {
  steps: PlanStep[];
  files: string[];
  risks?: string;
  by: string;
}

interface LeadCtx {
  p: Paths;
  taskId: string;
  call: (o: ModelCallOptions) => Promise<ModelCallResult>;
  model: string;
  effort: string;
  role: string;
  /** Untracked files that existed before the task — excluded from the reviewed diff. */
  preexisting: Set<string>;
}

function untrackedFiles(p: Paths): string[] {
  return sh("git", ["ls-files", "--others", "--exclude-standard"], p.root).stdout.split("\n").filter((f) => f && !f.startsWith(".narrowbit/"));
}

function planMeta(plan: LeadPlan) {
  return { steps: plan.steps, files: plan.files, risks: plan.risks, by: plan.by };
}

function planFromEvents(events: Event[]): LeadPlan | null {
  const last = [...events].reverse().find((e) => e.type === "plan" && Array.isArray(e.meta?.steps));
  if (!last) return null;
  const m = last.meta as { steps: PlanStep[]; files?: string[]; risks?: string; by?: string };
  return { steps: m.steps.map((x) => ({ ...x })), files: m.files ?? [], risks: m.risks, by: m.by ?? "" };
}

/** Marks 1-based steps done; returns whether anything changed. */
function markSteps(plan: LeadPlan, nums: number[]): boolean {
  let changed = false;
  for (const n of nums) {
    const step = plan.steps[Number(n) - 1];
    if (step && step.status !== "done") {
      step.status = "done";
      changed = true;
    }
  }
  return changed;
}

function renderPlanForWorker(plan: LeadPlan): string {
  return [
    "Plan from the lead engineer (follow it, but trust the code over the plan where they disagree):",
    ...plan.steps.map((x, i) => `${i + 1}. ${x.text}`),
    plan.files.length ? `Likely files: ${plan.files.join(", ")}` : "",
    plan.risks ? `Watch out: ${plan.risks}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** One stateless call to the lead model; logs its usage under `purpose` and parses a JSON reply. */
async function leadCall(ctx: LeadCtx, purpose: "planning" | "review", system: string, prompt: string): Promise<any | null> {
  const res = await ctx.call({ cwd: ctx.p.root, systemPrompt: system, prompt, model: ctx.model, effort: ctx.effort, role: purpose });
  appendEvent(ctx.p, ctx.taskId, {
    actor: "model",
    type: "model_call",
    summary: res.isError ? `${purpose}: model call failed` : `${purpose}: ${res.text.slice(0, 120)}`,
    // A stateless call's cost is its own, not a running session total.
    tokens: { model: ctx.model, role: purpose, inputTokens: res.usage.input, cacheCreationTokens: res.usage.cacheCreate, cacheReadTokens: res.usage.cacheRead, outputTokens: res.usage.output, costUsd: res.costUsd ?? 0 },
  });
  if (res.isError) return null;
  const t = res.text.trim();
  const json = t.startsWith("{") ? t : /\{[\s\S]*\}/.exec(t)?.[0];
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

async function leadPlan(ctx: LeadCtx, taskText: string, store: ReturnType<typeof openStore>): Promise<LeadPlan | null> {
  const search = capSummary(searchText(ctx.p, store, taskText), 1500);
  const d = await leadCall(ctx, "planning", LEAD_PLAN_INSTRUCTIONS, `Task: ${taskText}\n\nRepository search results for the task:\n${search}\n\nRespond with the plan JSON.`);
  const steps = Array.isArray(d?.plan) ? d.plan.filter((x: unknown) => typeof x === "string" && x.trim()).slice(0, 8) : [];
  if (!steps.length) {
    appendEvent(ctx.p, ctx.taskId, { actor: "system", type: "blocker", summary: "lead plan unavailable — continuing without one" });
    return null;
  }
  const plan: LeadPlan = {
    steps: steps.map((text: string) => ({ text: text.trim(), status: "pending" as const })),
    files: Array.isArray(d.files) ? d.files.filter((x: unknown) => typeof x === "string").slice(0, 8) : [],
    risks: typeof d.risks === "string" && d.risks.trim() ? d.risks.trim() : undefined,
    by: ctx.model,
  };
  appendEvent(ctx.p, ctx.taskId, { actor: "model", type: "plan", summary: `plan: ${plan.steps.length} steps`, meta: planMeta(plan) });
  return plan;
}

async function leadReview(
  ctx: LeadCtx,
  goal: string,
  followUp: string | null,
  plan: LeadPlan | null,
  workerSummary: string,
): Promise<{ verdict: "approve" | "revise"; feedback: string } | null> {
  let diff = sh("git", ["diff", "HEAD", "--", ".", ":(exclude).narrowbit"], ctx.p.root).stdout;
  const untracked = untrackedFiles(ctx.p).filter((f) => !ctx.preexisting.has(f) && f !== ".narrowbitignore");
  for (const f of untracked.slice(0, 10)) {
    const abs = safeAbsPath(ctx.p, f);
    if (!abs || !existsSync(abs)) continue;
    const body = readFileSync(abs, "utf8").split("\n").slice(0, 150).map((l) => `+${l}`).join("\n");
    diff += `\n--- /dev/null\n+++ b/${f} (new file)\n${body}`;
  }
  const MAX = 16_000;
  if (diff.length > MAX) diff = diff.slice(0, MAX) + "\n… (diff truncated)";
  const lastVerify = fold(ctx.taskId, readEvents(ctx.p, ctx.taskId)).lastVerify;
  const prompt = [
    `Task: ${goal}`,
    followUp ? `Latest follow-up request: ${followUp}` : "",
    plan ? `Plan:\n${plan.steps.map((x, i) => `${i + 1}. ${x.text}`).join("\n")}` : "",
    `Worker's summary: ${workerSummary}`,
    lastVerify ? `Last verification: ${capSummary(lastVerify.summary, 400)}` : "Last verification: none run",
    `Diff:\n${redact(diff) || "(no changes)"}`,
    "Respond with the verdict JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const d = await leadCall(ctx, "review", LEAD_REVIEW_INSTRUCTIONS, prompt);
  if (d?.verdict !== "approve" && d?.verdict !== "revise") {
    appendEvent(ctx.p, ctx.taskId, { actor: "system", type: "blocker", summary: "lead review unavailable — accepting the worker's result" });
    return null;
  }
  const feedback = d.verdict === "revise" ? String(d.feedback ?? "").trim() || "The change is incomplete; re-check the task." : "";
  appendEvent(ctx.p, ctx.taskId, { actor: "model", type: "decision", summary: d.verdict === "approve" ? "lead review: approved" : `lead review: changes requested — ${feedback}`, meta: { review: d.verdict, feedback, by: ctx.model } });
  return { verdict: d.verdict, feedback };
}
