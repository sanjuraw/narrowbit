import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { loadConfig, type AgentConfig, type Paths } from "./config.js";
import { parseMentions, renderMentions, resolveMentions } from "./mentions.js";
import { checkpointNow } from "./checkpoints.js";
import { capOutput, runCommand } from "./compress.js";
import { getConnector, listConnectors } from "./connectors.js";
import { project } from "./context.js";
import { writeEvidence } from "./evidence.js";
import { appendEvent, fold, readEvents, subscribe, type Event, type PlanStep } from "./events.js";
import { indexRepo, openStore } from "./indexer.js";
import { ensureIsolated } from "./isolate.js";
import { chooseTier } from "./route.js";
import { guardNote } from "./guard.js";
import { suggestNotes } from "./memory-suggest.js";
import { callConnectorTool, listConnectorTools } from "./mcpClient.js";
import { MEMORY_TYPES, openMemory, renderMemory, type MemoryType } from "./memory.js";
import { classifyModelError, isPermanentModelError } from "./errors.js";
import { callModel, type ModelCallOptions, type ModelCallResult } from "./providers/claude-cli.js";
import { callCodex } from "./providers/codex-cli.js";
import { callAntigravity } from "./providers/antigravity-cli.js";
import { DEFAULT_TIERS, resolveEndpoint, resolveSelection, unavailableReason, type ModelTiers, type ProviderName } from "./providers/models.js";
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
{"action":"describe","server":"<connector name>","tool":"<tool name>"}
{"action":"connector","server":"<connector name>","tool":"<tool name>","args":{...}}
{"action":"done","summary":"<what changed and why it satisfies the task>"}
{"action":"ask","question":"<one focused question>","options"?:["<a likely answer>", ...up to 4]}
{"action":"blocked","reason":"<what you need that you don't have>"}

"connector" calls a tool on a connected external MCP server (GitHub, Slack, whatever is configured
— see the "Connected external tools" list below, if any; only call a server/tool named there). That list holds
names only, to keep every turn small: before calling a tool for the first time, use "describe" to get its
description and argument schema, then call it with exactly those arguments.

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
Not every task is an edit. When the task is a question or asks for advice or a recommendation ("what should we
do next?", "how does this work?"), change nothing — no edits, no commands that modify anything — read what you
need, then finish with "done" whose summary IS your answer (the actual recommendation and reasons, written out — the user sees nothing else): give
one clear recommendation and the reasons, mention the alternatives briefly, and let the user overrule you. Do not
hand the question back as a menu of choices. When you genuinely need a decision only the user can make while
doing a task (which of several reasonable approaches, a value you cannot find or infer), use "ask" — one focused
question, with up to 4 suggested answers when there are clear candidates — then continue with their answer. Ask
rarely (twice per task at most) and never for something you can decide or look up yourself. "blocked" is only for when you cannot proceed because something you
need is missing and you cannot find it yourself (a credential, a file that does not exist, an unanswerable
ambiguity in an edit) — never for "which option do you prefer?". "remember" is for what you learned from running
this repo's code and tests, not for your own recommendations or a restatement of documents the user already has.
A user may be watching. Any action may include "note": one short sentence for them — what you found or why
you're taking this step — only when it adds something; skip it on routine steps. If you were given a numbered
plan, include "steps_done":[<numbers>] on the action where you finish those steps.`;
/** Identifies these exact instructions, so a resumed session can tell it was started under older ones. */
const INSTRUCTIONS_ID = createHash("sha1").update(SYSTEM_INSTRUCTIONS).digest("hex").slice(0, 12);

/** Lead mode: model 3 plans before the loop starts and reviews the diff before "done" is accepted. */
const LEAD_PLAN_INSTRUCTIONS = `You are the lead engineer on a coding task. You don't edit code yourself: a cheaper model carries out the work one action at a time (reading files, editing, running checks), and you review its diff at the end. Write the plan it will follow.
Respond with EXACTLY ONE JSON object, no prose, no markdown fences:
{"plan":["<step>", ...],"files":["<repo-relative path likely involved>"],"risks":"<optional: the one thing most likely to go wrong>"}
2-6 steps, each one concrete, action-sized sentence naming the file or symbol where you can. No steps for reading unrelated code. The last step verifies the change. If the search results don't show where the work belongs, make finding it the first step. If a task says tests fail and must pass, the fix goes in the implementation, never the test file.`;

const LEAD_REVIEW_INSTRUCTIONS = `You are the lead engineer reviewing a cheaper model's work before it is reported to the user as done. Judge only whether the diff correctly and completely does the task, without breaking anything or editing what the task said not to touch. Don't ask for style changes, extra tests or refactors the task didn't ask for — the bar is "correct and complete", not "how you would have written it".
Respond with EXACTLY ONE JSON object, no prose:
{"verdict":"approve"} or {"verdict":"revise","feedback":"<specific: what is wrong or missing, and where>"}`;

const SCOUT_INSTRUCTIONS = `You are a research assistant on a coding task. You cannot change anything. Another engineer will do the work using only your report, so it must be complete and short.
Each turn reply with one JSON action, or a JSON array of up to ${MAX_BATCH_ACTIONS} independent ones: {"action":"read","path":"<file>","start":1,"end":80}, {"action":"grep","pattern":"<regex>","glob":"<optional glob>"}, {"action":"search","query":"<words>"}. Nothing else is allowed.
When you know enough (usually within 3-6 turns) finish with {"action":"done","summary":"<report>"}.
The report is under 350 words: the files and functions that matter with line numbers; the exact lines that look wrong or must change (quote them); what the tests expect; your best guess at the cause. Say plainly what you are unsure of. No plan and no code changes.`;

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
  /** ask action: one focused question for the user, with optional suggested answers. */
  question?: string;
  options?: string[];
  /** connector action: which configured MCP server (connectors.ts) and which of its tools. */
  server?: string;
  tool?: string;
  args?: Record<string, unknown>;
  /** One line for a user watching (rendered in the app). */
  note?: string;
  /** 1-based plan steps finished by this action. */
  steps_done?: number[];
}

/** Parses one turn's response into 1-MAX_BATCH_ACTIONS decisions: a bare action object, or a JSON
 * array of action objects (batching). Excess entries past the cap are dropped, not rejected —
 * a model that over-batches still gets the actions up to the limit rather than a wasted retry. */
/** Where a reply's output tokens went: hidden reasoning (when reported), the JSON actions, and any prose around them. */
function outputShape(res: ModelCallResult): { reasoning: number | null; textChars: number; proseChars: number } {
  const text = res.text ?? "";
  const t = text.trim();
  let json = "";
  for (const c of [t, ...balancedSlices(t)]) {
    try {
      JSON.parse(c);
      json = c;
      break;
    } catch {
      /* not this slice */
    }
  }
  return { reasoning: res.reasoningTokens ?? null, textChars: text.length, proseChars: Math.max(0, t.length - json.length) };
}

/** Every balanced JSON-looking slice ([...] or {...}) in the text, respecting strings, in order of appearance. */
function balancedSlices(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== "[" && open !== "{") continue;
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inStr = false;
    for (let k = i; k < text.length; k++) {
      const c = text[k];
      if (inStr) {
        if (c === "\\") k++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        depth--;
        if (depth === 0) {
          if (c === close) out.push(text.slice(i, k + 1));
          break;
        }
      }
    }
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Some models fall back to their own native tool-call markup instead of the requested JSON — DeepSeek's is
 * `<｜｜DSML｜｜ invoke name="read"><｜｜DSML｜｜ parameter name="path">a.ts</｜｜DSML｜｜ parameter>…`. When it is well formed we can
 * read it as the same actions; anything malformed returns nothing and the usual corrective retry follows.
 */
function parseNativeToolMarkup(text: string): Decision[] {
  const out: Decision[] = [];
  const invokeRe = /invoke\s+name="(\w+)">([\s\S]*?)(?=<[^<>]*invoke\s+name=|<\/[^<>]*invoke>|$)/g;
  for (const m of text.matchAll(invokeRe)) {
    const d: Record<string, unknown> = { action: m[1] };
    for (const pm of m[2].matchAll(/parameter\s+name="(\w+)"[^>]*>([\s\S]*?)<\/[^<>]*parameter>/g)) {
      const raw = pm[2].replace(/^\n|\n$/g, "");
      d[pm[1]] = /^\d+$/.test(raw.trim()) && ["start", "end"].includes(pm[1]) ? Number(raw.trim()) : raw;
    }
    if (typeof d.action === "string" && Object.keys(d).length > 1 || m[1] === "verify") out.push(d as unknown as Decision);
  }
  return out;
}

export function parseDecisions(text: string): Decision[] | null {
  const trimmed = text.trim();
  // Try the whole text, then every balanced [...] / {...} slice in order — not a greedy first-to-last-bracket
  // match, which breaks when the model adds prose, echoes tags like "<system>[1/2] read …", or writes two arrays.
  const candidates = [trimmed, ...balancedSlices(trimmed)];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const items: unknown[] = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as any).actions) ? (parsed as any).actions : [parsed];
    const decisions = items.filter((d): d is Decision => !!d && typeof d === "object" && typeof (d as any).action === "string");
    if (decisions.length) return decisions.slice(0, MAX_BATCH_ACTIONS);
  }
  const native = parseNativeToolMarkup(trimmed);
  return native.length ? native.slice(0, MAX_BATCH_ACTIONS) : null;
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
/**
 * True for anything inside a `.git` directory at any depth (nested repos and submodules included), in any
 * letter case — macOS's default filesystem treats `.GIT/config` as `.git/config`. Git executes settings from
 * there (`core.fsmonitor`, `core.hooksPath`, hooks) on the very next git command, and Narrowbit runs git
 * constantly (checkpoints, status, diffs), so a single edit there is arbitrary code execution that never
 * passes through command approval. Reads are refused too: `.git/config` can hold credentials in remote URLs.
 */
export function isGitInternal(relPath: string): boolean {
  return relPath.split(/[\\/]+/).some((seg) => seg.toLowerCase() === ".git");
}

export function safeAbsPath(p: Paths, path: string): string | null {
  const abs = resolve(p.root, path);
  const rel = relative(p.root, abs);
  if (rel.startsWith("..") || resolve(p.root) === abs) return null;
  if (isGitInternal(rel)) return null;
  // Judge by where the path really lands, not how it is spelled: a symlink inside the repo can point
  // anywhere, and read/edit follow it. Check the deepest part that already exists (an edit may create
  // a new file); a dangling symlink is refused outright, since writing through it creates its target.
  let probe = abs;
  for (;;) {
    let lexists = true;
    try {
      lstatSync(probe);
    } catch {
      lexists = false;
    }
    if (lexists) break;
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  try {
    const back = relative(realpathSync(p.root), realpathSync(probe));
    // Also judged by where it really lands: a symlink `x -> .git` would otherwise spell `x/config`.
    return back.startsWith("..") || isAbsolute(back) || isGitInternal(back) ? null : abs;
  } catch {
    return null;
  }
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
  /** Research in a separate conversation first: this model (from `provider`, default the main one) reads the repository and
   * returns a short report that goes to the worker. See scoutPhase. */
  scout?: { provider?: ProviderName; model: string; effort?: string; maxSteps?: number };
  /** The lead's plan and review come from this model instead of the main provider's third slot (any provider), e.g. Opus leading Codex workers. */
  leadModel?: { provider?: ProviderName; model: string; effort?: string };
  /** Only the review comes from this model (any provider): a second opinion from a different model family. Falls back to the lead if unavailable. */
  reviewer?: { provider?: ProviderName; model: string; effort?: string };
  /** Absolute paths of images/PDFs to show the model. Sent on the first call only; see attachments.ts. */
  attachments?: string[];
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
  /** Puts the model's question to the user and resolves with their answer (null = nobody can answer).
   * Unset in benchmarks and non-interactive runs: the model is told to make its best assumption instead. */
  ask?: (question: string, options: string[]) => Promise<string | null>;
  /** Aborting stops the loop before its next model call (a call already in flight finishes first). */
  signal?: AbortSignal;
  /** Lead mode: the escalate model plans up front and reviews the diff before "done". Default off — measured
   * worse than a single model on every axis (more tokens, more turns) for typical bug-fix-sized tasks; kept as an
   * option for tasks where a plan and a second look are worth the extra calls. */
  boss?: boolean;
  /** Skip the up-front plan call but still run the diff review before "done" (see the `boss` doc above). Useful with
   * `reviewer` set to a different model/provider: a cheap second opinion without the plan call's extra cost. */
  reviewOnly?: boolean;
  /** Put the lead's plan to the user before work starts (via `ask`): Approve, or Ask for changes, then one
   * revision. Needs `boss` and `ask`; a no-op otherwise (nobody to ask, or there's no plan to show). */
  planApproval?: boolean;
  /** Continue an earlier task with `taskText` as a follow-up request, in the same event log —
   * resuming its model session when it still exists, else from a deterministic digest. */
  continueTask?: string;
  /** How each turn's model tier is chosen. "rules" (default): Haiku-class until the first edit, then the executor, the
   * escalation model when stuck. "decider": ask a local Jev-style decision model (`url`, see scripts/decider_server.py)
   * from compact metadata; falls back to the rules if it is unreachable or unsure. Experimental — see bench.ts. */
  router?: { kind: "rules" | "decider"; url?: string; minConfidence?: number };
  /** Experimental, API providers only: ask for a pure JSON object reply ({"actions":[…]}) via the provider's JSON mode,
   * instead of free text that should contain JSON. Removes prose/markup around the actions; measured in bench.ts. */
  jsonActions?: boolean;
  /** Effort per tier, overriding `effort` for that tier's calls (e.g. { explore: "low" }: the cheap reading phase thinks less).
   * Claude's hidden thinking is ~2/3 of its output tokens; measured in bench.ts before it is used anywhere by default. */
  effortByTier?: Partial<Record<"explore" | "execute" | "escalate", string>>;
  /** Test-first gate (idea from ECC's TDD hook): the first edit to a non-test file is refused until a check has been run and
   * has failed (a red test), or a test file has been edited first. Off by default; measured in bench.ts. */
  testFirst?: boolean;
  /** Polled before each model call's follow-up: return true to compact now (the app's "Compact now" button). */
  compactNow?: () => boolean;
  /** Work in a throwaway git worktree instead of the folder itself (isolate.ts); nothing changes the folder until applied. */
  isolate?: boolean;
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

/** One discovery call per configured connector, in parallel, at task start only (not per turn).
 * A broken/slow connector degrades to a one-line note in the prompt, never blocks the task. */
async function discoverConnectors(): Promise<string> {
  const connectors = listConnectors();
  if (!connectors.length) return "";
  const lines = await Promise.all(
    connectors.map(async (c) => {
      try {
        const tools = await listConnectorTools(c, 8_000);
        return `- ${c.name}: ${tools.map((t) => t.name).join(", ") || "(no tools)"}`;
      } catch (e: any) {
        return `- ${c.name}: unavailable right now (${String(e?.message ?? e).slice(0, 100)})`;
      }
    }),
  );
  return `\n\nConnected external tools:\n${lines.join("\n")}`;
}

/** Which adapter a call to `provider` actually goes through — an endpoint-configured API/local server if
 * one's set for it, else the provider's own CLI adapter. The one place this branch is written, reused by
 * the main loop and by planning.ts's rootless chat, which needs a model call but not the rest of the loop. */
export function providerCallFor(prov: ProviderName, agent?: AgentConfig): (o: ModelCallOptions) => Promise<ModelCallResult> {
  const ep = resolveEndpoint(prov, agent);
  return ep ? (o: ModelCallOptions) => callOpenAICompat(ep, o) : prov === "codex" ? callCodex : prov === "antigravity" ? callAntigravity : callModel;
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
  // Isolated: code operations (read/edit/run/verify) use the worktree as their root; state (index, memory,
  // event log, config) keeps living in the real folder's .narrowbit, since those paths were fixed above.
  if (opts.isolate) p = { ...p, root: ensureIsolated(p, taskId).dir };
  let provider = opts.provider ?? "claude";
  const cfg = loadConfig(p);
  let tiers = opts.models ? { ...DEFAULT_TIERS[provider], ...opts.models } : opts.model ? { explore: opts.model, execute: opts.model, escalate: opts.model } : DEFAULT_TIERS[provider];
  const effort = opts.effort ?? "medium";
  // Refuse clearly up front (Codex without its adapter, a missing key, an unchosen model) rather
  // than silently running on a different provider or failing on the first call.
  const unavailable = unavailableReason({ provider, tiers, effort }, cfg.agent);
  if (unavailable) throw new Error(unavailable);
  const endpoint = resolveEndpoint(provider, cfg.agent);
  const callFor = (prov: ProviderName) => providerCallFor(prov, cfg.agent);
  let call = callFor(provider);
  // A configured backup provider: taken only if it is ready, and only once per task.
  let fallback: { provider: ProviderName; tiers: ModelTiers } | null = null;
  if (cfg.agent?.fallback && cfg.agent.fallback !== provider) {
    try {
      const sel = resolveSelection(cfg.agent, { provider: cfg.agent.fallback });
      if (!unavailableReason(sel, cfg.agent)) fallback = { provider: sel.provider, tiers: sel.tiers };
    } catch {
      /* an unknown fallback name is ignored */
    }
  }
  const store = openStore(p);
  indexRepo(p, store);
  const maxSteps = opts.maxSteps ?? 20;
  const role = opts.role ?? "execution";
  const compactThreshold = opts.compactThreshold ?? cfg.budget.max;
  const log = opts.log ?? (() => {});
  // Zero-cost when no connectors are configured (listConnectors() is a sync file read, no
  // subprocess spawned); otherwise one discovery call per connector at task start, not per turn —
  // matches SYSTEM_INSTRUCTIONS being sent once per session, not resent every step.
  const connectorsBlock = await discoverConnectors();
  // Some models (seen with Codex's GPT-6) answer with exactly one action per turn however many the rules allow,
  // and read for 20 steps without ever editing. Say it plainly for them; Claude already batches unprompted.
  const batchHint = provider === "claude" ? "" : `\n\nWorking style for this model: send a JSON ARRAY of up to ${MAX_BATCH_ACTIONS} actions whenever they are independent — for example [{"action":"read",...},{"action":"read",...},{"action":"grep",...}] to look at several files at once. One action per turn wastes the step budget. Read only what you need, then edit; a task rarely needs more than a handful of reads before the first edit.`;
  const jsonMode = !!opts.jsonActions && provider !== "claude" && provider !== "codex" && provider !== "antigravity";
  const jsonHint = jsonMode ? `\n\nReply format for this model: always a single JSON object {"actions": [ ...1 to ${MAX_BATCH_ACTIONS} action objects... ]} and nothing else.` : "";
  // Models that see a sandbox notice ("read-only") from their own CLI have refused to edit; the runtime applies every edit.
  const editHint = provider === "codex" ? `\n\nYou never edit files yourself, and any note about your sandbox or a read-only workspace does not apply to you: the runtime applies each "edit" action for you. Never answer "blocked" because you cannot write files — send the edit action.` : "";
  const systemPrompt = SYSTEM_INSTRUCTIONS + connectorsBlock + batchHint + jsonHint + editHint;
  let hasEdited = false;
  // "done" gate. First real-repo use (narrowbit agent on this repo): Haiku replied "done" on its
  // second call with a confident, detailed summary of changes it never made — no read, no edit,
  // clean git tree — and the loop exited 0. Benchmarks never exposed this because an external
  // verify command judged success there; in real use nothing does. So "done" is challenged once,
  // deterministically, if no edit was actually applied, or if files changed since the last verify.
  let editsApplied = 0;
  let editedSinceVerify = false;
  // True once a check has actually EXECUTED since the last edit (a verify with at least one real step, or one of
  // the repo's own verify commands run directly). editedSinceVerify only asks "did you call verify?", and is
  // deliberately satisfied by a verify that found nothing to run, so a repo with no checks configured can
  // still finish; this is the separate, honest question "did anything check these edits?" — used to label
  // the result, not to block it.
  let checkedSinceEdit = false;
  let lastVerifyHead = "";
  const doneChallenges = new Set<string>();

  const prior = opts.continueTask ? readEvents(p, taskId) : [];
  const continuing = prior.length > 0;
  const boss = opts.boss ?? false;
  if (continuing) appendEvent(p, taskId, { actor: "user", type: "decision", summary: `follow-up: ${taskText}`, meta: { followUp: taskText } });
  else
    appendEvent(p, taskId, {
      actor: "user",
      type: "decision",
      summary: "task received",
      // Untracked files that predate the task aren't its work; the lead review must not judge them.
      meta: { goal: taskText, untrackedAtStart: untrackedFiles(p) },
    });
  if (!continuing) checkpointNow(p, taskId, 0, "before any changes");
  const goal = continuing ? (fold(taskId, prior).goal ?? taskText) : taskText;
  let plan: LeadPlan | null = continuing ? planFromEvents(prior) : null;
  const firstEvent = continuing ? prior[0] : readEvents(p, taskId)[0];
  const preexisting = new Set<string>(Array.isArray(firstEvent?.meta?.untrackedAtStart) ? (firstEvent.meta.untrackedAtStart as string[]) : []);
  // A lead or reviewer on another provider gets its own call function (and so its own conversation and cache).
  const leadFor = (spec: { provider?: ProviderName; model: string; effort?: string } | undefined): LeadCtx | null => {
    if (!spec) return null;
    const sp = spec.provider ?? provider;
    const why = unavailableReason({ provider: sp, tiers: { explore: spec.model, execute: spec.model, escalate: spec.model }, effort }, cfg.agent);
    if (why) {
      log(`[lead] ${sp} is unavailable (${why}) — using the main provider's lead`);
      return null;
    }
    const f = callFor(sp);
    return { p, taskId, call: (o) => f({ ...o, claudeBin: opts.claudeBin }), model: spec.model, effort: spec.effort ?? effort, role, preexisting };
  };
  const lead: LeadCtx = leadFor(opts.leadModel) ?? { p, taskId, call, model: tiers.escalate, effort, role, preexisting, claudeBin: opts.claudeBin };
  const reviewLead: LeadCtx = leadFor(opts.reviewer) ?? lead;
  if (boss && !opts.reviewOnly && !continuing) {
    log(`[plan] (${tiers.escalate}) planning`);
    plan = await leadPlan(lead, taskText, store);
    if (plan) log(`      → ${plan.steps.length} steps`);
    if (plan && opts.planApproval && opts.ask) {
      const choice = await opts.ask(`Proposed plan:\n\n${renderPlanForWorker(plan)}`, ["Approve", "Ask for changes"]);
      if (choice === "Ask for changes") {
        const feedback = (await opts.ask("What should change about the plan?", [])) ?? "";
        log(`[plan] revising per feedback: ${feedback.slice(0, 80)}`);
        const revised = feedback.trim() ? await leadPlan(lead, `${taskText}\n\nRevise the plan: ${feedback.trim()}`, store) : null;
        if (revised) {
          plan = revised;
          log(`      → ${plan.steps.length} steps (revised)`);
        }
        appendEvent(p, taskId, { actor: "user", type: "decision", summary: revised ? "plan revised after feedback" : "asked for changes, but the plan is unchanged (no feedback given, or revising failed)" });
      } else if (choice !== null) {
        appendEvent(p, taskId, { actor: "user", type: "decision", summary: "plan approved" });
      }
      // choice === null (nobody available to ask): proceed with the original plan, same as when planApproval is off.
    }
  }

  // "@path" mentions in the task text: read straight into the first prompt, so the model never has to
  // spend a turn finding a file the user already named. Only on a fresh task — a follow-up's mentions
  // would just repeat what's already in the resumed conversation or the compaction digest.
  const mentionBlock = continuing ? "" : renderMentions(resolveMentions(p, parseMentions(taskText)));

  let scoutReport: string | null = null;
  if (opts.scout && !continuing) {
    const sp = opts.scout.provider ?? provider;
    const why = unavailableReason({ provider: sp, tiers: { explore: opts.scout.model, execute: opts.scout.model, escalate: opts.scout.model }, effort }, cfg.agent);
    if (why) log(`[scout] skipped: ${why}`);
    else {
      log(`[scout] (${sp}: ${opts.scout.model}) researching`);
      scoutReport = await scoutPhase(p, taskId, taskText, store, callFor(sp), opts.scout.model, opts.scout.effort ?? effort, opts.scout.maxSteps ?? 6, log, opts.claudeBin);
      if (scoutReport) log(`      → report ready (${estimateTokens(scoutReport)} tokens)`);
    }
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
  // What each model call was sent, itemised (kind/label/size), so the app can answer "why is this in context?"
  // and show what every step cost. Sizes are the same chars/3.6 estimate used everywhere; the exact billed
  // tokens are on the call itself.
  type Part = { kind: string; label: string; tokens: number };
  const part = (kind: string, label: string, text: string): Part => ({ kind, label, tokens: estimateTokens(text) });
  let nextParts: Part[] = [];
  const scoutBlock = scoutReport ? `Research report from a scout who has already read the code (unverified; trust the code over it, and read a file yourself before editing it):\n${scoutReport}\n\n` : "";
  let nextPrompt = `Task: ${taskText}\n\n${mentionBlock}${plan ? renderPlanForWorker(plan) + "\n\n" : ""}${scoutBlock}Respond with your first action as JSON.`;
  nextParts = [part("task", "your request", taskText), ...(mentionBlock ? [part("mentions", "files mentioned with @", mentionBlock)] : []), ...(plan ? [part("plan", "the lead's plan", renderPlanForWorker(plan))] : []), ...(scoutReport ? [part("scout", "the scout's research report", scoutReport)] : []), part("instructions", "Narrowbit's instructions (sent once per session)", systemPrompt)];
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
    // A session keeps the instructions it started with, so after an update it would go on behaving the old
    // way; resume only if those instructions are still the current ones.
    const lastCallAt = prior.lastIndexOf(last as Event);
    const compactedSince = prior.some((e, i) => i > lastCallAt && e.type === "handoff");
    const resumable = !compactedSince && lastSession && last?.meta?.provider === provider && last?.meta?.instr === INSTRUCTIONS_ID && (provider === "claude" || hasSession(lastSession));
    if (resumable) {
      sessionId = lastSession;
      freshSessionPending = false;
      cumulativeCost = Number(last?.meta?.sessionCost ?? 0);
      nextPrompt = `Follow-up request from the user: ${taskText}\n\nThe earlier work is already in the files. Respond with your next action as JSON.`;
      nextParts = [part("task", "your follow-up", taskText)];
    } else {
      const digest = digestWithMemory(p, taskId, cfg.budget.initial);
      nextParts = [part("task", "your follow-up", taskText), part("digest", "summary of the earlier work", digest), part("instructions", "Narrowbit's instructions", systemPrompt)];
      nextPrompt = `You are continuing an earlier task (original goal: ${goal}). Progress so far:\n\n${digest}\n\nNew request from the user: ${taskText}\n\nUse read/grep/search for anything you need in full. Respond with your next action as JSON.`;
    }
  }
  let reviews = 0;
  const recentActions: string[] = [];
  let lastResultHead = "";
  const asks = { n: 0 };
  const gate = { testFirst: !!opts.testFirst, sawRed: false };
  // Tokens the provider adds to every request on its own (its CLI's instructions and tool definitions), measured on the
  // first call of each session. Compaction is about the size of *our* conversation, so this part doesn't count toward it.
  let providerOverhead = 0;
  let attachmentsPending = !!opts.attachments?.length;

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
    const ruleTier = stuck ? "escalate" : hasEdited ? "execute" : "explore";
    let tierName: "explore" | "execute" | "escalate" = ruleTier;
    if (opts.router?.kind === "decider" && opts.router.url) {
      const d = await chooseTier(opts.router.url, { goal, step: steps, maxSteps, edits: editsApplied, editedSinceVerify, checksSinceEdit, sinceLastEdit, recent: recentActions, lastResult: lastResultHead });
      const sure = d && (d.confidence === null || d.confidence >= (opts.router.minConfidence ?? 0));
      if (d && sure) tierName = d.tier;
      appendEvent(p, taskId, { actor: "system", type: "decision", summary: `route: ${tierName}${d ? "" : " (decider unavailable — rules)"} — rules said ${ruleTier}`, meta: { route: { chosen: tierName, rules: ruleTier, probs: d?.probs, confidence: d?.confidence ?? null, ms: d?.ms ?? null, used: !!(d && sure) } } });
    }
    const turnModel = tiers[tierName];
    const callOpts = {
      cwd: p.root,
      systemPrompt: freshSessionPending ? systemPrompt : undefined,
      prompt: nextPrompt,
      model: turnModel,
      effort: opts.effortByTier?.[tierName] ?? effort,
      role,
      claudeBin: opts.claudeBin,
      sessionId,
      resume: !freshSessionPending,
      jsonObject: jsonMode,
      attachments: attachmentsPending ? opts.attachments : undefined,
    };
    // Tell the model when the budget is nearly gone so it wraps up (a read-only task's answer is its
    // "done" summary) instead of spending the last steps on more probing and ending with nothing.
    if (steps === maxSteps - 3 && maxSteps >= 6) {
      callOpts.prompt += `\n\nOnly 3 steps remain in the budget. Stop exploring; finish now with a "done" action whose summary is your complete answer.`;
    }
    if (attachmentsPending) {
      const names = (opts.attachments ?? []).map((f) => f.split("/").pop()!.replace(/^[0-9a-f]{8}-/, "")).join(", ");
      callOpts.prompt += `\n\nThe user attached: ${names}. Describe what matters from it in your first note, since it is only shown to you once.`;
    }
    const wasFresh = freshSessionPending;
    const sentEstimate = nextParts.reduce((a, x) => a + x.tokens, 0);
    let res = await call(callOpts);
    // A non-fatal error (timeout, killed process, no result event) is presumed transient, not a
    // real problem with the request — retry the identical call before giving up on the task.
    // One exception: a fresh (non-resumed) session-id that Claude Code reports as already in use
    // would fail identically on every retry with the same id — observed once in a 40-task run
    // (cause unconfirmed; regenerating is a cheap, safe guard either way) — so that specific error
    // gets a new random id before the retry instead of repeating the same doomed call.
    for (let transientRetries = 0; res.isError && !res.fatal && !isPermanentModelError(res.errorMessage) && transientRetries < MAX_TRANSIENT_RETRIES; transientRetries++) {
      appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: `step ${steps}: model call failed (${res.errorMessage ?? "no result"}), retrying (${transientRetries + 1}/${MAX_TRANSIENT_RETRIES})` });
      if (freshSessionPending && /session id .* already in use/i.test(res.errorMessage ?? "")) {
        sessionId = randomUUID();
        callOpts.sessionId = sessionId;
      }
      res = await call(callOpts);
    }
    if (attachmentsPending && !res.isError) attachmentsPending = false;
    // The main provider failed for a reason the backup might not share (a usage limit, rate limit, timeout or server
    // error): continue on the backup in a fresh session seeded with the deterministic digest, rather than ending
    // the task. Sign-in problems don't fall back — a different provider can't fix those, and hiding them would confuse.
    if (res.isError && fallback && classifyModelError(res.errorMessage).kind !== "auth") {
      const failedWith = res.errorMessage ?? "no result";
      const to = fallback;
      fallback = null;
      provider = to.provider;
      tiers = to.tiers;
      call = callFor(to.provider);
      sessionId = randomUUID();
      freshSessionPending = true;
      cumulativeCost = 0;
      const digest = project(fold(taskId, readEvents(p, taskId)), { budget: cfg.budget.initial });
      appendEvent(p, taskId, { actor: "system", type: "decision", summary: `fallback: ${failedWith.slice(0, 120)} — continuing on ${to.provider}`, meta: { fallback: { to: to.provider, reason: failedWith.slice(0, 300) } } });
      log(`[${steps}] main model failed (${failedWith.slice(0, 80)}) — continuing on ${to.provider}`);
      nextParts = [part("digest", "summary of the work so far (new model)", digest), part("nudge", "the step that was in progress", nextPrompt), part("instructions", "Narrowbit's instructions (resent to the backup model)", systemPrompt)];
      nextPrompt = `You are taking over this task on a different model because the previous one became unavailable. Nothing was lost — use read/grep/search again for anything you need in full. Progress so far:\n\n${digest}\n\nThe input for the step that was in progress:\n${nextPrompt}`;
      steps--;
      continue;
    }
    freshSessionPending = false;
    // Codex assigns its own thread id rather than accepting the one we requested (see
    // codex-cli.ts) — adopt whatever it actually used so the next call's --resume targets it.
    if (res.sessionId) sessionId = res.sessionId;
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
      meta: { sessionId, sessionCost: totalCost, provider, instr: INSTRUCTIONS_ID, out: outputShape(res), context: { parts: nextParts, tokens: nextParts.reduce((a, x) => a + x.tokens, 0) } },
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
      nextParts = [{ kind: "nudge", label: "asked to reply in valid JSON", tokens: 30 }];
      nextPrompt = "Your last response was not valid JSON. Respond with a single action object, or a JSON array of action objects, nothing else — no prose, no markdown fences.";
      continue;
    }
    parseRetries = 0;

    // Execute the batch in order. batchResults accumulates every executed action's result text;
    // stopReason is set (and the loop broken) the moment continuing would build on a wrong
    // assumption — an edit refused, a failed verify/command — so the tail of the batch goes
    // unexecuted rather than compounding a mistake the model hasn't seen yet.
    const batchResults: string[] = [];
    const batchLabels: string[] = [];
    let stopReason: string | null = null;
    let doneRejected: string | null = null;
    let rejectedPart: Part | null = null;
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
        // A task about an attached file can be answered from the attachment itself, with no action first.
        if (editsApplied === 0 && !opts.attachments?.length && !mentionBlock && !doneChallenges.has("no-edit")) {
          doneChallenges.add("no-edit");
          challenge = Object.keys(actionCounts).length === 0
            ? "You have not taken a single action yet — nothing has been read or changed, so the task cannot be complete. Start by reading the relevant file."
            : 'No file has been changed in this task. If the task requires a code change, you have not made it yet — continue working. If it is a question or asks for advice, reply "done" again with the full answer itself as the summary — the summary is all the user sees, so write the answer, not a description of having answered.';
        } else if (editedSinceVerify && !doneChallenges.has("no-verify")) {
          doneChallenges.add("no-verify");
          challenge = 'You changed files but have not run "verify" since your last edit. Verify before declaring done.';
        }
        if (challenge) {
          appendEvent(p, taskId, { actor: "system", type: "blocker", summary: `done rejected: ${challenge}` });
          log(`[${steps}] (${turnModel}) ${tag}done rejected — ${challenge.split(/[.—]/)[0].trim()}`);
          doneRejected = `${challenge}\n\nWhat is the next action? Respond with JSON only.`;
          rejectedPart = part("gate", "completion check (done was refused)", doneRejected);
          break;
        }
        if ((boss || opts.reviewOnly) && editsApplied > 0 && reviews < MAX_REVIEWS) {
          reviews++;
          log(`[${steps}] (${tiers.escalate}) lead review`);
          const review = await leadReview(reviewLead, goal, taskText !== goal ? taskText : null, plan, decision.summary ?? "");
          if (review?.verdict === "revise") {
            log(`      → changes requested: ${review.feedback.slice(0, 100)}`);
            // A revision reopens the verify challenge: the fix must be checked again.
            doneChallenges.delete("no-verify");
            rejectedPart = part("review", "the lead's review feedback", review.feedback);
            doneRejected = `The lead engineer reviewed your diff and asked for changes:\n${review.feedback}\n\nMake them, verify, then report done again. What is the next action? Respond with JSON only.`;
            break;
          }
          if (review) log("      → approved");
        }
        outcome = "done";
        summary = decision.summary ?? "done";
        // Finishing is allowed with no check having run (a repo may have none configured, and blocking forever
        // would trap it), but the result must not read as verified. Say so where the user will see it.
        if (editsApplied > 0 && !checkedSinceEdit) {
          const why = /NO CHECKS CONFIGURED/.test(lastVerifyHead)
            ? "this repo has no verify command configured"
            : /NO CHECKS RAN/.test(lastVerifyHead)
              ? "no configured check could run (a tool isn't installed, or the commands were declined)"
              : "verify was not run after the last edit";
          summary += `\n\n[Narrowbit: NOT verified — ${why}, so no check has confirmed these edits.]`;
          appendEvent(p, taskId, { actor: "system", type: "decision", summary: `finished with edits but no check ran: ${why}` });
        }
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
        meta: { action: decision.action, question: decision.question, options: decision.options, path: decision.path, command: decision.command, query: decision.query, pattern: decision.pattern, glob: decision.glob, start: decision.start, end: decision.end, note: decision.note, model: turnModel },
      });
      let resultText: string;
      try {
        resultText = await executeAction(p, taskId, decision, opts.approve, opts.ask, asks, gate);
      } catch (e: any) {
        resultText = `error: ${String(e?.message ?? e).slice(0, 300)}`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: resultText });
      }
      log(`      → ${resultText.split("\n")[0].slice(0, 100)}`);
      batchResults.push(`${tag}${resultText}`);
      lastResultHead = resultMeta(decision, resultText);
      recentActions.push(`${decision.action}${decision.path ? " " + decision.path : ""}${checkFailedLabel(decision, resultText)}`);
      batchLabels.push(`${decision.action}${decision.path ? ` ${decision.path}` : decision.server ? ` ${decision.server}.${decision.tool}` : decision.command ? ` ${decision.command.slice(0, 60)}` : decision.query ? ` "${decision.query.slice(0, 40)}"` : decision.pattern ? ` "${decision.pattern.slice(0, 40)}"` : ""}`);
      // executeAction returns "edited <path>" only when the file was actually written; a refused
      // edit (old text not found / not unique) doesn't count as progress for the done gate.
      const editRefused = decision.action === "edit" && !resultText.startsWith("edited ");
      if (decision.action === "edit" && !editRefused) {
        editsApplied++;
        editedSinceVerify = true;
        checkedSinceEdit = false;
        checkpointNow(p, taskId, steps, resultText.startsWith("edited ") ? resultText.slice(0, 100) : `edit ${decision.path ?? ""}`);
      }
      // Running one of the repo's own verify commands (e.g. `npm test`) and passing counts as verifying:
      // making the model repeat it through "verify" just to satisfy the done gate wastes a turn.
      const verifyCommands = Object.values(cfg.verify).filter(Boolean) as string[];
      const ranVerifyCommand = decision.action === "run" && /^\$ .*\(exit 0/.test(resultText) && verifyCommands.some((c) => (decision.command ?? "").trim() === c || (decision.command ?? "").trim() === c.replace(/ --silent$/, ""));
      if ((decision.action === "verify" && !resultText.startsWith("VERIFICATION FAILED")) || ranVerifyCommand) editedSinceVerify = false;
      if (decision.action === "verify") {
        lastVerifyHead = resultText.split("\n")[0] ?? "";
        // verify.ts only reports PASSED / FAILED when at least one check really executed; "NO CHECKS ..." covers
        // nothing configured, every check skipped (tool not installed), and every check declined.
        if (/^VERIFICATION (PASSED|FAILED)/.test(lastVerifyHead)) checkedSinceEdit = true;
      }
      if (decision.action === "run" && !resultText.startsWith("run: the user declined") && verifyCommands.some((c) => (decision.command ?? "").trim() === c || (decision.command ?? "").trim() === c.replace(/ --silent$/, ""))) checkedSinceEdit = true;
      // Only a *failed* check counts toward escalation — edit → typecheck → verify → done is normal,
      // not stuck. The markers are our own output formats: verify.ts's report header and
      // compress.ts's "$ cmd  (exit N; …)" head line.
      const checkFailed =
        (decision.action === "verify" && resultText.startsWith("VERIFICATION FAILED")) || (decision.action === "run" && /^\$ .*\(exit [1-9]/.test(resultText));
      if (checkFailed) gate.sawRed = true;
      if (decision.action === "edit" && /(\.test\.|\.spec\.|__tests__\/|(^|\/)tests?\/|_test\.)/.test(String(decision.path ?? "")) && resultText.startsWith("edited ")) gate.sawRed = true;
      if (decision.action === "edit") checksSinceEdit = 0;
      else if (checkFailed) checksSinceEdit++;
      lastCheckFailed = checkFailed;

      // Stop the batch here if what comes next in it was planned on an assumption this action
      // just disproved — anything still queued goes unexecuted, and the model sees why.
      if (editRefused) stopReason = "the edit above was refused";
      else if (decision.action === "verify" && checkFailed) stopReason = "verification failed";
      else if (decision.action === "run" && checkFailed) stopReason = "the command above exited non-zero";
      else if (decision.action === "ask") stopReason = "you asked the user a question, so their answer can shape what comes next";
      if (stopReason) break;
    }

    if (taskEnded) break;

    if (doneRejected) {
      nextPrompt = doneRejected;
      nextParts = [rejectedPart ?? part("gate", "completion check", doneRejected)];
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
    // Same models, second symptom: reading forever. A gentle nudge every few steps until the first edit.
    const readOnlyNudge = provider !== "claude" && !hasEdited && steps + 1 >= 6 && (steps + 1) % 3 === 0
      ? `\n\nYou have used ${steps + 1} steps without editing anything. If the task needs a change, you now know enough to make your best edit — make it, then verify. If it is only a question, answer it with "done".`
      : "";
    const combined = batchResults.join("\n\n") || "(no actions executed)";
    const stopNote = stopReason
      ? `\n\n(stopped the batch early — ${stopReason}; ${decisions.length - batchResults.length} planned action(s) after it were not run)`
      : "";

    const resultParts: Part[] = batchResults.map((r, i) => part("result", batchLabels[i] ?? "result", r));
    if (stopNote) resultParts.push(part("note", "the batch stopped early", stopNote));
    if (nudge) resultParts.push(part("nudge", "stall guard: stop re-running the check", nudge));
    if (readOnlyNudge) resultParts.push(part("nudge", "reminder to start editing", readOnlyNudge));
    if (steps + 1 === maxSteps - 3 && maxSteps >= 6) resultParts.push({ kind: "nudge", label: "budget warning", tokens: 30 });
    // Compact on the context the model just processed, not a fixed turn count: a task with big
    // reads compacts sooner than one with small ones, and a cheap task may never compact at all.
    const contextTokens = res.usage.input + res.usage.cacheCreate + res.usage.cacheRead;
    // Codex's CLI adds ~7-14k tokens of its own to every call; before this, it counted toward the 30k limit, so a Codex
    // task compacted (lost its conversation) almost every step, re-read the same files and rarely reached an edit.
    if (wasFresh) providerOverhead = Math.max(0, contextTokens - sentEstimate);
    const manualCompact = !!opts.compactNow?.();
    if (manualCompact || contextTokens - providerOverhead >= compactThreshold) {
      const previousSessionId = sessionId;
      sessionId = randomUUID();
      freshSessionPending = true;
      cumulativeCost = 0;
      compactions++;
      const digest = digestWithMemory(p, taskId, cfg.budget.initial);
      appendEvent(p, taskId, {
        actor: manualCompact ? "user" : "system",
        type: "handoff",
        summary: manualCompact ? `you compacted this chat after ${steps + 1} turn(s) — continuing in a fresh session` : `compacted after ${steps + 1} turn(s), ~${contextTokens} context tokens — starting a new session`,
        meta: { previousSessionId, contextTokens, manual: manualCompact },
      });
      log(`      ~ compacted (${contextTokens} context tokens) — new session`);
      nextParts = [part("digest", "summary after compacting the session", digest), ...resultParts, part("instructions", "Narrowbit's instructions (resent to the new session)", systemPrompt)];
      nextPrompt = `You are continuing this task after a context compaction. Nothing was lost, only compacted — use read/grep/search again for anything you need in full, rather than assuming what you remember is still current. Progress so far:\n\n${digest}\n\nMost recent result(s):\n${combined}${stopNote}${nudge}\n\nWhat is the next action? Respond with JSON only.`;
    } else {
      nextParts = resultParts;
      nextPrompt = `${combined}${stopNote}${nudge}${readOnlyNudge}\n\nWhat is the next action? Respond with JSON only.`;
    }
  }

  if (outcome === "done") {
    try {
      const suggested = suggestNotes(readEvents(p, taskId), openMemory(p).load().filter((e) => e.status === "active"));
      if (suggested.length) appendEvent(p, taskId, { actor: "system", type: "decision", summary: `suggested ${suggested.length} note${suggested.length === 1 ? "" : "s"} for project memory (nothing saved until you approve)`, meta: { suggested } });
    } catch {
      /* suggestions are a convenience; never fail a finished task over them */
    }
  }
  if (outcome === "max_steps") log(`[${steps}] hit the step budget (${maxSteps}) without finishing`);
  const failure = outcome === "error" ? classifyModelError(summary) : null;
  appendEvent(p, taskId, { actor: "system", type: "decision", summary: `outcome: ${outcome}`, meta: { outcome, summary, steps, ...(failure ? { errorKind: failure.kind, resets: failure.resets } : {}) } });
  store.close();
  return { taskId, outcome, summary, steps, actionCounts, compactions };
}

/** A one-line, content-free description of what an action returned — this is all the router's decision model sees. */
function resultMeta(d: Decision, result: string): string {
  const lines = result.split("\n").length;
  switch (d.action) {
    case "read": return /file not found/.test(result) ? "the file was not found" : `read ${d.path ?? "a file"} (${lines} lines)`;
    case "grep": case "search": return /no matches/i.test(result) ? "no matches" : `${Math.max(0, lines - 1)} result lines`;
    case "edit": return result.startsWith("edited ") ? "the edit was applied" : "the edit was refused";
    case "verify": return result.startsWith("VERIFICATION FAILED") ? "verification failed" : result.startsWith("VERIFICATION NO CHECKS") ? "verify ran but no checks are configured" : "verification passed";
    case "run": { const m = /\(exit (\d+)/.exec(result); return m ? (m[1] === "0" ? "the command succeeded" : `the command failed (exit ${m[1]})`) : "the command ran"; }
    default: return `${d.action} returned ${lines} line(s)`;
  }
}

/** The deterministic summary, plus what project memory holds — a pointer, not an injection: notes are still fetched only on `recall`. */
export function digestWithMemory(p: Paths, taskId: string, budget: number): string {
  const digest = project(fold(taskId, readEvents(p, taskId)), { budget });
  let active = 0;
  try {
    active = openMemory(p).load().filter((e) => e.status === "active").length;
  } catch {
    /* no memory store yet */
  }
  return active ? `${digest}\n\nPROJECT MEMORY: ${active} active note${active === 1 ? "" : "s"} exist for this repository. None are shown here; use the recall action with a topic to search them.` : digest;
}

function checkFailedLabel(d: Decision, result: string): string {
  return (d.action === "verify" && result.startsWith("VERIFICATION FAILED")) || (d.action === "run" && /^\$ .*\(exit [1-9]/.test(result)) ? " (failed)" : "";
}

/** Executes one action and returns the (capped) result text to feed back as the next turn's prompt. */
async function executeAction(p: Paths, taskId: string, d: Decision, approve?: RuntimeOptions["approve"], ask?: RuntimeOptions["ask"], asks?: { n: number }, gate?: { testFirst: boolean; sawRed: boolean }): Promise<string> {
  switch (d.action) {
    case "ask": {
      const question = String(d.question ?? "").trim();
      if (!question) return "ask: needs a \"question\"";
      if (asks && asks.n >= 2) {
        const text = "ask: you have already asked twice in this task — decide with your best judgement, say what you assumed, and continue";
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text });
        return text;
      }
      if (asks) asks.n++;
      const options = Array.isArray(d.options) ? d.options.map((o) => String(o)).filter(Boolean).slice(0, 4) : [];
      const answer = ask ? await ask(question, options) : null;
      if (answer === null) {
        const text = "ask: nobody is available to answer right now — make the most reasonable assumption, state it clearly in your final answer, and continue";
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text });
        return text;
      }
      const text = `The user answered: ${answer}`;
      appendEvent(p, taskId, { actor: "user", type: "tool_result", summary: text, meta: { question, answer } });
      return text;
    }
    case "read": {
      const path = String(d.path ?? "");
      if (isGitInternal(path)) {
        const text = `read ${path}: refused — files inside .git are git's own internals, not part of the task`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, meta: { path } });
        return text;
      }
      const abs = safeAbsPath(p, path);
      if (!abs || !existsSync(abs)) {
        const text = `read ${path}: file not found`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, meta: { path } });
        return text;
      }
      if (readFileSync(abs).subarray(0, 4096).includes(0)) {
        const text = `read ${path}: binary file — it can't be read as text. Images and PDFs the user attached were shown to you with their first message; work from what you noted then.`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, meta: { path } });
        return text;
      }
      const lines = readFileSync(abs, "utf8").split("\n").length;
      const start = d.start ?? 1;
      const end = d.end ?? lines;
      const raw = readLines(p.root, path, start, end);
      // capSummary()'s generic "ask again with a narrower range" leaves the model guessing where the cut
      // fell — on a file too big for one read, it can't tell how many lines it actually got, so a naive
      // "keep reading further" retry either re-covers ground it already saw or skips ahead blind. Both were
      // observed live: a 293-line file cost 10 read turns, most of them re-reading overlapping tails.
      // Telling it the exact next line lets it resume precisely, in one further read instead of guessing.
      const capped = capSummary(raw);
      const truncated = capped.length < raw.length;
      // -1 rather than the raw segment count: the cut usually falls mid-line, so the last segment shown is
      // only a partial line — resuming there re-shows a short duplicated prefix, which beats silently
      // dropping the rest of that line forever.
      const nextStart = truncated ? start + capped.slice(0, capped.lastIndexOf("\n… (truncated")).split("\n").length - 1 : null;
      const capText = truncated ? capped.slice(0, capped.lastIndexOf("\n… (truncated")) + `\n… (truncated here — this file has ${lines} lines; continue with start:${nextStart} if you need the rest)` : capped;
      const text = `read ${path}:${start}-${end}\n${capText}${guardNote(capText)}`;
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
      const isTestPath = /(\.test\.|\.spec\.|__tests__\/|(^|\/)tests?\/|_test\.)/.test(path);
      if (gate?.testFirst && !gate.sawRed && !isTestPath) {
        const text = `edit ${path}: refused (test-first mode) — no check has failed yet. Run "verify" (or the failing test) first and confirm it fails, or write the failing test, then make this edit.`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, meta: { path, testFirst: true } });
        return text;
      }
      if (/^\.narrowbit(ignore$|\/)/.test(relative(p.root, abs ?? ""))) {
        const text = `edit ${path}: refused — that's Narrowbit's own file, not part of the task`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, meta: { path } });
        return text;
      }
      if (isGitInternal(path) || (!abs && isGitInternal(relative(p.root, resolve(p.root, path))))) {
        const text = `edit ${path}: refused — files inside .git are git's own internals, not part of the task (and git would execute some of them)`;
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
      const capped = capOutput(r.rendered);
      const handle = writeEvidence(p, taskId, "command", r.rendered, capped);
      appendEvent(p, taskId, { actor: "system", type: "command", summary: capped, evidenceRef: handle.id, meta: { command: d.command, exit: r.exit } });
      return capped;
    }
    case "verify": {
      const cfg = loadConfig(p);
      const store = openStore(p);
      const v = await verify(p, cfg, store, null, { approve });
      store.close();
      const capped = capOutput(v.report);
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
    case "describe": {
      const serverName = String(d.server ?? "");
      const toolName = String(d.tool ?? "");
      const connector = getConnector(serverName);
      if (!connector) {
        const text = `describe: no connector named "${serverName}" is configured`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text });
        return text;
      }
      try {
        const tools = await listConnectorTools(connector, 15_000);
        const t = tools.find((x) => x.name === toolName);
        const text = t
          ? `${serverName}.${t.name}: ${t.description ?? "(no description)"}\narguments (JSON schema): ${capSummary(JSON.stringify(t.inputSchema ?? {}))}`
          : `describe: ${serverName} has no tool "${toolName}". Its tools: ${tools.map((x) => x.name).join(", ")}`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, meta: { server: serverName, tool: toolName } });
        return text;
      } catch (e: any) {
        const text = `describe ${serverName}.${toolName}: failed — ${String(e?.message ?? e).slice(0, 300)}`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text });
        return text;
      }
    }
    case "connector": {
      const serverName = String(d.server ?? "");
      const toolName = String(d.tool ?? "");
      const connector = getConnector(serverName);
      if (!connector) {
        const text = `connector: refused — no connector named "${serverName}" is configured (narrowbit connectors list)`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text });
        return text;
      }
      // Anything an external service can do (create an issue, post a message) leaves this machine, so like a
      // shell command it waits for the user's OK wherever approvals are on.
      const label = `connector: ${serverName}.${toolName} ${redact(JSON.stringify(d.args ?? {})).slice(0, 300)}`;
      if (approve && !(await approve(label))) {
        const text = `connector: the user declined ${serverName}.${toolName} — do not retry it; take a different approach or ask the user`;
        appendEvent(p, taskId, { actor: "user", type: "tool_result", summary: text, meta: { server: serverName, tool: toolName, declined: true } });
        return text;
      }
      try {
        const r = await callConnectorTool(connector, toolName, d.args ?? {});
        // Every other action (read/grep/search/run) redacts at its source (package.ts/query.ts/
        // compress.ts) before capSummary/writeEvidence ever see it — an external connector's output
        // is the one kind of text this runtime doesn't control the origin of, so it needs the same
        // treatment explicitly here, not just writeEvidence's own internal redact() of the disk copy
        // (which wouldn't cover the text that re-enters the model's context or the visible event log).
        const cleaned = redact(r.text);
        const capped = capOutput(cleaned);
        const text = `${serverName}.${toolName}${r.isError ? " (error)" : ""}:\n${capped}${guardNote(capped)}`;
        const handle = writeEvidence(p, taskId, "other", cleaned, capped);
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text, evidenceRef: handle.id, meta: { server: serverName, tool: toolName } });
        return text;
      } catch (e: any) {
        const text = `${serverName}.${toolName}: failed — ${String(e?.message ?? e).slice(0, 300)}`;
        appendEvent(p, taskId, { actor: "system", type: "tool_result", summary: text });
        return text;
      }
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
  claudeBin?: string;
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
  const res = await ctx.call({ cwd: ctx.p.root, systemPrompt: system, prompt, model: ctx.model, effort: ctx.effort, role: purpose, claudeBin: ctx.claudeBin });
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

/**
 * Research in a separate conversation. A cheaper model (any provider) reads the repository on its own and hands back a short
 * report; only that text goes to the worker. Keeping the scout's many reads out of the worker's conversation matters twice:
 * they are never billed again at the worker's price, and no model is swapped inside a conversation (a prompt cache belongs
 * to one model, so swapping rewrites it). Returns null if the scout fails; the task then just runs without a report.
 */
async function scoutPhase(p: Paths, taskId: string, taskText: string, store: ReturnType<typeof openStore>, call: (o: ModelCallOptions) => Promise<ModelCallResult>, model: string, effort: string, maxSteps: number, log: (l: string) => void, claudeBin?: string): Promise<string | null> {
  let sessionId: string = randomUUID();
  let resume = false;
  let prompt = `Task: ${taskText}\n\nRepository search results for the task:\n${capSummary(searchText(p, store, taskText), 1200)}\n\nRespond with your first action(s) as JSON.`;
  let report: string | null = null;
  for (let i = 0; i <= maxSteps && !report; i++) {
    const last = i === maxSteps;
    if (last) prompt += `\n\nNo more research steps. Reply now with {"action":"done","summary":"<your report>"} from what you have.`;
    const res = await call({ cwd: p.root, systemPrompt: resume ? undefined : SCOUT_INSTRUCTIONS, prompt, model, effort, role: "scouting", sessionId, resume, claudeBin });
    appendEvent(p, taskId, {
      actor: "model",
      type: "model_call",
      summary: res.isError ? "scouting: model call failed" : `scouting: ${res.text.slice(0, 100)}`,
      tokens: { model, role: "scouting", inputTokens: res.usage.input, cacheCreationTokens: res.usage.cacheCreate, cacheReadTokens: res.usage.cacheRead, outputTokens: res.usage.output, costUsd: res.costUsd ?? 0 },
    });
    if (res.isError) break;
    if (res.sessionId) sessionId = res.sessionId;
    resume = true;
    const ds = parseDecisions(res.text);
    if (!ds) {
      prompt = `That was not valid JSON. Reply with JSON action(s) only.`;
      continue;
    }
    const results: string[] = [];
    for (const d of ds.slice(0, MAX_BATCH_ACTIONS)) {
      if (d.action === "done") {
        report = String(d.summary ?? "").trim().slice(0, 3000) || null;
        break;
      }
      if (d.action !== "read" && d.action !== "grep" && d.action !== "search") {
        results.push(`${d.action}: not allowed while researching — only read, grep and search`);
        continue;
      }
      log(`      scout: ${d.action} ${d.path ?? d.pattern ?? d.query ?? ""}`);
      results.push(await executeAction(p, taskId, d));
    }
    prompt = `${results.join("\n\n")}\n\nContinue, or finish with done.`;
  }
  if (report) appendEvent(p, taskId, { actor: "model", type: "tool_result", summary: `scout report (${model}): ${report.slice(0, 200)}`, meta: { scout: true, report } });
  else appendEvent(p, taskId, { actor: "system", type: "blocker", summary: "scout gave no report — continuing without one" });
  return report;
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
