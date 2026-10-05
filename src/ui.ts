import { randomBytes, timingSafeEqual } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, lstatSync, readlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, basename, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { attachmentDir, attachmentKind, saveAttachment } from "./attachments.js";
import { suggestFiles } from "./mentions.js";
import { ensureDirs, loadConfig, paths, saveConfig, type AgentConfig, type Paths } from "./config.js";
import { getConnector, listConnectors, publicConnector, removeConnector, saveConnector } from "./connectors.js";
import { completeSignIn, signOut, startSignIn } from "./oauth.js";
import { applyIsolated, discardIsolated, readIsolated } from "./isolate.js";
import { listCheckpoints, restoreCheckpoint } from "./checkpoints.js";
import { createProjectFromDraft, draftsPaths, planningReply, tooBroadForProject } from "./planning.js";
import { findSkills } from "./skillimport.js";
import { appendEvent, fold, forkTask, readEvents, type Event } from "./events.js";
import { changedSince, createGithubRepo, githubIdentity, gitState, pushBranch, remoteInfo } from "./git.js";
import { listConnectorTools } from "./mcpClient.js";
import { initProject } from "./project.js";
import { keySource, setKey } from "./keys.js";
import { readLimits, refreshClaude, refreshCodex } from "./limits.js";
import { checkReadiness, formatReadiness } from "./readiness.js";
import { auditRepo } from "./audit.js";
import { openMemory } from "./memory.js";
import { redact } from "./redact.js";
import {
  availableModels,
  DEFAULT_TIERS,
  EFFORT_LEVELS,
  isProvider,
  PHASES,
  PROVIDER_INFO,
  PROVIDERS,
  resolveEndpoint,
  resolveSelection,
  unavailableReason,
  type ModelList,
  type ProviderName,
  parseScout,
} from "./providers/models.js";
import { providerCallFor, runTask } from "./runtime.js";
import { acknowledgeUpdateNotes, applyUpdate, checkUpdate, pendingUpdateNotes, readVersion } from "./update.js";
import { listSkills, removeSkill, saveSkill } from "./skills.js";
import { uiPage } from "./ui-page.js";
import { sh, visible, writeProjectFile, removeProjectPath, stateText } from "./util.js";
import { updateCli } from "./providers/models.js";
import { covered, editsSince, type Grant } from "./approvals.js";
import { suggestFollowUp, suggestionFromEvents } from "./followup.js";
import { shippedRisks, trustConfig, trustRepo, untrustedMessage, untrustedReason } from "./trust.js";
import { discardTask, planDiscard } from "./checkpoints.js";

/**
 * `narrowbit ui`: the app. A local HTTP server (127.0.0.1 only) that drives the same runTask()
 * as `narrowbit agent`, plus what a terminal does badly — approving each command before it runs,
 * reviewing the diff, then committing or discarding. The macOS app (mac/) is a window around this.
 *
 * Every API call needs the per-launch token (header, or ?t= for the event stream) and a loopback
 * Host header, so other web pages open in a browser can't drive it (CSRF / DNS rebinding).
 */

type StreamEvent = (
  | { type: "start"; task: string; continueTask: string | null; selection: string; lead: boolean }
  | { type: "log"; line: string }
  | { type: "event"; event: Event }
  | { type: "approval"; id: string; command: string; warning?: string; key?: string; editLen?: number; changes?: string[] }
  | { type: "approval_resolved"; id: string; allowed: boolean }
  | { type: "question"; id: string; question: string; options: string[] }
  | { type: "question_resolved"; id: string; answer: string | null }
  | { type: "finished"; outcome: string; summary: string; steps: number; taskId: string; changed: string[]; tokens: number; costUsd: number; suggestion?: string | null }
  | { type: "failed"; error: string }
) & { run?: string; task?: string | null };

interface Run {
  /** Identifies this run on the event stream (several can be live at once). */
  id: string;
  root: string;
  events: StreamEvent[];
  controller: AbortController;
  pending: Map<string, (allowed: boolean) => void>;
  /** Questions the agent has put to the user, waiting for an answer. */
  questions: Map<string, (answer: string | null) => void>;
  /** Commands the user allowed for the rest of this task. */
  /** "Allow for this task" grants by command (or connector-call key); see approvals.ts for when one still covers it. */
  allowed: Map<string, Grant>;
  running: boolean;
  /** Messages typed while the task was working, handed to it before its next model call. */
  queue: string[];
  /** Set by the app's "Compact now"; the loop takes it before its next call and starts a fresh session. */
  compactRequested: boolean;
  /** Untracked files that existed before the run — Discard never deletes these. */
  untrackedBefore: Set<string>;
  taskId: string | null;
}

const RECENT_FILE = join(homedir(), ".narrowbit", "recent-repos.json");

function loadRecent(): string[] {
  try {
    return (JSON.parse(readFileSync(RECENT_FILE, "utf8")) as string[]).filter((r) => existsSync(r));
  } catch {
    return [];
  }
}

function saveRecent(root: string) {
  const list = [root, ...loadRecent().filter((r) => r !== root)].slice(0, 12);
  mkdirSync(join(homedir(), ".narrowbit"), { recursive: true, mode: 0o700 });
  writeFileSync(RECENT_FILE, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
}

/** A folder → the repository it belongs to (git toplevel), or the folder itself. */
function repoRootOf(dir: string): string {
  const g = sh("git", ["rev-parse", "--show-toplevel"], dir);
  return g.code === 0 && g.stdout.trim() ? g.stdout.trim() : dir;
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        rej(new Error("request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        rej(new Error("invalid JSON body"));
      }
    });
    req.on("error", rej);
  });
}

/** Defence in depth for a page that only ever runs on loopback: no sniffing, no framing, no referrer. */
/** The app token compared in constant time (a plain `!==` stops at the first differing character). */
function tokenMatches(given: unknown, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const SEC_HEADERS = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SEC_HEADERS });
  res.end(JSON.stringify(body));
}

/** `tag` identifies which project/draft-space a row belongs to, for the merged cross-project list below. */
function taskHistory(p: Paths, limit = 40, tag?: { project: string; root: string | null }) {
  if (!existsSync(p.runtime)) return [];
  const rows = [];
  for (const id of readdirSync(p.runtime)) {
    const events = readEvents(p, id);
    if (!events.length) continue;
    const state = fold(id, events);
    const roles = Object.values(state.ledgerByRole);
    // runtime.ts ends every run (and every follow-up) with an outcome event; older logs don't have one.
    const end = [...events].reverse().find((e) => e.type === "decision" && typeof e.meta?.outcome === "string");
    const done = [...events].reverse().find((e) => e.type === "decision" && e.summary.startsWith("done: "));
    let title = "";
    title = (stateText(dirname(p.nb), join(p.runtime, id, "title.txt")) ?? "").trim();
    rows.push({
      id,
      goal: title || (state.goal ?? "(no goal recorded)"),
      at: events[0].at,
      last: events[events.length - 1].at,
      outcome: (end?.meta?.outcome as string) ?? (done ? "done" : "unfinished"),
      turns: events.filter((e) => e.actor === "user" && e.type === "decision").length,
      files: state.filesTouched,
      tokens: roles.reduce((a, r) => a + r.inputTokens + r.cacheCreationTokens + r.cacheReadTokens + r.outputTokens, 0),
      costUsd: roles.reduce((a, r) => a + r.costUsd, 0),
      ...(tag ? { project: tag.project, projectRoot: tag.root } : {}),
    });
  }
  return rows.sort((a, b) => b.last.localeCompare(a.last)).slice(0, limit);
}

/**
 * Conversations across every recent project plus rootless planning drafts, merged into one list sorted by
 * recency — like Claude.ai's single chat list, rather than only ever showing whichever one project happens
 * to be open right now. Each recent project's own event logs are small, and this already re-scans the
 * *current* project's full history on every state() call (unchanged from before); scanning a further
 * handful of recent ones on top is the same order of work, not a new class of cost.
 */
const trustMemo = new Map<string, { stamp: string; ok: boolean }>();
/** Whether a recent project is one the user has accepted as it is now. It costs a few git calls, so the answer is kept until
 * the repository itself changes (its index or HEAD — any commit, pull or `git add -f`) or its .narrowbit/ folder does. */
function recentIsTrusted(r: string): boolean {
  const mtime = (f: string) => { try { return String(statSync(f).mtimeMs); } catch { return "-"; } };
  const stamp = [join(r, ".git", "index"), join(r, ".git", "HEAD"), join(r, ".narrowbit")].map(mtime).join("|");
  const hit = trustMemo.get(r);
  if (hit && hit.stamp === stamp) return hit.ok;
  const ok = !untrustedReason(r);
  trustMemo.set(r, { stamp, ok });
  return ok;
}

function mergedHistory(root: string | null, limit = 40) {
  const rows = taskHistory(draftsPaths(), limit, { project: "Planning", root: null });
  for (const r of loadRecent().slice(0, 10)) {
    if (r === root || !existsSync(r)) continue; // the open project's own history is added by the caller, already tagged
    const p = paths(r);
    if (!existsSync(p.db)) continue; // not a Narrowbit project (never initialized) — nothing to scan
    if (!recentIsTrusted(r)) continue; // its task logs aren't shown until the project has been accepted again
    rows.push(...taskHistory(p, limit, { project: basename(r), root: r }));
  }
  return rows.sort((a, b) => b.last.localeCompare(a.last)).slice(0, limit);
}

/** "EACCES: permission denied, mkdir '/x/.narrowbit'" means nothing to most people; say what it is and what to do. */
function friendlyFsError(e: any): string {
  const msg = String(e?.message ?? e);
  if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "EROFS") {
    const where = typeof e.path === "string" ? e.path.replace(/\/\.narrowbit(\/.*)?$/, "") : "";
    return `This account can't write to ${where || "that folder"}, and Narrowbit keeps its notes in a .narrowbit folder inside the project. It probably belongs to another user on this Mac. Open a folder you own (a copy of the project works), or ask its owner to give you write access.`;
  }
  return msg;
}

/** Untracked files that existed before a task started (runtime.ts records them in its first event). */
function untrackedAtStart(p: Paths, taskId: string | null): Set<string> | null {
  if (!taskId || !/^rt-[\w-]+$/.test(taskId)) return null;
  const first = readEvents(p, taskId)[0];
  return Array.isArray(first?.meta?.untrackedAtStart) ? new Set(first.meta.untrackedAtStart as string[]) : null;
}

/** Added/removed line counts per changed file (new files count every line as added). */
function diffStats(root: string, files: string[]): Record<string, { added: number; removed: number }> {
  const out: Record<string, { added: number; removed: number }> = {};
  for (const line of sh("git", ["diff", "HEAD", "--numstat", "-z", "--no-renames", "--", ".", ":(exclude).narrowbit"], root).stdout.split("\0")) {
    const [a, r, file] = line.split("\t");
    if (file) out[file] = { added: Number(a) || 0, removed: Number(r) || 0 };
  }
  for (const f of files) {
    if (out[f]) continue;
    try {
      out[f] = { added: lstatSync(join(root, f)).isSymbolicLink() ? 1 : readFileSync(join(root, f), "utf8").split("\n").length, removed: 0 };
    } catch {
      out[f] = { added: 0, removed: 0 };
    }
  }
  return out;
}

/** Working-tree changes against HEAD, including new files, as one unified-diff-ish text. */
function workingDiff(root: string, skipUntracked: Set<string> = new Set()) {
  const g = gitState(root);
  if (!g.head) return { files: [] as string[], stats: {}, diff: "", skipped: [] as string[] };
  const skip = (f: string) => f.startsWith(".narrowbit/") || f === ".narrowbitignore" || skipUntracked.has(f);
  const files = changedSince(root, g.head).filter((f) => !skip(f));
  let diff = sh("git", ["diff", "HEAD", "--", ".", ":(exclude).narrowbit"], root).stdout;
  for (const f of g.untracked) {
    if (skip(f)) continue;
    const abs = join(root, f);
    let body = "";
    try {
      // git would add a link as a link: show it as one. Reading through it would put a file from outside the project
      // (whatever it points at) into the preview.
      const buf = lstatSync(abs).isSymbolicLink() ? Buffer.from(`(symbolic link to ${readlinkSync(abs)})`) : readFileSync(abs);
      body = buf.includes(0) ? "(binary file)" : buf.toString("utf8").split("\n").slice(0, 400).map((l) => `+${l}`).join("\n");
    } catch {
      continue;
    }
    diff += `diff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n${body}\n`;
  }
  const MAX = 400_000;
  return {
    files,
    stats: diffStats(root, files),
    diff: diff.length > MAX ? diff.slice(0, MAX) + "\n… diff truncated" : diff,
    skipped: g.untracked.filter((f) => skipUntracked.has(f) && f !== ".narrowbitignore"),
  };
}

export interface UiOptions {
  root: string | null;
  port: number;
  /** Exit with code 75 after an update so the macOS app (which relaunches on 75) loads the new code. */
  restartOnUpdate?: boolean;
  onListening: (url: string) => void;
}

export function startUi(opts: UiOptions) {
  const token = randomBytes(24).toString("hex");
  let root: string | null = opts.root && existsSync(opts.root) ? repoRootOf(opts.root) : (loadRecent()[0] ?? null);
  // Don't silently reopen (and run git in) a repo whose filter programs were never trusted; it opens from the
  // folder picker instead, which asks first.
  if (root && untrustedReason(root)) root = null;
  // A folder opened by cwd/CLI at launch (not through /api/repo) wasn't otherwise recorded — record it now,
  // so leaving it later (Start without a folder, or "New task" going rootless) still finds it in recents.
  if (root) saveRecent(root);
  // Several conversations can run at once (like the Claude app): one Run per live task, each with its own approvals,
  // questions and stop. Two runs in the same folder would edit the same files, so a second one there is isolated.
  const runs = new Map<string, Run>();
  const runningRuns = () => [...runs.values()].filter((r) => r.running);
  const runOfTask = (id: string | null | undefined) => (id ? runningRuns().find((r) => r.taskId === id) ?? null : null);
  const rootBusy = (r: string | null = root) => !!r && runningRuns().some((x) => x.root === r);
  const MAX_RUNS = 4;
  const clients = new Set<ServerResponse>();
  const modelCache = new Map<string, { at: number; list: ModelList }>();

  const preexisting = (taskId?: string | null) =>
    (root ? untrackedAtStart(paths(root), taskId ?? runningRuns().find((r) => r.root === root)?.taskId ?? null) : null) ?? (runOfTask(taskId)?.untrackedBefore ?? runningRuns().find((r) => r.root === root)?.untrackedBefore ?? new Set<string>());
  const broadcast = (e: StreamEvent) => {
    const frame = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  const emit = (r: Run, e: StreamEvent) => {
    const full = { ...e, run: r.id, task: r.taskId } as StreamEvent;
    r.events.push(full);
    broadcast(full);
  };

  // Found live: a project folder renamed out from under a running task made a background command's own
  // log-write throw ENOENT from inside a child process's 'close' callback — outside any promise chain a
  // caller could .catch(), so it reached Node as an uncaught exception and took down the entire app ("the
  // engine stopped"), not just that one command. Node's own guidance is that an uncaught exception may
  // leave the process in an inconsistent state and the safest thing is to log and exit — but this server's
  // state (root, the current run, connected clients) is plain in-memory data untouched by an isolated
  // failure like a stray filesystem error in one background callback, and a desktop app crashing outright
  // over one bad command is a far worse outcome than logging it and continuing. Every write this server
  // itself controls should still be guarded at the source (see compress.ts's own fix alongside this one) —
  // this is the backstop for whatever the next one turns out to be, not a replacement for that.
  const onFatal = (label: string) => (err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`narrowbit ui: ${label}: ${msg}\n`);
    for (const r of runningRuns()) {
      emit(r, { type: "failed", error: `Narrowbit hit an internal error and had to stop this task: ${err instanceof Error ? err.message : String(err)}` });
      r.running = false;
    }
  };
  process.on("uncaughtException", onFatal("uncaught exception"));
  process.on("unhandledRejection", onFatal("unhandled rejection"));

  const buildProviders = (agent: AgentConfig | undefined) => {
    // Model lists are fetched separately (/api/models): some are network calls, and only the
    // provider on screen needs one.
    // Codex's login state can't be checked synchronously here (it's a subprocess call) — reuse
    // whatever the limits refresh already learned (GET /api/limits keeps it fresh, ~2min TTL) so
    // the provider picker can say "not logged in" up front instead of only failing mid-task.
    const codexLoginError = readLimits().codex?.error;
    return Object.fromEntries(
      PROVIDERS.map((prov) => {
        const info = PROVIDER_INFO[prov];
        const s = resolveSelection(agent, { provider: prov });
        const ep = resolveEndpoint(prov, agent);
        return [
          prov,
          {
            ...info,
            tiers: s.tiers,
            defaults: DEFAULT_TIERS[prov],
            baseUrl: ep?.baseUrl ?? null,
            needsKey: ep?.needsKey ?? false,
            keySource: info.kind === "subscription" ? null : keySource(prov, agent?.endpoints?.[prov]?.keyEnv ?? info.keyEnv),
            unavailable: prov === "codex" && codexLoginError?.includes("not logged in") ? "Codex isn't logged in — run `codex login` in a terminal, then try again." : unavailableReason(s, agent),
          },
        ];
      }),
    );
  };

  /** Version, setup and recent problems as plain text a user can paste into a bug report. Paths and secrets removed. */
  const diagnostics = async (): Promise<string> => {
    const v = readVersion();
    const u = await checkUpdate(false);
    const r = await checkReadiness(false);
    const lines = [
      "Narrowbit diagnostics",
      `version: ${v.version || "unknown"} (${v.commit || "unknown commit"})`,
      `system: ${process.platform} ${process.arch}, node ${process.version}`,
      `update: ${u.supported ? (u.behind ? `${u.behind} newer commit(s) on GitHub` : "up to date") : (u.reason ?? "unavailable")}`,
      "",
      formatReadiness(r),
      "",
    ];
    if (root) {
      const cfg = loadConfig(paths(root));
      const sel = resolveSelection(effAgent(cfg));
      lines.push(`provider: ${sel.provider}  models: ${PHASES.map((ph) => sel.tiers[ph] || "?").join(" / ")}  effort: ${sel.effort}  lead mode: ${effAgent(cfg)?.boss ?? false}`);
      lines.push(`connectors: ${listConnectors().map((c) => c.name).join(", ") || "none"}   skills: ${listSkills(paths(root)).length}`);
      const problems = taskHistory(paths(root), 10).filter((t) => t.outcome === "error" || t.outcome === "blocked").slice(0, 5);
      lines.push("", "recent problems:");
      if (!problems.length) lines.push("  none");
      for (const t of problems) {
        const last = [...readEvents(paths(root), t.id)].reverse().find((e) => e.type === "decision" && typeof e.meta?.outcome === "string");
        lines.push(`  ${t.at.slice(0, 16)}  ${t.outcome}: ${String(last?.meta?.summary ?? "").slice(0, 200)}`);
      }
    } else lines.push("no folder open");
    return redact(lines.join("\n")).split(homedir()).join("~");
  };

  // Model choices made before any folder is open (or in a repo that has none yet) live here, so the picker
  // works on a fresh profile and new repos start from the last choice.
  const GLOBAL_AGENT = join(homedir(), ".narrowbit", "agent-defaults.json");
  const globalAgent = (): AgentConfig | undefined => {
    try { return JSON.parse(readFileSync(GLOBAL_AGENT, "utf8")); } catch { return undefined; }
  };
  const effAgent = (cfg: { agent?: AgentConfig }): AgentConfig | undefined => cfg.agent ?? globalAgent();

  const state = () => {
    // The open project's folder was renamed or moved outside Narrowbit (or is on a drive that's not
    // mounted right now) — root is still set, but nothing on disk backs it any more. Unlike Claude Code,
    // which just runs inside a live shell process whose cwd survives a rename (tied to the inode, not the
    // path), Narrowbit is a long-running server that remembers the project as a path string across app
    // restarts — so a rename breaks that string with no way to notice except checking. Report it plainly
    // instead of letting every git/file call downstream fail with a raw, confusing error.
    const missingRoot = root && !existsSync(root) ? root : null;
    if (!root || missingRoot) {
      // No repository yet: settings are per-repo so nothing can be saved, but the provider/model
      // lists must still render or the picker looks empty on a fresh profile.
      const ga = globalAgent();
      let selection;
      try { selection = resolveSelection(ga); } catch { selection = resolveSelection(undefined); }
      return { root: null, missingRoot, recent: loadRecent(), version: readVersion(), selection, providers: buildProviders(ga), phases: PHASES, efforts: EFFORT_LEVELS, lead: ga?.boss ?? false, reviewOnly: !!ga?.reviewOnly, planApproval: !!ga?.planApproval, fallback: ga?.fallback ?? "", scout: ga?.scout ?? "", connectors: listConnectors().map(publicConnector), skills: [], history: mergedHistory(null) };
    }
    const p = paths(root);
    const initialized = existsSync(p.db);
    // A folder another account owns (a shared Mac) can be opened but not written: Narrowbit keeps its notes in
    // <folder>/.narrowbit, so say so up front instead of failing on the first task with a raw EACCES.
    let writable = true;
    try {
      accessSync(initialized ? p.nb : root, fsConstants.W_OK);
    } catch {
      writable = false;
    }
    const owner = writable ? "" : sh("stat", ["-f", "%Su", root], root).stdout.trim();
    const g = gitState(root);
    const cfg = loadConfig(p);
    let selection;
    let selectionError: string | null = null;
    try {
      selection = resolveSelection(effAgent(cfg));
    } catch (e: any) {
      selectionError = e.message;
      selection = resolveSelection(undefined);
    }
    const providers = buildProviders(effAgent(cfg));
    return {
      root,
      version: readVersion(),
      name: basename(root),
      recent: loadRecent(),
      initialized,
      writable,
      owner,
      remote: g.isRepo ? remoteInfo(root) : { hasRemote: false, upstream: null, ahead: 0 },
      git: { isRepo: g.isRepo, branch: g.branch, head: g.head?.slice(0, 7) ?? null, changed: [...new Set([...g.dirty, ...g.staged])], untracked: g.untracked.filter((f) => !f.startsWith(".narrowbit/")) },
      verify: cfg.verify,
      selection,
      selectionError,
      providers,
      phases: PHASES,
      efforts: EFFORT_LEVELS,
      running: rootBusy(),
      runningTask: runningRuns().find((r) => r.root === root)?.taskId ?? null,
      runningTasks: runningRuns().map((r) => r.taskId).filter(Boolean),
      lead: effAgent(cfg)?.boss ?? false,
      fallback: effAgent(cfg)?.fallback ?? "",
      scout: effAgent(cfg)?.scout ?? "",
      reviewOnly: !!effAgent(cfg)?.reviewOnly,
      planApproval: !!effAgent(cfg)?.planApproval,
      history: [...(initialized ? taskHistory(p, 40, { project: basename(root), root }) : []), ...mergedHistory(root)]
        .sort((a, b) => b.last.localeCompare(a.last))
        .slice(0, 40),
      skills: listSkills(p),
      memory: openMemory(p).load().filter((e) => e.status === "active" && !e.external).map((e) => ({ id: e.id, type: e.type, text: e.text, reason: e.reason ?? "", date: e.date })),
      connectors: listConnectors().map(publicConnector),
    };
  };

  const startRun = (task: string, maxSteps: number, askBeforeCommands: boolean, continueTask: string | null, isolate = false, attachments: string[] = []): { status: number; body: unknown } => {
    if (!root) return { status: 400, body: { error: "open a repository first" } };
    if (continueTask && runOfTask(continueTask)) return { status: 409, body: { error: "this conversation is already working — wait for it, or stop it" } };
    if (runningRuns().length >= MAX_RUNS) return { status: 409, body: { error: `${MAX_RUNS} tasks are already running — wait for one to finish or stop one` } };
    // A second task in a folder that already has one running works in a separate copy, so the two can't edit the same files.
    const sharesFolder = rootBusy(root);
    if (sharesFolder) isolate = true;
    const p = paths(root);
    if (!existsSync(p.db)) return { status: 400, body: { error: "set up Narrowbit in this repository first" } };
    // Trust was decided when the folder was opened; the folder can change after that (a pull, an extracted archive), so a
    // task asks again before it reads settings, notes or earlier task logs from it.
    const stale = untrustedReason(root);
    if (stale) return { status: 409, body: { error: "untrusted", message: stale.message, risks: stale.risks, path: root } };
    const g = gitState(root);
    const cfg = loadConfig(p);
    const sel = resolveSelection(effAgent(cfg));
    const unavailable = unavailableReason(sel, effAgent(cfg));
    if (unavailable) return { status: 400, body: { error: unavailable } };
    if (continueTask && !readEvents(p, continueTask).length) return { status: 404, body: { error: `no task ${continueTask}` } };
    const lead = effAgent(cfg)?.boss ?? false;
    const reviewOnly = !!effAgent(cfg)?.reviewOnly;
    const planApproval = !!effAgent(cfg)?.planApproval;
    const thisRun: Run = {
      id: randomBytes(4).toString("hex"),
      root,
      taskId: continueTask,
      events: [],
      controller: new AbortController(),
      pending: new Map(),
      questions: new Map(),
      allowed: new Map(),
      running: true,
      queue: [],
      compactRequested: false,
      // A follow-up keeps the original task's baseline, so the first request's new files still count as its work.
      untrackedBefore: untrackedAtStart(p, continueTask) ?? new Set(g.untracked),
    };
    runs.set(thisRun.id, thisRun);
    let approvalSeq = 0;
    let questionSeq = 0;
    emit(thisRun, { type: "start", task, continueTask, lead, selection: `${sel.tiers.explore} → ${sel.tiers.execute} → ${sel.tiers.escalate} · effort ${sel.effort}` });
    runTask(p, task, {
      scout: parseScout(effAgent(cfg)?.scout) ?? undefined,
      maxSteps,
      boss: lead,
      reviewOnly,
      planApproval,
      continueTask: continueTask ?? undefined,
      attachments,
      isolate: isolate || !!(continueTask && readIsolated(p, continueTask)),
      onEvent: (event) => {
        thisRun.taskId = event.taskId;
        emit(thisRun, { type: "event", event });
      },
      provider: sel.provider,
      models: sel.tiers,
      effort: sel.effort,
      signal: thisRun.controller.signal,
      takeMessages: () => thisRun.queue.splice(0),
      hasMessages: () => thisRun.queue.length > 0,
      compactNow: () => {
        const r = thisRun.compactRequested;
        thisRun.compactRequested = false;
        return r;
      },
      ask: (question, options) => {
        if (thisRun.controller.signal.aborted) return Promise.resolve(null);
        const id = `${thisRun.id}-q${++questionSeq}`;
        emit(thisRun, { type: "question", id, question, options });
        return new Promise<string | null>((res) => thisRun.questions.set(id, res));
      },
      approve: askBeforeCommands
        ? (command, warning, key, edits = []) => {
            // After Stop nothing more is approved, however it was allowed before.
            if (thisRun.controller.signal.aborted) return Promise.resolve(false);
            // "Allow for this task" covered the command as it was then; approvals.ts says when that still holds (it ends at the
            // agent's next edit unless "for the whole task" was chosen, and a warning always asks). A connector call is keyed
            // to the exact call (`key`), not to the text shown.
            const grant = thisRun.allowed.get(key ?? command);
            if (covered(grant, warning, key, edits)) return Promise.resolve(true);
            const changes = grant && !key ? editsSince(grant, edits) : [];
            const id = `${thisRun.id}-a${++approvalSeq}`;
            // The page shows the command with control characters and direction overrides spelled out; `key` carries the
            // exact thing that "allow for this task" remembers.
            const shown = visible(command);
            emit(thisRun, { type: "approval", id, command: shown, editLen: edits.length, ...(warning ? { warning } : {}), ...(changes.length ? { changes } : {}), ...(key || shown !== command ? { key: key ?? command } : {}) });
            return new Promise<boolean>((res) => thisRun.pending.set(id, res));
          }
        : undefined,
    })
      .then((result) => {
        const s = fold(result.taskId, readEvents(p, result.taskId));
        const roles = Object.values(s.ledgerByRole);
        const changed = (() => { const iso = readIsolated(p, result.taskId); return iso ? workingDiff(iso.dir).files : workingDiff(thisRun.root, thisRun.untrackedBefore).files; })();
        const end = [...readEvents(p, result.taskId)].reverse().find((e) => e.type === "decision" && typeof e.meta?.outcome === "string");
        emit(thisRun, {
          type: "finished",
          outcome: result.outcome,
          summary: result.summary,
          steps: result.steps,
          taskId: result.taskId,
          changed,
          suggestion: suggestFollowUp({ outcome: result.outcome, summary: result.summary, filesChanged: changed.length, errorKind: typeof end?.meta?.errorKind === "string" ? (end.meta.errorKind as string) : undefined }),
          tokens: roles.reduce((a, r) => a + r.inputTokens + r.cacheCreationTokens + r.cacheReadTokens + r.outputTokens, 0),
          costUsd: roles.reduce((a, r) => a + r.costUsd, 0),
        });
      })
      .catch((e) => emit(thisRun, { type: "failed", error: String(e?.message ?? e) }))
      .finally(() => {
        thisRun.running = false;
        setTimeout(() => runs.delete(thisRun.id), 60_000).unref();
      });
    return { status: 200, body: { ok: true, isolated: sharesFolder, run: thisRun.id } };
  };

  const resolveApproval = (id: string, decision: "once" | "task" | "always" | "deny") => {
    const run = [...runs.values()].find((x) => x.pending.has(id));
    const r = run?.pending.get(id);
    if (!run || !r) return false;
    run.pending.delete(id);
    const ev = run.events.find((e) => e.type === "approval" && e.id === id) as { command: string; key?: string; editLen?: number } | undefined;
    const cmd = ev?.key ?? ev?.command;
    if ((decision === "task" || decision === "always") && cmd) run.allowed.set(cmd, { always: decision === "always", editLen: ev?.editLen ?? 0 });
    emit(run, { type: "approval_resolved", id, allowed: decision !== "deny" });
    r(decision !== "deny");
    return true;
  };

  const resolveQuestion = (id: string, answer: string | null) => {
    const run = [...runs.values()].find((x) => x.questions.has(id));
    const r = run?.questions.get(id);
    if (!run || !r) return false;
    run.questions.delete(id);
    emit(run, { type: "question_resolved", id, answer });
    r(answer);
    return true;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const port = (server.address() as { port: number }).port;
      if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return json(res, 403, { error: "bad host" });
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { ...SEC_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
        return res.end(uiPage());
      }
      if (req.method === "GET" && url.pathname === "/oauth/callback") {
        // The user's browser returns here after signing in. No app token (the browser has none): the one-time
        // `state` we issued is the proof, and the Host check above already limits this to the loopback server.
        const page = (title: string, body: string) => {
          res.writeHead(200, { ...SEC_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
          res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32em;margin:15vh auto;padding:0 1em"><h2>${title}</h2><p>${body}</p>`);
        };
        const err = url.searchParams.get("error");
        if (err) return page("Sign-in cancelled", "The service reported: " + err.replace(/[<>&"]/g, "") + ". You can close this tab.");
        try {
          const name = await completeSignIn(url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "");
          broadcast({ type: "log", line: `${name}: signed in` });
          return page("Signed in", `Narrowbit is now connected to ${name.replace(/[<>&"]/g, "")}. You can close this tab and go back to the app.`);
        } catch (e: any) {
          return page("Sign-in failed", String(e.message).replace(/[<>&"]/g, ""));
        }
      }
      if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
      const given = url.pathname === "/api/stream" ? url.searchParams.get("t") : req.headers["x-narrowbit-token"];
      if (!tokenMatches(given, token)) return json(res, 401, { error: "missing or wrong token — reopen the app" });
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /api/state") return json(res, 200, state());

      if (route === "GET /api/stream") {
        res.writeHead(200, { ...SEC_HEADERS, "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        // Replay every live run so a reloaded window catches up, including open approvals.
        for (const r of runningRuns()) for (const e of r.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }

      if (route === "GET /api/update") return json(res, 200, { ...(await checkUpdate(url.searchParams.has("refresh"))), justUpdated: pendingUpdateNotes() });

      if (route === "GET /api/github") {
        if (!root) return json(res, 400, { error: "no repository open" });
        return json(res, 200, githubIdentity(root));
      }
      if (route === "GET /api/diagnostics") return json(res, 200, { text: await diagnostics() });

      if (route === "GET /api/readiness") return json(res, 200, await checkReadiness(url.searchParams.has("refresh")));

      if (route === "GET /api/files") {
        if (!root || !existsSync(paths(root).db)) return json(res, 200, { files: [] });
        return json(res, 200, { files: suggestFiles(paths(root), url.searchParams.get("q") ?? "", 20) });
      }

      if (route === "GET /api/limits") {
        // Codex's check is free, so refresh it when stale; Claude's updates with every call.
        const l = readLimits();
        if (!l.codex || Date.now() - new Date(l.codex.checkedAt).getTime() > 2 * 60_000) await refreshCodex();
        return json(res, 200, readLimits());
      }

      if (route === "GET /api/models") {
        const prov = url.searchParams.get("provider") ?? "";
        if (!isProvider(prov)) return json(res, 400, { error: `unknown provider "${prov}"` });
        const agent = root ? effAgent(loadConfig(paths(root))) : globalAgent();
        const cacheKey = `${prov} ${resolveEndpoint(prov, agent)?.baseUrl ?? ""} ${keySource(prov, PROVIDER_INFO[prov].keyEnv) ?? ""}`;
        const hit = modelCache.get(cacheKey);
        if (hit && Date.now() - hit.at < 5 * 60_000 && hit.list.models.length && !url.searchParams.has("refresh")) return json(res, 200, hit.list);
        const list = await availableModels(prov, agent);
        modelCache.set(cacheKey, { at: Date.now(), list });
        return json(res, 200, list);
      }

      if (route === "GET /api/diff") {
        if (!root) return json(res, 400, { error: "no repository open" });
        const taskId = url.searchParams.get("task");
        const iso = taskId && /^rt-[\w-]+$/.test(taskId) ? readIsolated(paths(root), taskId) : null;
        if (iso) return json(res, 200, { ...workingDiff(iso.dir), isolated: true });
        return json(res, 200, workingDiff(root, preexisting(taskId)));
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/task/")) {
        if (!root) return json(res, 400, { error: "no repository open" });
        const id = url.pathname.slice("/api/task/".length);
        if (!/^rt-[\w-]+$/.test(id)) return json(res, 400, { error: "bad task id" });
        const live = runOfTask(id);
        // Approvals and questions this task is waiting on, so opening it from the sidebar shows what it needs from you.
        const waiting = live ? live.events.filter((e) => (e.type === "approval" && live.pending.has(e.id)) || (e.type === "question" && live.questions.has(e.id))) : [];
        const events = readEvents(paths(root), id);
        return json(res, 200, { id, events, running: !!live, waiting, suggestion: live ? null : suggestionFromEvents(events) });
      }

      // Planning drafts: conversations before any project exists (planning.ts). Work with no repository
      // open at all — that's the whole point — so these never gate on `root`.
      if (route === "GET /api/plan") return json(res, 200, { drafts: taskHistory(draftsPaths()) });
      if (req.method === "GET" && url.pathname.startsWith("/api/plan/")) {
        const id = url.pathname.slice("/api/plan/".length);
        if (!/^pl-[\w-]+$/.test(id)) return json(res, 400, { error: "bad draft id" });
        return json(res, 200, { id, events: readEvents(draftsPaths(), id) });
      }

      if (req.method !== "POST") return json(res, 404, { error: "not found" });
      const body = await readBody(req, url.pathname === "/api/attach" ? 20_000_000 : 1_000_000);

      switch (url.pathname) {
        case "/api/repo": {
          // One action for both "open this existing project" and "start a new one here" — a folder that
          // isn't already a project (new, empty, or with files already in it — a hand-made scaffold, a
          // downloaded template) is created (git init, add whatever's there, one commit) rather than
          // refused, so there's a single "choose a folder" flow instead of a separate create ceremony.
          const dir = resolve(String(body.path ?? "").replace(/^~(?=$|\/)/, homedir()));
          if (dir === homedir()) return json(res, 400, { error: "refusing to use your home folder as a repository" });
          if (existsSync(dir) && !statSync(dir).isDirectory()) return json(res, 400, { error: `not a folder: ${dir}` });
          const looksLikeProject = existsSync(dir) && (existsSync(join(dir, ".git")) || existsSync(join(dir, "package.json")));
          let r: string;
          let seedTask: string | undefined;
          if (looksLikeProject) {
            r = repoRootOf(dir);
            const u = untrustedReason(r);
            if (u) {
              if (body.trust !== true) return json(res, 409, { error: "untrusted", message: u.message, risks: u.risks, path: r });
              trustRepo(r, u.risks);
            }
          } else {
            // Making a project of a folder that already has files git-inits it and commits everything in it. That
            // is only done once the user has seen what's there and said yes; an empty or new folder needs no question.
            const broad = tooBroadForProject(dir);
            if (broad) return json(res, 400, { error: `Refusing to make ${dir} a project — ${broad}, and it would commit everything inside it. Pick or create a folder just for this project.` });
            // An unzipped download can already contain a .narrowbit/ folder; it is accepted before it is used, like a committed one.
            const shipped = existsSync(dir) ? shippedRisks(dir) : [];
            if (shipped.length) {
              if (body.trust !== true) return json(res, 409, { error: "untrusted", message: untrustedMessage(dir, shipped), risks: shipped, path: dir });
              trustRepo(dir, shipped);
            }
            if (existsSync(dir) && body.confirmCreate !== true) {
              const entries = readdirSync(dir).filter((n) => n !== ".DS_Store");
              if (entries.length) {
                const tracked = sh("git", ["ls-files", "--others", "--exclude-standard", "-z"], dir);
                const files = tracked.code === 0 ? tracked.stdout.split("\0").filter(Boolean) : entries;
                return json(res, 409, { error: "confirm-create", path: dir, count: files.length, files: files.slice(0, 25) });
              }
            }
            const taskId = typeof body.taskId === "string" && /^pl-[\w-]+$/.test(body.taskId) ? body.taskId : undefined;
            try {
              const created = createProjectFromDraft(taskId, dir);
              r = created.root;
              seedTask = created.seedTask || undefined;
            } catch (e: any) {
              return json(res, 400, { error: e.message });
            }
          }
          root = r;
          saveRecent(r);
          const st = state();
          return json(res, 200, seedTask ? { ...st, seedTask } : st);
        }
        case "/api/repo/close": {
          // Leaving the current project back to the rootless planning screen — the only way there once
          // any folder has ever been opened, since the server otherwise reopens the last-used one at
          // launch and "New task" only resets the conversation, never the open folder.
          if (rootBusy()) return json(res, 409, { error: "stop the running task before closing this project" });
          root = null;
          return json(res, 200, state());
        }
        case "/api/plan": {
          // Discuss a project before it exists: no repo, no files, just the model replying. Always uses the
          // global model choice (there's no per-repo config yet — there's no repo).
          const task = String(body.task ?? "").trim();
          if (!task) return json(res, 400, { error: "say something first" });
          const continueTask = typeof body.continueTask === "string" && /^pl-[\w-]+$/.test(body.continueTask) ? body.continueTask : undefined;
          const ga = globalAgent();
          let sel;
          try {
            sel = resolveSelection(ga);
          } catch (e: any) {
            return json(res, 400, { error: e.message });
          }
          const unavailable = unavailableReason(sel, ga);
          if (unavailable) return json(res, 400, { error: unavailable });
          const r = await planningReply(continueTask, task, providerCallFor(sel.provider, ga), sel.tiers.execute, sel.effort);
          if (r.isError) return json(res, 400, { error: r.errorMessage ?? "the model call failed", taskId: r.taskId });
          return json(res, 200, { taskId: r.taskId, reply: r.text });
        }
        case "/api/init": {
          if (!root) return json(res, 400, { error: "no repository open" });
          initProject(paths(root));
          return json(res, 200, state());
        }
        case "/api/models": {
          const p = root ? paths(root) : null;
          const provider = String(body.provider ?? "");
          if (!isProvider(provider)) return json(res, 400, { error: `unknown provider "${provider}"` });
          const effort = String(body.effort ?? "");
          if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) return json(res, 400, { error: `unknown effort "${effort}"` });
          const cfg = p ? loadConfig(p) : { agent: globalAgent() };
          const base = effAgent(cfg);
          const models = { ...(base?.models ?? {}) };
          const slots: Record<string, string> = {};
          for (const phase of PHASES) {
            const m = String(body.tiers?.[phase] ?? "").trim();
            if (m) slots[phase] = m;
          }
          models[provider as ProviderName] = slots;
          const next = { ...base, provider, effort, models, ...(typeof body.lead === "boolean" ? { boss: body.lead } : {}), ...(typeof body.reviewOnly === "boolean" ? { reviewOnly: body.reviewOnly } : {}), ...(typeof body.planApproval === "boolean" ? { planApproval: body.planApproval } : {}) } as AgentConfig;
          if (typeof body.fallback === "string") {
            if (body.fallback && isProvider(body.fallback) && body.fallback !== provider) next.fallback = body.fallback;
            else delete next.fallback;
          }
          if (typeof body.scout === "string") {
            if (parseScout(body.scout)) next.scout = body.scout;
            else delete next.scout;
          }
          if (p) {
            (cfg as any).agent = next;
            ensureDirs(p);
            saveConfig(p, cfg as any);
          }
          // Also remembered globally so the next repo (or the next launch with no folder) starts here.
          mkdirSync(join(homedir(), ".narrowbit"), { recursive: true, mode: 0o700 });
          writeFileSync(GLOBAL_AGENT, JSON.stringify({ provider, effort, models, boss: next.boss, reviewOnly: next.reviewOnly, planApproval: next.planApproval, fallback: next.fallback, scout: next.scout }, null, 2) + "\n", { mode: 0o600 });
          return json(res, 200, state());
        }
        case "/api/skills": {
          if (!root) return json(res, 400, { error: "no repository open" });
          const p = paths(root);
          const name = String(body.name ?? "").trim();
          try {
            ensureDirs(p);
            saveSkill(p, name, String(body.description ?? ""), String(body.body ?? ""));
          } catch (e: any) {
            return json(res, 400, { error: e.message });
          }
          return json(res, 200, state());
        }
        case "/api/push": {
          // An explicit click in the app is the only way this runs; nothing pushes automatically.
          if (!root) return json(res, 400, { error: "no repository open" });
          if (rootBusy()) return json(res, 409, { error: "wait for the task in this folder to finish" });
          const r = pushBranch(root);
          if (!r.ok) {
            // A brand-new local project has no remote yet: offer to create one on GitHub (a separate, explicit
            // step) instead of a dead-end error telling the user to run git by hand.
            if (r.message === "no-remote") return json(res, 409, { error: "no-remote", suggestedName: basename(root) });
            return json(res, 400, { error: r.message });
          }
          return json(res, 200, { message: r.message, state: state() });
        }
        case "/api/github/create-repo": {
          // Publishing is a separate, explicit action from creating the project — never automatic (see
          // planning.ts's createProjectFromDraft, which only ever does a local git init).
          if (!root) return json(res, 400, { error: "no repository open" });
          if (rootBusy()) return json(res, 409, { error: "wait for the task in this folder to finish" });
          const name = String(body.name ?? "").trim();
          if (!/^[\w.-]+$/.test(name)) return json(res, 400, { error: "give this repo a name using only letters, numbers, - . and _" });
          const r = createGithubRepo(root, name, { private: body.private !== false });
          if (!r.ok) return json(res, 400, { error: r.message });
          return json(res, 200, { message: r.message, state: state() });
        }
        case "/api/session/rename":
        case "/api/session/delete": {
          if (!root) return json(res, 400, { error: "no repository open" });
          const id = String(body.id ?? "");
          if (!/^rt-[\w-]+$/.test(id)) return json(res, 400, { error: "bad session id" });
          if (runOfTask(id)) return json(res, 409, { error: "stop the running task first" });
          const dir = join(paths(root).runtime, id);
          if (!existsSync(dir)) return json(res, 404, { error: "no such session" });
          if (route === "POST /api/session/delete") {
            removeProjectPath(root, dir, { recursive: true });
          } else {
            const title = String(body.title ?? "").trim().slice(0, 200);
            if (title) writeProjectFile(root, join(dir, "title.txt"), title + "\n");
            else removeProjectPath(root, join(dir, "title.txt"));
          }
          return json(res, 200, state());
        }
        case "/api/memory/suggested": {
          // Approve or dismiss one of the notes proposed at the end of a task. Only approval writes to project memory.
          if (!root) return json(res, 400, { error: "no repository open" });
          const id = String(body.task ?? "");
          const idx = Number(body.index);
          if (!/^rt-[\w-]+$/.test(id) || !Number.isInteger(idx) || idx < 0) return json(res, 400, { error: "bad request" });
          const p = paths(root);
          const evs = readEvents(p, id);
          const sug = [...evs].reverse().find((e) => Array.isArray(e.meta?.suggested))?.meta?.suggested as { type: string; text: string; reason?: string; files?: string[] }[] | undefined;
          const n = sug?.[idx];
          if (!n) return json(res, 404, { error: "no such suggestion" });
          if (evs.some((e) => e.meta?.suggestedDone === idx)) return json(res, 409, { error: "already handled" });
          const approve = body.approve === true;
          if (approve) {
            try {
              openMemory(p).add({ type: n.type as any, text: n.text, reason: n.reason, files: n.files, source: id, confidence: "medium" });
            } catch (e: any) {
              return json(res, 400, { error: e.message });
            }
          }
          appendEvent(p, id, { actor: "user", type: "decision", summary: approve ? `saved to project memory: ${n.text.slice(0, 100)}` : `dismissed suggestion: ${n.text.slice(0, 100)}`, meta: { suggestedDone: idx, saved: approve } });
          return json(res, 200, state());
        }
        case "/api/memory/remove": {
          if (!root) return json(res, 400, { error: "no repository open" });
          // Marked resolved, not deleted: the note stays on disk (and in the vault) but is never recalled again.
          const e = openMemory(paths(root)).setStatus(String(body.id ?? ""), "resolved");
          if (!e) return json(res, 404, { error: "no such note (or it's read-only)" });
          return json(res, 200, state());
        }
        case "/api/skills/find": {
          // Download and parse only; nothing is saved until the user has read it and presses Save.
          try {
            return json(res, 200, { skills: await findSkills(String(body.url ?? "")) });
          } catch (e: any) {
            return json(res, 400, { error: e.message });
          }
        }
        case "/api/skills/delete": {
          if (!root) return json(res, 400, { error: "no repository open" });
          removeSkill(paths(root), String(body.name ?? ""));
          return json(res, 200, state());
        }
        case "/api/connectors": {
          const name = String(body.name ?? "").trim();
          const command = String(body.command ?? "").trim();
          const cargs = typeof body.args === "string" ? body.args.trim().split(/\s+/).filter(Boolean) : [];
          const env: Record<string, string> = {};
          if (typeof body.env === "string") {
            for (const pair of body.env.split(",")) {
              const eq = pair.indexOf("=");
              if (eq > 0) env[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
            }
          }
          const remote = { url: typeof body.url === "string" ? body.url : "", headers: {} as Record<string, string> };
          if (typeof body.authHeader === "string" && body.authHeader.trim()) remote.headers.Authorization = body.authHeader.trim();
          try {
            saveConnector(name, command, cargs, env, remote);
          } catch (e: any) {
            return json(res, 400, { error: e.message });
          }
          return json(res, 200, state());
        }
        case "/api/connectors/signin": {
          const c = getConnector(String(body.name ?? ""));
          if (!c?.url) return json(res, 400, { error: "sign-in is only for remote (URL) connectors" });
          try {
            const port = (server.address() as { port: number }).port;
            return json(res, 200, { url: await startSignIn(c.name, c.url, `http://127.0.0.1:${port}/oauth/callback`) });
          } catch (e: any) {
            return json(res, 400, { error: e.message });
          }
        }
        case "/api/connectors/signout": {
          signOut(String(body.name ?? ""));
          return json(res, 200, state());
        }
        case "/api/connectors/delete": {
          signOut(String(body.name ?? ""));
          removeConnector(String(body.name ?? ""));
          return json(res, 200, state());
        }
        case "/api/connectors/test": {
          const c = getConnector(String(body.name ?? ""));
          if (!c) return json(res, 400, { error: `no connector named "${body.name}"` });
          try {
            const tools = await listConnectorTools(c, 20_000);
            return json(res, 200, { ok: true, tools: tools.map((t) => t.name) });
          } catch (e: any) {
            return json(res, 200, { ok: false, error: e.message });
          }
        }
        case "/api/update/ack": {
          acknowledgeUpdateNotes();
          return json(res, 200, { ok: true });
        }
        case "/api/update/apply": {
          if (runningRuns().length) return json(res, 409, { error: "Stop the running tasks before updating." });
          try {
            const r = await applyUpdate();
            json(res, 200, { ok: true, ...r, restarting: !!opts.restartOnUpdate });
            if (opts.restartOnUpdate) setTimeout(() => process.exit(75), 600);
            return;
          } catch (e: any) {
            return json(res, 400, { error: e.message });
          }
        }
        case "/api/update-cli": {
          // Updates the provider's own CLI (npm install -g @openai/codex / claude update) — the one place new models come from.
          const prov = String(body.provider ?? "");
          if (prov !== "codex" && prov !== "claude") return json(res, 400, { error: "only the Codex and Claude CLIs can be updated here" });
          if (runningRuns().length) return json(res, 409, { error: "Stop the running tasks before updating." });
          const r = await updateCli(prov);
          return json(res, r.ok ? 200 : 500, r.ok ? { ok: true, output: r.output } : { error: /EACCES|permission denied|EPERM/i.test(r.output) ? "The update couldn't be installed: this account has no permission to change the installed " + (prov === "codex" ? "Codex" : "Claude Code") + ", which was installed by another user on this Mac. Ask that user to run the update (" + (prov === "codex" ? "npm install -g @openai/codex" : "claude update") + "), or install your own copy." : "The update failed: " + r.output.slice(-400) });
        }
        case "/api/limits/refresh": {
          await Promise.all([refreshClaude(), refreshCodex()]);
          return json(res, 200, readLimits());
        }
        case "/api/key": {
          // The user's own key, typed into their own app: stored in ~/.narrowbit/keys.json (0600)
          // and never sent back to the page — state() only reports whether one is set.
          const prov = String(body.provider ?? "");
          if (!isProvider(prov) || PROVIDER_INFO[prov].kind === "subscription") return json(res, 400, { error: "that provider doesn't use an API key" });
          const key = typeof body.key === "string" ? body.key.trim() : "";
          setKey(prov, key || null);
          return json(res, 200, state());
        }
        case "/api/account-id": {
          // Global (like keys), so it works before any folder is open and in every repo.
          const id = String(body.id ?? "").trim();
          if (!/^[0-9a-f]{32}$/i.test(id)) return json(res, 400, { error: "That doesn't look like an account id (32 letters/digits)" });
          setKey("CLOUDFLARE_ACCOUNT_ID", id);
          return json(res, 200, state());
        }
        case "/api/endpoint": {
          if (!root) return json(res, 400, { error: "no repository open" });
          const prov = String(body.provider ?? "");
          if (!isProvider(prov) || PROVIDER_INFO[prov].kind === "subscription") return json(res, 400, { error: "that provider has no endpoint" });
          const baseUrl = String(body.baseUrl ?? "").trim();
          if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) return json(res, 400, { error: "base URL must start with http:// or https://" });
          const p = paths(root);
          const cfg = loadConfig(p);
          const agent = (cfg.agent ??= {});
          const eps = (agent.endpoints ??= {});
          if (baseUrl && baseUrl !== PROVIDER_INFO[prov].baseUrl) eps[prov] = { ...eps[prov], baseUrl };
          else delete eps[prov];
          ensureDirs(p);
          saveConfig(p, cfg);
          trustConfig(p.root); // the file now holds only what was already accepted plus this explicit change
          return json(res, 200, state());
        }
        case "/api/run": {
          const task = String(body.task ?? "").trim();
          if (!task) return json(res, 400, { error: "describe the task first" });
          const continueTask = typeof body.continueTask === "string" && /^rt-[\w-]+$/.test(body.continueTask) ? body.continueTask : null;
          // The conversation is mid-task: the message is delivered to it before its next step (like a colleague's
          // message arriving while you work), not refused.
          const live = runOfTask(continueTask);
          if (live) {
            if (live.queue.length >= 5) return json(res, 409, { error: "that's a lot of messages waiting — give it a moment to catch up" });
            live.queue.push(task.slice(0, 20_000));
            return json(res, 200, { ok: true, queued: true });
          }
          if (root && !body.force && !continueTask && body.isolate !== true && !rootBusy(root)) {
            const g = gitState(root);
            const changed = [...new Set([...g.dirty, ...g.staged])];
            if (changed.length) return json(res, 409, { error: "dirty", files: changed });
          }
          const maxSteps = Math.min(100, Math.max(1, Number(body.maxSteps) || 20));
          // Attachments are named by the id /api/attach returned; anything else is ignored, so a page can't point the agent at other files.
          if (!root) return json(res, 400, { error: "open a repository first" });
          let attachments: string[];
          try {
            attachments = (Array.isArray(body.attachments) ? body.attachments : [])
              .filter((a: unknown): a is string => typeof a === "string" && /^[0-9a-f]{8}-[\w.\- ]+$/.test(a))
              .map((a: string) => join(attachmentDir(root!), a))
              .filter((f: string) => existsSync(f))
              .slice(0, 6);
          } catch (e: any) {
            return json(res, 400, { error: e.message });
          }
          const r = startRun(task, maxSteps, body.askBeforeCommands !== false, continueTask, body.isolate === true, attachments);
          return json(res, r.status, r.body);
        }
        case "/api/attach": {
          if (!root) return json(res, 400, { error: "open a repository first" });
          try {
            const data = Buffer.from(String(body.data ?? ""), "base64");
            if (!data.length) return json(res, 400, { error: "empty file" });
            const f = saveAttachment(root, String(body.name ?? "file"), data);
            return json(res, 200, { id: basename(f), name: basename(f).replace(/^[0-9a-f]{8}-/, ""), kind: attachmentKind(f) });
          } catch (e: any) {
            return json(res, 400, { error: e.message });
          }
        }
        case "/api/approve": {
          const decision = body.decision === "task" ? "task" : body.decision === "always" ? "always" : body.decision === "once" ? "once" : "deny";
          return json(res, resolveApproval(String(body.id ?? ""), decision) ? 200 : 404, { ok: true });
        }
        case "/api/answer": {
          const answer = typeof body.answer === "string" ? body.answer.trim().slice(0, 4000) : "";
          if (!answer) return json(res, 400, { error: "type an answer" });
          return json(res, resolveQuestion(String(body.id ?? ""), answer) ? 200 : 404, { ok: true });
        }
        case "/api/compact": {
          if (!root) return json(res, 400, { error: "no repository open" });
          const id = String(body.task ?? "");
          if (!/^rt-[\w-]+$/.test(id)) return json(res, 400, { error: "bad task id" });
          const live = runOfTask(id);
          if (live) {
            live.compactRequested = true;
            return json(res, 200, { ok: true, when: "after the model's current step" });
          }
          const p = paths(root);
          if (!readEvents(p, id).length) return json(res, 404, { error: "no such chat" });
          // An idle chat: mark it, so the next message starts a fresh session from the summary instead of resuming.
          appendEvent(p, id, { actor: "user", type: "handoff", summary: "you compacted this chat — your next message starts a fresh session from a short summary", meta: { manual: true } });
          return json(res, 200, { ok: true, when: "with your next message" });
        }
        case "/api/rewind": {
          if (!root) return json(res, 400, { error: "no repository open" });
          if (rootBusy()) return json(res, 409, { error: "stop the running task in this folder first" });
          const id = String(body.task ?? "");
          if (!/^rt-[\w-]+$/.test(id)) return json(res, 400, { error: "bad task id" });
          const p = paths(root);
          const cps = listCheckpoints(p, id);
          const target = cps.find((c) => c.id === String(body.checkpoint ?? ""));
          if (!target) return json(res, 404, { error: "no such checkpoint" });
          const isolated = readIsolated(p, id);
          const targetRoot = isolated ? isolated.dir : root;
          const r = restoreCheckpoint(targetRoot, target.commit);
          if (!r.ok) return json(res, 500, { error: r.message });
          appendEvent(p, id, { actor: "user", type: "checkpoint", summary: `rewound to: ${target.summary}`, meta: { rewoundTo: target.id } });
          return json(res, 200, { ok: true, message: r.message, movedTo: r.movedTo, unsaved: r.unsaved });
        }
        case "/api/fork": {
          // Branch a conversation from one of your earlier messages: a new conversation with everything before it.
          if (!root) return json(res, 400, { error: "no repository open" });
          const id = String(body.task ?? "");
          if (!/^rt-[\w-]+$/.test(id)) return json(res, 400, { error: "bad task id" });
          const r = forkTask(paths(root), id, String(body.event ?? ""));
          if ("error" in r) return json(res, 400, { error: r.error });
          return json(res, 200, { ok: true, taskId: r.taskId, isolated: !!readIsolated(paths(root), id) });
        }
        case "/api/stop": {
          // The conversation being viewed (body.task), else whatever is running in the open folder.
          const targets = typeof body.task === "string" ? [runOfTask(body.task)].filter((r): r is Run => !!r) : runningRuns().filter((r) => r.root === root);
          for (const run of targets) {
            run.controller.abort();
            for (const id of [...run.pending.keys()]) resolveApproval(id, "deny");
            for (const id of [...run.questions.keys()]) resolveQuestion(id, null);
            emit(run, { type: "log", line: "stopping after the current step…" });
          }
          return json(res, 200, { ok: true });
        }
        case "/api/isolated/apply":
        case "/api/isolated/discard": {
          if (!root) return json(res, 400, { error: "no repository open" });
          if (rootBusy()) return json(res, 409, { error: "wait for the task in this folder to finish" });
          const id = String(body.task ?? "");
          if (!/^rt-[\w-]+$/.test(id)) return json(res, 400, { error: "bad task id" });
          if (route === "POST /api/isolated/discard") { discardIsolated(paths(root), id); return json(res, 200, { ok: true, message: "Discarded the separate copy. Your folder was never touched." }); }
          const r = applyIsolated(paths(root), id);
          if (!r.ok) return json(res, 409, { error: r.message });
          discardIsolated(paths(root), id);
          return json(res, 200, { ok: true, message: r.message, files: r.files });
        }
        case "/api/commit": {
          if (!root) return json(res, 400, { error: "no repository open" });
          if (rootBusy()) return json(res, 409, { error: "wait for the task in this folder to finish" });
          const message = String(body.message ?? "").trim();
          if (!message) return json(res, 400, { error: "write a commit message" });
          const { files } = workingDiff(root, preexisting(typeof body.task === "string" ? body.task : null));
          if (!files.length) return json(res, 400, { error: "nothing to commit" });
          // Checkpoint: nothing leaves this machine by commit, but a pushed secret cannot be un-pushed,
          // so stop here if the change adds credentials, unless the user says to go ahead.
          if (body.force !== true) {
            const risky = auditRepo(root, { files }).filter((f) => f.severity === "high");
            if (risky.length) return json(res, 409, { error: "secrets", findings: risky.slice(0, 8) });
          }
          const add = sh("git", ["add", "-A", "--", ...files], root);
          if (add.code !== 0) return json(res, 500, { error: add.stderr.trim() || "git add failed" });
          // Commit exactly the files shown on the Changes card (as they are on disk, which is what was scanned above) —
          // a plain `git commit` would also take whatever else was already staged, unseen and unscanned.
          const c = sh("git", ["commit", "-m", message, "--only", "--", ...files], root);
          if (c.code !== 0) return json(res, 500, { error: (c.stderr || c.stdout).trim() || "git commit failed" });
          const leftStaged = sh("git", ["diff", "--cached", "--name-only", "-z"], root).stdout.split("\0").filter(Boolean);
          return json(res, 200, { ok: true, head: sh("git", ["rev-parse", "--short", "HEAD"], root).stdout.trim(), leftStaged });
        }
        case "/api/reveal-recovered": {
          // Show a rewind/discard recovery folder in Finder. Only ever a folder under this project's
          // .narrowbit/rewind-trash — the page can't use this to open anything else.
          if (!root) return json(res, 400, { error: "no repository open" });
          const base = join(root, ".narrowbit", "rewind-trash");
          const want = resolve(String(body.path ?? ""));
          // A folder, never a file: `open` on a recovered file would launch it (a .command or .app that a task left there).
          if (!existsSync(want) || !existsSync(base) || !realpathSync(want).startsWith(realpathSync(base) + "/") || !statSync(want).isDirectory()) return json(res, 400, { error: "that isn't a recovery folder" });
          const r = spawnSync("open", [want], { encoding: "utf8" });
          if (r.status !== 0) return json(res, 500, { error: (r.stderr || "couldn't open it").trim() });
          return json(res, 200, { ok: true });
        }
        case "/api/discard": {
          // Undo one task, and only that task: the files that differ between its first checkpoint (before it
          // changed anything) and its last (as it left the folder), each only if still exactly as the task left
          // it. The old version restored every dirty file to HEAD — wiping the user's own edits made before or
          // after the task — and deleted new files outright. `preview: true` returns the plan without touching
          // anything, so the confirmation can show exactly what will happen.
          if (!root) return json(res, 400, { error: "no repository open" });
          if (rootBusy()) return json(res, 409, { error: "wait for the task in this folder to finish" });
          const taskId = typeof body.task === "string" && /^rt-[\w-]+$/.test(body.task) ? body.task : null;
          if (!taskId) return json(res, 400, { error: "which task? (discard undoes one task's changes)" });
          const cps = listCheckpoints(paths(root), taskId);
          if (cps.length < 2) return json(res, 409, { error: "This task has no record of its changes to undo (it made none, or it predates change tracking). Use Rewind, or git, to revert by hand." });
          const start = cps[0].commit, end = cps[cps.length - 1].commit;
          // Only files the agent's own edit actions changed count as the agent's. Anything else that differs between
          // the task's first and last checkpoint (a command's output, or the user working at the same time) is shown,
          // not reverted, unless the user explicitly includes it.
          const agentPaths = new Set<string>();
          for (const e of readEvents(paths(root), taskId)) {
            if (e.type === "edit" && typeof e.meta?.path === "string") agentPaths.add(relative(root, resolve(root, e.meta.path)).split("\\").join("/"));
          }
          const opts = { agentPaths, includeReview: body.includeReview === true };
          if (body.preview === true) return json(res, 200, { preview: true, ...planDiscard(root, start, end, opts) });
          const r = discardTask(root, start, end, opts);
          if (!r.ok) return json(res, 500, { error: r.message });
          return json(res, 200, r);
        }
      }
      return json(res, 404, { error: "not found" });
    } catch (e: any) {
      if (!res.headersSent) json(res, 500, { error: friendlyFsError(e) });
    }
  });

  server.listen(opts.port, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    opts.onListening(`http://127.0.0.1:${port}/?t=${token}`);
  });
  return server;
}
