import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ensureDirs, loadConfig, paths, saveConfig, type AgentConfig, type Paths } from "./config.js";
import { getConnector, listConnectors, removeConnector, saveConnector } from "./connectors.js";
import { fold, readEvents, type Event } from "./events.js";
import { changedSince, gitState } from "./git.js";
import { listConnectorTools } from "./mcpClient.js";
import { initProject } from "./project.js";
import { keySource, setKey } from "./keys.js";
import { readLimits, refreshClaude, refreshCodex } from "./limits.js";
import { checkReadiness } from "./readiness.js";
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
} from "./providers/models.js";
import { runTask, safeAbsPath } from "./runtime.js";
import { listSkills, removeSkill, saveSkill } from "./skills.js";
import { uiPage } from "./ui-page.js";
import { sh } from "./util.js";

/**
 * `narrowbit ui`: the app. A local HTTP server (127.0.0.1 only) that drives the same runTask()
 * as `narrowbit agent`, plus what a terminal does badly — approving each command before it runs,
 * reviewing the diff, then committing or discarding. The macOS app (mac/) is a window around this.
 *
 * Every API call needs the per-launch token (header, or ?t= for the event stream) and a loopback
 * Host header, so other web pages open in a browser can't drive it (CSRF / DNS rebinding).
 */

type StreamEvent =
  | { type: "start"; task: string; continueTask: string | null; selection: string; lead: boolean }
  | { type: "log"; line: string }
  | { type: "event"; event: Event }
  | { type: "approval"; id: string; command: string }
  | { type: "approval_resolved"; id: string; allowed: boolean }
  | { type: "finished"; outcome: string; summary: string; steps: number; taskId: string; changed: string[]; tokens: number; costUsd: number }
  | { type: "failed"; error: string };

interface Run {
  root: string;
  events: StreamEvent[];
  controller: AbortController;
  pending: Map<string, (allowed: boolean) => void>;
  /** Commands the user allowed for the rest of this task. */
  allowed: Set<string>;
  running: boolean;
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

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
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

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function taskHistory(p: Paths, limit = 40) {
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
    rows.push({
      id,
      goal: state.goal ?? "(no goal recorded)",
      at: events[0].at,
      last: events[events.length - 1].at,
      outcome: (end?.meta?.outcome as string) ?? (done ? "done" : "unfinished"),
      turns: events.filter((e) => e.actor === "user" && e.type === "decision").length,
      files: state.filesTouched,
      tokens: roles.reduce((a, r) => a + r.inputTokens + r.cacheCreationTokens + r.cacheReadTokens + r.outputTokens, 0),
      costUsd: roles.reduce((a, r) => a + r.costUsd, 0),
    });
  }
  return rows.sort((a, b) => b.last.localeCompare(a.last)).slice(0, limit);
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
  for (const line of sh("git", ["diff", "HEAD", "--numstat", "--", ".", ":(exclude).narrowbit"], root).stdout.split("\n")) {
    const [a, r, file] = line.split("\t");
    if (file) out[file] = { added: Number(a) || 0, removed: Number(r) || 0 };
  }
  for (const f of files) {
    if (out[f]) continue;
    try {
      out[f] = { added: readFileSync(join(root, f), "utf8").split("\n").length, removed: 0 };
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
      const buf = readFileSync(abs);
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
  onListening: (url: string) => void;
}

export function startUi(opts: UiOptions) {
  const token = randomBytes(24).toString("hex");
  let root: string | null = opts.root && existsSync(opts.root) ? repoRootOf(opts.root) : (loadRecent()[0] ?? null);
  let run: Run | null = null;
  const clients = new Set<ServerResponse>();
  const modelCache = new Map<string, { at: number; list: ModelList }>();

  const preexisting = (taskId?: string | null) =>
    (root ? untrackedAtStart(paths(root), taskId ?? run?.taskId ?? null) : null) ?? (run && run.root === root ? run.untrackedBefore : new Set<string>());
  const emit = (e: StreamEvent) => {
    if (!run) return;
    run.events.push(e);
    const frame = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(frame);
  };

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

  const state = () => {
    if (!root) {
      // No repository yet: settings are per-repo so nothing can be saved, but the provider/model
      // lists must still render or the picker looks empty on a fresh profile.
      const selection = resolveSelection(undefined);
      return { root: null, recent: loadRecent(), selection, providers: buildProviders(undefined), phases: PHASES, efforts: EFFORT_LEVELS, lead: true, connectors: listConnectors(), skills: [], history: [] };
    }
    const p = paths(root);
    const initialized = existsSync(p.db);
    const g = gitState(root);
    const cfg = loadConfig(p);
    let selection;
    let selectionError: string | null = null;
    try {
      selection = resolveSelection(cfg.agent);
    } catch (e: any) {
      selectionError = e.message;
      selection = resolveSelection(undefined);
    }
    const providers = buildProviders(cfg.agent);
    return {
      root,
      name: basename(root),
      recent: loadRecent(),
      initialized,
      git: { isRepo: g.isRepo, branch: g.branch, head: g.head?.slice(0, 7) ?? null, changed: [...new Set([...g.dirty, ...g.staged])], untracked: g.untracked.filter((f) => !f.startsWith(".narrowbit/")) },
      verify: cfg.verify,
      selection,
      selectionError,
      providers,
      phases: PHASES,
      efforts: EFFORT_LEVELS,
      running: !!run?.running && run.root === root,
      runningTask: run?.running && run.root === root ? run.taskId : null,
      lead: cfg.agent?.boss ?? true,
      history: initialized ? taskHistory(p) : [],
      skills: listSkills(p),
      connectors: listConnectors(),
    };
  };

  const startRun = (task: string, maxSteps: number, askBeforeCommands: boolean, continueTask: string | null): { status: number; body: unknown } => {
    if (!root) return { status: 400, body: { error: "open a repository first" } };
    if (run?.running) return { status: 409, body: { error: "a task is already running" } };
    const p = paths(root);
    if (!existsSync(p.db)) return { status: 400, body: { error: "set up Narrowbit in this repository first" } };
    const g = gitState(root);
    const cfg = loadConfig(p);
    const sel = resolveSelection(cfg.agent);
    const unavailable = unavailableReason(sel, cfg.agent);
    if (unavailable) return { status: 400, body: { error: unavailable } };
    if (continueTask && !readEvents(p, continueTask).length) return { status: 404, body: { error: `no task ${continueTask}` } };
    const lead = cfg.agent?.boss ?? true;
    const thisRun: Run = {
      root,
      taskId: continueTask,
      events: [],
      controller: new AbortController(),
      pending: new Map(),
      allowed: new Set(),
      running: true,
      // A follow-up keeps the original task's baseline, so the first request's new files still count as its work.
      untrackedBefore: untrackedAtStart(p, continueTask) ?? new Set(g.untracked),
    };
    run = thisRun;
    let approvalSeq = 0;
    emit({ type: "start", task, continueTask, lead, selection: `${sel.tiers.explore} → ${sel.tiers.execute} → ${sel.tiers.escalate} · effort ${sel.effort}` });
    runTask(p, task, {
      maxSteps,
      boss: lead,
      continueTask: continueTask ?? undefined,
      onEvent: (event) => {
        thisRun.taskId = event.taskId;
        emit({ type: "event", event });
      },
      provider: sel.provider,
      models: sel.tiers,
      effort: sel.effort,
      signal: thisRun.controller.signal,
      approve: askBeforeCommands
        ? (command) => {
            if (thisRun.allowed.has(command)) return Promise.resolve(true);
            if (thisRun.controller.signal.aborted) return Promise.resolve(false);
            const id = `a${++approvalSeq}`;
            emit({ type: "approval", id, command });
            return new Promise<boolean>((res) => thisRun.pending.set(id, res));
          }
        : undefined,
    })
      .then((result) => {
        const s = fold(result.taskId, readEvents(p, result.taskId));
        const roles = Object.values(s.ledgerByRole);
        emit({
          type: "finished",
          outcome: result.outcome,
          summary: result.summary,
          steps: result.steps,
          taskId: result.taskId,
          changed: workingDiff(thisRun.root, thisRun.untrackedBefore).files,
          tokens: roles.reduce((a, r) => a + r.inputTokens + r.cacheCreationTokens + r.cacheReadTokens + r.outputTokens, 0),
          costUsd: roles.reduce((a, r) => a + r.costUsd, 0),
        });
      })
      .catch((e) => emit({ type: "failed", error: String(e?.message ?? e) }))
      .finally(() => {
        thisRun.running = false;
      });
    return { status: 200, body: { ok: true } };
  };

  const resolveApproval = (id: string, decision: "once" | "task" | "deny") => {
    const r = run?.pending.get(id);
    if (!run || !r) return false;
    run.pending.delete(id);
    const cmd = (run.events.find((e) => e.type === "approval" && e.id === id) as { command: string } | undefined)?.command;
    if (decision === "task" && cmd) run.allowed.add(cmd);
    emit({ type: "approval_resolved", id, allowed: decision !== "deny" });
    r(decision !== "deny");
    return true;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const port = (server.address() as { port: number }).port;
      if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return json(res, 403, { error: "bad host" });
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
        return res.end(uiPage());
      }
      if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
      const given = url.pathname === "/api/stream" ? url.searchParams.get("t") : req.headers["x-narrowbit-token"];
      if (given !== token) return json(res, 401, { error: "missing or wrong token — reopen the app" });
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /api/state") return json(res, 200, state());

      if (route === "GET /api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        // Replay the current run so a reloaded window catches up, including open approvals.
        if (run && run.root === root) for (const e of run.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }

      if (route === "GET /api/readiness") return json(res, 200, await checkReadiness(url.searchParams.has("refresh")));

      if (route === "GET /api/limits") {
        // Codex's check is free, so refresh it when stale; Claude's updates with every call.
        const l = readLimits();
        if (!l.codex || Date.now() - new Date(l.codex.checkedAt).getTime() > 2 * 60_000) await refreshCodex();
        return json(res, 200, readLimits());
      }

      if (route === "GET /api/models") {
        if (!root) return json(res, 400, { error: "no repository open" });
        const prov = url.searchParams.get("provider") ?? "";
        if (!isProvider(prov)) return json(res, 400, { error: `unknown provider "${prov}"` });
        const agent = loadConfig(paths(root)).agent;
        const cacheKey = `${prov} ${resolveEndpoint(prov, agent)?.baseUrl ?? ""} ${keySource(prov, PROVIDER_INFO[prov].keyEnv) ?? ""}`;
        const hit = modelCache.get(cacheKey);
        if (hit && Date.now() - hit.at < 5 * 60_000 && hit.list.models.length && !url.searchParams.has("refresh")) return json(res, 200, hit.list);
        const list = await availableModels(prov, agent);
        modelCache.set(cacheKey, { at: Date.now(), list });
        return json(res, 200, list);
      }

      if (route === "GET /api/diff") {
        if (!root) return json(res, 400, { error: "no repository open" });
        return json(res, 200, workingDiff(root, preexisting(url.searchParams.get("task"))));
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/task/")) {
        if (!root) return json(res, 400, { error: "no repository open" });
        const id = url.pathname.slice("/api/task/".length);
        if (!/^rt-[\w-]+$/.test(id)) return json(res, 400, { error: "bad task id" });
        return json(res, 200, { id, events: readEvents(paths(root), id), running: !!run?.running && run.taskId === id });
      }

      if (req.method !== "POST") return json(res, 404, { error: "not found" });
      const body = await readBody(req);

      switch (url.pathname) {
        case "/api/repo": {
          if (run?.running) return json(res, 409, { error: "stop the running task before switching repositories" });
          const dir = resolve(String(body.path ?? "").replace(/^~(?=$|\/)/, homedir()));
          if (!existsSync(dir) || !statSync(dir).isDirectory()) return json(res, 400, { error: `not a folder: ${dir}` });
          const r = repoRootOf(dir);
          if (!existsSync(join(r, ".git")) && !existsSync(join(r, "package.json"))) return json(res, 400, { error: `${r} doesn't look like a project (no .git or package.json)` });
          if (r === homedir()) return json(res, 400, { error: "refusing to use your home folder as a repository" });
          root = r;
          run = null;
          saveRecent(r);
          return json(res, 200, state());
        }
        case "/api/init": {
          if (!root) return json(res, 400, { error: "no repository open" });
          initProject(paths(root));
          return json(res, 200, state());
        }
        case "/api/models": {
          if (!root) return json(res, 400, { error: "no repository open" });
          const p = paths(root);
          const provider = String(body.provider ?? "");
          if (!isProvider(provider)) return json(res, 400, { error: `unknown provider "${provider}"` });
          const effort = String(body.effort ?? "");
          if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) return json(res, 400, { error: `unknown effort "${effort}"` });
          const cfg = loadConfig(p);
          const models = { ...(cfg.agent?.models ?? {}) };
          const slots: Record<string, string> = {};
          for (const phase of PHASES) {
            const m = String(body.tiers?.[phase] ?? "").trim();
            if (m) slots[phase] = m;
          }
          models[provider as ProviderName] = slots;
          cfg.agent = { ...cfg.agent, provider, effort, models, ...(typeof body.lead === "boolean" ? { boss: body.lead } : {}) };
          ensureDirs(p);
          saveConfig(p, cfg);
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
          try {
            saveConnector(name, command, cargs, env);
          } catch (e: any) {
            return json(res, 400, { error: e.message });
          }
          return json(res, 200, state());
        }
        case "/api/connectors/delete": {
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
          return json(res, 200, state());
        }
        case "/api/run": {
          const task = String(body.task ?? "").trim();
          if (!task) return json(res, 400, { error: "describe the task first" });
          const continueTask = typeof body.continueTask === "string" && /^rt-[\w-]+$/.test(body.continueTask) ? body.continueTask : null;
          if (root && !body.force && !continueTask) {
            const g = gitState(root);
            const changed = [...new Set([...g.dirty, ...g.staged])];
            if (changed.length) return json(res, 409, { error: "dirty", files: changed });
          }
          const maxSteps = Math.min(100, Math.max(1, Number(body.maxSteps) || 20));
          const r = startRun(task, maxSteps, body.askBeforeCommands !== false, continueTask);
          return json(res, r.status, r.body);
        }
        case "/api/approve": {
          const decision = body.decision === "task" ? "task" : body.decision === "once" ? "once" : "deny";
          return json(res, resolveApproval(String(body.id ?? ""), decision) ? 200 : 404, { ok: true });
        }
        case "/api/stop": {
          if (!run?.running) return json(res, 200, { ok: true });
          run.controller.abort();
          for (const id of [...run.pending.keys()]) resolveApproval(id, "deny");
          emit({ type: "log", line: "stopping after the current step…" });
          return json(res, 200, { ok: true });
        }
        case "/api/commit": {
          if (!root) return json(res, 400, { error: "no repository open" });
          if (run?.running) return json(res, 409, { error: "wait for the task to finish" });
          const message = String(body.message ?? "").trim();
          if (!message) return json(res, 400, { error: "write a commit message" });
          const { files } = workingDiff(root, preexisting(typeof body.task === "string" ? body.task : null));
          if (!files.length) return json(res, 400, { error: "nothing to commit" });
          const add = sh("git", ["add", "-A", "--", ...files], root);
          if (add.code !== 0) return json(res, 500, { error: add.stderr.trim() || "git add failed" });
          const c = sh("git", ["commit", "-m", message], root);
          if (c.code !== 0) return json(res, 500, { error: (c.stderr || c.stdout).trim() || "git commit failed" });
          return json(res, 200, { ok: true, head: sh("git", ["rev-parse", "--short", "HEAD"], root).stdout.trim() });
        }
        case "/api/discard": {
          if (!root) return json(res, 400, { error: "no repository open" });
          if (run?.running) return json(res, 409, { error: "wait for the task to finish" });
          const p = paths(root);
          const g = gitState(root);
          const tracked = [...new Set([...g.dirty, ...g.staged])].filter((f) => !f.startsWith(".narrowbit/"));
          if (tracked.length) {
            const r = sh("git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked], root);
            if (r.code !== 0) return json(res, 500, { error: r.stderr.trim() || "git restore failed" });
          }
          // Only delete new files the task created (per its recorded baseline); anything else untracked is the user's.
          const baseline = untrackedAtStart(p, typeof body.task === "string" ? body.task : null) ?? (run && run.root === root ? run.untrackedBefore : null);
          const created = baseline ? g.untracked.filter((f) => !baseline.has(f) && !f.startsWith(".narrowbit/") && f !== ".narrowbitignore") : [];
          for (const f of created) {
            const abs = safeAbsPath(p, f);
            if (abs) unlinkSync(abs);
          }
          const kept = g.untracked.filter((f) => !created.includes(f) && !f.startsWith(".narrowbit/"));
          return json(res, 200, { ok: true, restored: tracked, deleted: created, kept });
        }
      }
      return json(res, 404, { error: "not found" });
    } catch (e: any) {
      if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) });
    }
  });

  server.listen(opts.port, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    opts.onListening(`http://127.0.0.1:${port}/?t=${token}`);
  });
  return server;
}
