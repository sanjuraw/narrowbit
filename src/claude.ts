import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Paths } from "./config.js";
import { indexRepo, openStore } from "./indexer.js";
import { buildPackage } from "./package.js";
import { Tasks } from "./tasks.js";

/** Absolute command that runs this Narrowbit build, so integrations work without a global install. */
export function selfCommand(): { command: string; args: string[] } {
  const bin = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "narrowbit.js");
  // `node` from PATH rather than process.execPath: versioned install paths (e.g. Homebrew Cellar) break on upgrade.
  return { command: "node", args: [bin] };
}

export function mcpServerConfig(p: Paths, taskId?: string) {
  const self = selfCommand();
  return {
    type: "stdio",
    command: self.command,
    args: [...self.args, "mcp", "--root", p.root],
    env: taskId ? { NARROWBIT_TASK: taskId } : {},
  };
}

export function writeMcpConfigFile(p: Paths, taskId: string): string {
  const file = join(p.tasks, `${taskId}.mcp.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: { narrowbit: mcpServerConfig(p, taskId) } }, null, 2), { mode: 0o600 });
  return file;
}

/** `narrowbit claude "<task>"`: index, compile context, launch Claude Code with it and the MCP tools attached. */
export async function launchClaude(p: Paths, taskText: string, extraArgs: string[], opts: { dryRun?: boolean; budget?: number } = {}): Promise<number> {
  const cfg = loadConfig(p);
  const store = openStore(p);
  indexRepo(p, store);
  const b = buildPackage(store, p, cfg, taskText, { budget: opts.budget, source: "cli" });
  store.close();
  const tasks = new Tasks(p);
  tasks.save(b.record);
  tasks.setCurrent(b.record.id);
  writeFileSync(join(p.tasks, `${b.record.id}.context.md`), b.text, { mode: 0o600 });
  const mcpFile = writeMcpConfigFile(p, b.record.id);
  const args = ["--append-system-prompt", b.text, "--mcp-config", mcpFile, ...extraArgs, taskText];
  process.stderr.write(
    `narrowbit: task ${b.record.id} — ${b.record.selected.filter((s) => s.level !== "listed").length} files in context, ~${b.record.packageTokens} tokens est., confidence ${b.record.confidence}\n`,
  );
  if (opts.dryRun) {
    process.stdout.write(`claude ${args.map((a) => (a.length > 60 ? JSON.stringify(a.slice(0, 57) + "...") : JSON.stringify(a))).join(" ")}\n`);
    return 0;
  }
  return new Promise((res) => {
    const child = spawn("claude", args, { cwd: p.root, stdio: "inherit", env: { ...process.env, NARROWBIT_TASK: b.record.id } });
    child.on("close", (code) => res(code ?? 0));
    child.on("error", (e) => {
      process.stderr.write(`narrowbit: failed to start claude: ${e.message}\n`);
      res(127);
    });
  });
}

function readJson(file: string): any {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`cannot parse ${file}; fix or remove it first`);
  }
}

/**
 * `narrowbit install claude`: register the MCP server (project .mcp.json) and a
 * UserPromptSubmit hook (.claude/settings.local.json) so plain `claude` sessions get
 * Narrowbit context automatically. Idempotent; only touches narrowbit entries.
 */
export function installClaude(p: Paths, opts: { hook: boolean }): string[] {
  const changes: string[] = [];
  const self = selfCommand();
  const mcpPath = join(p.root, ".mcp.json");
  const mcp = readJson(mcpPath);
  mcp.mcpServers ??= {};
  mcp.mcpServers.narrowbit = mcpServerConfig(p);
  delete mcp.mcpServers.narrowbit.env;
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
  changes.push(`${mcpPath}: mcpServers.narrowbit`);

  const settingsPath = join(p.root, ".claude", "settings.local.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  const s = readJson(settingsPath);
  s.enabledMcpjsonServers = [...new Set([...(s.enabledMcpjsonServers ?? []), "narrowbit"])];
  s.permissions ??= {};
  s.permissions.allow = [...new Set([...(s.permissions.allow ?? []), "mcp__narrowbit"])];
  if (opts.hook) {
    const cmd = [self.command, ...self.args, "hook", "prompt"].map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ");
    s.hooks ??= {};
    const list: any[] = (s.hooks.UserPromptSubmit ??= []);
    const filtered = list.filter((m) => !(m.hooks ?? []).some((h: any) => String(h.command ?? "").includes(" hook prompt") && String(h.command).includes("narrowbit")));
    filtered.push({ hooks: [{ type: "command", command: cmd, timeout: 20 }] });
    s.hooks.UserPromptSubmit = filtered;
    changes.push(`${settingsPath}: hooks.UserPromptSubmit → narrowbit hook prompt`);
  }
  writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
  changes.push(`${settingsPath}: enabledMcpjsonServers += narrowbit, permissions.allow += mcp__narrowbit`);
  return changes;
}

interface SessionState {
  sessionId: string;
  transcriptPath?: string;
  given: string[];
  tasks: string[];
  prompts: number;
}

/**
 * UserPromptSubmit hook: compile context for the prompt and hand it to Claude Code as
 * additionalContext. Never blocks or fails the user's session — any error → no output.
 */
export async function hookPrompt(p: Paths, stdin: string): Promise<string> {
  let input: any;
  try {
    input = JSON.parse(stdin);
  } catch {
    return "";
  }
  const prompt: string = String(input.prompt ?? "");
  if (prompt.trim().startsWith("/") || prompt.trim().length < 25) return "";
  if (!existsSync(p.db)) return "";
  const cfg = loadConfig(p);
  const sessFile = join(p.sessions, `${String(input.session_id ?? "unknown").replace(/[^\w-]/g, "")}.json`);
  const sess: SessionState = existsSync(sessFile)
    ? JSON.parse(readFileSync(sessFile, "utf8"))
    : { sessionId: input.session_id, transcriptPath: input.transcript_path, given: [], tasks: [], prompts: 0 };
  sess.prompts++;
  const first = sess.tasks.length === 0;

  const store = openStore(p);
  try {
    indexRepo(p, store);
    const b = buildPackage(store, p, cfg, prompt, {
      source: "hook",
      exclude: new Set(sess.given),
      withProtocol: first,
      budget: first ? cfg.budget.initial : Math.round(cfg.budget.initial / 2),
    });
    // Inject only with a confident anchor and real code to show. General questions ("how do I test
    // this?") match on common words and would otherwise cost tokens for irrelevant context.
    const loaded = b.record.selected.filter((s) => s.level === "full" || s.level === "symbols");
    const t = b.task;
    const codeLike = t.identifiers.length > 0 || t.paths.length > 0 || t.locations.length > 0 || t.mentionsAction;
    if (!codeLike || b.record.confidence === "low" || loaded.length === 0) {
      writeFileSync(sessFile, JSON.stringify(sess, null, 2), { mode: 0o600 });
      return "";
    }
    const tasks = new Tasks(p);
    tasks.save(b.record);
    tasks.setCurrent(b.record.id);
    sess.tasks.push(b.record.id);
    sess.given.push(...b.record.given);
    writeFileSync(sessFile, JSON.stringify(sess, null, 2), { mode: 0o600 });
    const header = first ? "" : "NARROWBIT: additional context for this prompt (items already provided earlier are omitted)\n\n";
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: header + b.text } });
  } finally {
    store.close();
  }
}
