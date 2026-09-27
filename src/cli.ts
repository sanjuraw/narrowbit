import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, relative, resolve } from "node:path";
import { attachmentKind } from "./attachments.js";
import { benchmarkReport, benchmarkTemplate, runBenchmark } from "./bench.js";
import { hookPrompt, installClaude, launchClaude } from "./claude.js";
import { runCommand } from "./compress.js";
import { ensureDirs, findRoot, loadConfig, paths, saveConfig, type Paths } from "./config.js";
import { evalHistory } from "./eval.js";
import { train } from "./train.js";
import { changedSince, gitState } from "./git.js";
import { applyIsolated, discardIsolated, readIsolated } from "./isolate.js";
import { listCheckpoints, restoreCheckpoint } from "./checkpoints.js";
import { findSkills } from "./skillimport.js";
import { fold, readEvents } from "./events.js";
import { indexRepo, openStore } from "./indexer.js";
import { serveMcp } from "./mcp.js";
import { Memory, openMemory, MEMORY_TYPES, renderMemory, type MemoryType } from "./memory.js";
import { buildPackage } from "./package.js";
import { initProject } from "./project.js";
import { expandTask, grepText, outlineText, refsText, searchText, symbolText, testsText } from "./query.js";
import { availableModels, DEFAULT_TIERS, EFFORT_LEVELS, isProvider, parseScout, PHASES, PROVIDER_INFO, PROVIDERS, resolveSelection, unavailableReason, type Phase, type ProviderName, type Selection } from "./providers/models.js";
import { keySource, setKey } from "./keys.js";
import { fmtLimits, readLimits, refreshClaude, refreshCodex } from "./limits.js";
import { checkReadiness, formatReadiness } from "./readiness.js";
import { auditRepo, formatFindings } from "./audit.js";
import { runTask } from "./runtime.js";
import { getConnector, listConnectors, removeConnector, saveConnector } from "./connectors.js";
import { listConnectorTools } from "./mcpClient.js";
import { getSkill, listSkills, removeSkill, renameSkill, saveSkill } from "./skills.js";
import { startUi } from "./ui.js";
import { Tasks, type TaskRecord } from "./tasks.js";
import { fmtNum, now, sh } from "./util.js";
import { verify, verifyRecord } from "./verify.js";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--") {
      a.rest = argv.slice(i + 1);
      break;
    }
    if (x.startsWith("--")) {
      const [k, v] = x.slice(2).split("=", 2);
      if (v !== undefined) a.flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && VALUE_FLAGS.has(k)) a.flags[k] = argv[++i];
      else a.flags[k] = true;
    } else a._.push(x);
  }
  return a;
}

const VALUE_FLAGS = new Set([
  "budget", "root", "reason", "attempt", "result", "files", "note", "commits", "only", "arms", "run", "error-file", "limit", "tags", "baseline", "treatment", "ref", "rerank-weight", "rerank-top", "skip",
  "max-steps", "attach", "scout", "model", "effort", "claude-bin", "compact-threshold", "provider", "explore", "execute", "escalate", "port", "key-env", "continue", "skill", "description", "env",
]);

const HELP = `narrowbit — minimum sufficient context for coding agents

  narrowbit init                      set up .narrowbit/ and index the repository
  narrowbit index [--force]           incremental re-index (files, symbols, imports, tests)
  narrowbit status                    index + task summary

  narrowbit task "<task>"             compile a context package for a task
      [--budget N] [--print] [--json] [--error-file log.txt]
  narrowbit inspect [task-id]         why each file was selected, what was excluded
  narrowbit context [task-id]         print the context package
  narrowbit expand [--budget N]       next most relevant context for the current task
  narrowbit close [--success|--failure] [--note ..]   record outcome + selection recall

  narrowbit symbol <name>             definition source      narrowbit refs <name>     usages
  narrowbit outline <path>            file map                narrowbit tests <path>    mapped tests
  narrowbit search "<query>"          ranked search          narrowbit grep "<text>"   grep tagged with enclosing symbol

  narrowbit run -- <command>          run a command, print compressed output (raw kept in .narrowbit/logs)
  narrowbit verify [--full]           type-check, lint, focused tests for changed files

  narrowbit agent "<task>"            Narrowbit's own agent loop: reads, edits, runs commands,
      [--provider <name>] [--model X | --explore X --execute X --escalate X]
      [--effort low|medium|high|xhigh|max] [--max-steps N] [--force] [--dry-run]
      [--allow-commands]   run shell commands without asking (default: ask before each one)
      [--scout provider:model|none] research first on this model (default: the saved setting)
      [--review-only]         skip the plan call, still review the diff before "done" (cheaper than full lead mode)
      [--approve-plan]        with lead mode, ask you to approve the plan (or ask for changes) before work starts
      [--attach a.png,b.pdf] show the model images or PDFs (sent on the first call only)
      [--test-first]       refuse the first source edit until a check has failed (or a test was edited)
      [--isolate]          work in a separate git worktree; your folder changes only when you run: narrowbit apply <task>
      [--no-boss] [--continue <task-id>]   lead mode (default): model 3 plans first and reviews the
      diff before "done"; --continue sends a follow-up to an earlier task
      verifies and remembers, driving the task end to end in THIS working tree (not a worktree —
      edits are real). Asks before each shell command, and refuses a dirty git tree unless --force.
  narrowbit ui [--port 4747] [--no-open]   the app: run tasks, approve each command, review the diff,
      commit or discard, pick models — in a local window (127.0.0.1 only). The macOS app wraps this.
  narrowbit models                    providers, numbered available models, and this repo's selection
  narrowbit models choose             pick provider, model 1 (explore), 2 (execute), 3 (escalate) and effort from numbered menus
  narrowbit models set <explore|execute|escalate|all> <model name or number> [--provider <name>]
  narrowbit models set scout <provider:model|none>  research first on another model, e.g. codex:gpt-6-sol; the worker gets only its short report
  narrowbit models set fallback <provider|none>   a backup provider that takes over mid-task if the main one hits a limit or fails
  narrowbit models set provider <claude|codex>     narrowbit models set effort <level>
  narrowbit models reset [--provider <name>]   back to the built-in defaults
  narrowbit models endpoint <provider> <base-url|default> [--key-env NAME]   point an API/local provider elsewhere
  narrowbit audit [--changed]         security checkpoint (no model): committed secrets, unignored .env, browser-exposed secrets
  narrowbit doctor                    what can run right now: Claude/Codex login, local servers, API keys
  narrowbit limits [--refresh]        Claude and Codex subscription usage: 5-hour and weekly windows
  narrowbit keys [list]               which API keys are set    narrowbit keys set|remove <provider>
      providers: claude, codex (subscriptions); openrouter (free & paid), groq, gemini (free tiers),
      openai, deepseek (paid); ollama, lmstudio (local, free); freellmapi (your own free-tier gateway); custom (any OpenAI-compatible server)

  narrowbit rewind <task>              list a task's checkpoints (one before it starts, one after each edit)
  narrowbit rewind <task> <checkpoint> restore your folder to that point (or the isolated worktree's, if run with --isolate)

  narrowbit memory add <type> "<text>" [--reason ..] [--attempt ..] [--result ..] [--files a,b]
      types: ${MEMORY_TYPES.join(", ")}
  narrowbit memory list [type]        narrowbit memory resolve <id>   narrowbit memory supersede <id>

  narrowbit skills [show <name>]      list skills, or print one          reusable task templates
  narrowbit skills add "<name>" "<instructions>" [--description "..."]   create or overwrite a skill
  narrowbit skills rename "<old>" "<new>"       narrowbit skills remove "<name>"
  narrowbit agent --skill "<name>" ["<task>"]   run the agent with a skill's instructions applied

  narrowbit connectors                list configured connectors — any MCP server the agent can call out to
  narrowbit connectors add "<name>" [--env K=V,K2=V2] -- <command> [args...]   e.g. GitHub's MCP server
  narrowbit connectors test "<name>"  connect once, list its tools     narrowbit connectors remove "<name>"

  narrowbit claude "<task>" [--dry-run] [-- <claude args>]   launch Claude Code with Narrowbit context + MCP tools
  narrowbit install claude [--no-hook]                        register MCP server + UserPromptSubmit hook in this repo
  narrowbit mcp                       MCP stdio server (used by agents)

  narrowbit train [--commits 150] [--skip N]   learn ranking weights from this repo's history (local, no model calls)
  narrowbit eval [--commits 40] [--rerank]   offline selection benchmark over git history (--rerank A/Bs a hosted decision model)
  narrowbit benchmark init            write a benchmark task template (benchmark.json)
  narrowbit benchmark run <file> [--only id,..] [--arms native,narrowbit] [--dry-run]
  narrowbit benchmark report [--run id]
  narrowbit stats                     aggregate metrics from recorded tasks
`;

function out(s: string) {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

function strFlag(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** Refuse to set up in a folder that isn't a project (e.g. $HOME): it would index unrelated files. */
function requireProject(p: Paths, force: boolean) {
  if (force) return;
  const isProject = ["package.json", "tsconfig.json", "jsconfig.json"].some((f) => existsSync(join(p.root, f))) || existsSync(join(p.root, ".git"));
  if (!isProject || p.root === process.env.HOME) {
    process.stderr.write(`narrowbit: ${p.root} does not look like a project (no .git, package.json or tsconfig.json).\nRun this from inside your repository, or pass --force.\n`);
    process.exit(2);
  }
}

function requireInit(p: Paths) {
  if (!existsSync(p.db)) {
    process.stderr.write(`narrowbit: not initialised in ${p.root} — run \`narrowbit init\`\n`);
    process.exit(2);
  }
}

function printIndexStats(s: ReturnType<typeof indexRepo>) {
  out(
    `indexed ${fmtNum(s.files)} files (${s.parsed} parsed, ${s.unchanged} unchanged, ${s.removed} removed) — ${fmtNum(s.symbols)} symbols, ` +
      `${fmtNum(s.resolvedImports)}/${fmtNum(s.imports)} imports resolved, ${s.testLinks} test links — ${s.ms} ms`,
  );
}

function loadTask(tasks: Tasks, id?: string): TaskRecord {
  const tid = id ?? tasks.current();
  const t = tid ? tasks.load(tid) : null;
  if (!t) {
    process.stderr.write(`narrowbit: no task${id ? ` ${id}` : " (run `narrowbit task \"...\"` first)"}\n`);
    process.exit(2);
  }
  return t;
}

function readStdin(): Promise<string> {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res("");
    const chunks: Buffer[] = [];
    process.stdin.on("data", (d) => chunks.push(d));
    process.stdin.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
  });
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const [cmd, ...pos] = args._;
  if (!cmd || cmd === "help" || args.flags.help) {
    out(HELP);
    return 0;
  }
  const root = args.flags.root ? resolve(String(args.flags.root)) : findRoot();
  const p = paths(root);

  switch (cmd) {
    case "init": {
      requireProject(p, !!args.flags.force);
      const { stats } = initProject(p, { index: !args.flags["no-index"] });
      out(`initialised ${relative(process.cwd(), p.nb) || p.nb}`);
      const cfg = loadConfig(p);
      const v = Object.entries(cfg.verify);
      out(v.length ? `verify commands: ${v.map(([k, c]) => `${k}=\`${c}\``).join(", ")}` : "verify commands: none detected (edit .narrowbit/config.json)");
      if (stats) printIndexStats(stats);
      // The checkpoint every project gets on day one: cheap, offline, and it runs before anything is pushed.
      const found = auditRepo(root, { history: false }).filter((f) => f.severity === "high");
      out(found.length ? `security: ${found.length} high-severity issue(s) already in this project — run \`narrowbit audit\`` : "security: no committed secrets found. Before you share or ship, run `narrowbit audit` and the built-in \"Security review\" skill.");
      return 0;
    }
    case "index": {
      ensureDirs(p);
      const store = openStore(p);
      printIndexStats(indexRepo(p, store, { force: !!args.flags.force }));
      store.close();
      return 0;
    }
    case "status": {
      requireInit(p);
      const store = openStore(p);
      const f = store.get<{ n: number; t: number }>("SELECT count(*) n, sum(tokens) t FROM files")!;
      const byKind = store.all<{ kind: string; n: number; t: number }>("SELECT kind, count(*) n, sum(tokens) t FROM files GROUP BY kind ORDER BY n DESC");
      const s = store.get<{ n: number }>("SELECT count(*) n FROM symbols")!;
      out(`root: ${root}`);
      out(`indexed: ${fmtNum(f.n)} files, ~${fmtNum(f.t ?? 0)} tokens est., ${fmtNum(s.n)} symbols (at ${store.getMeta("indexed_at") ?? "never"})`);
      out(`  ${byKind.map((k) => `${k.kind}: ${k.n} (~${fmtNum(k.t)} tok)`).join(", ")}`);
      const tasks = new Tasks(p);
      const cur = tasks.current();
      out(`tasks: ${tasks.list().length} recorded${cur ? `, current ${cur}` : ""}`);
      out(`memory: ${openMemory(p).load().filter((e) => e.status === "active").length} active entries`);
      store.close();
      return 0;
    }
    case "task": {
      requireInit(p);
      let text = pos.join(" ");
      if (args.flags["error-file"]) text += "\n\n" + readFileSync(String(args.flags["error-file"]), "utf8").slice(0, 20_000);
      if (!text.trim()) text = await readStdin();
      if (!text.trim()) {
        process.stderr.write("usage: narrowbit task \"<task description>\"\n");
        return 2;
      }
      const cfg = loadConfig(p);
      const store = openStore(p);
      indexRepo(p, store);
      const b = buildPackage(store, p, cfg, text, { budget: args.flags.budget ? Number(args.flags.budget) : undefined });
      store.close();
      const tasks = new Tasks(p);
      tasks.save(b.record);
      tasks.setCurrent(b.record.id);
      const ctxFile = join(p.tasks, `${b.record.id}.context.md`);
      writeFileSync(ctxFile, b.text, { mode: 0o600 });
      if (args.flags.json) {
        out(JSON.stringify({ ...b.record, contextFile: ctxFile }, null, 2));
        return 0;
      }
      if (args.flags.print) {
        out(b.text);
        return 0;
      }
      const r = b.record;
      const loaded = r.selected.filter((s) => s.level === "full" || s.level === "symbols");
      const outlined = r.selected.filter((s) => s.level === "outline");
      const syms = [...new Set(r.selected.flatMap((s) => s.symbols))].slice(0, 8);
      out(`task ${r.id}  (ranked in ${r.stats.rankMs} ms, confidence ${r.confidence})`);
      if (syms.length) out(`\nrelevant symbols:\n${syms.map((s) => `  ${s}`).join("\n")}`);
      out(`\ncode loaded (${loaded.length}):\n${loaded.map((s) => `  ${s.level === "full" ? "■" : "▣"} ${s.path}  [${s.score.toFixed(1)}] ${s.level}`).join("\n") || "  (none)"}`);
      if (outlined.length) out(`outlined (${outlined.length}):\n${outlined.map((s) => `  □ ${s.path}  [${s.score.toFixed(1)}]`).join("\n")}`);
      out(`tests: ${r.tests.length ? r.tests.join(", ") : "none mapped"}`);
      out(`project memory: ${r.memory.length} entr${r.memory.length === 1 ? "y" : "ies"}`);
      out(`\ncontext package:           ~${fmtNum(r.packageTokens)} tokens est. (budget ${fmtNum(r.budget)})`);
      out(`same files read in full:   ~${fmtNum(r.stats.selectedFullTokens)} tokens est.`);
      out(`all indexed code:          ~${fmtNum(r.stats.repoCodeTokens)} tokens est. (${fmtNum(r.stats.codeFiles)} files)`);
      out(`(estimates only — real savings vs. native agents are measured with \`narrowbit benchmark\`)`);
      out(`\npackage: ${relative(process.cwd(), ctxFile)}\nnext: narrowbit claude "${text.length > 50 ? text.slice(0, 47) + "..." : text}"  |  narrowbit inspect  |  narrowbit context`);
      return 0;
    }
    case "inspect": {
      requireInit(p);
      const t = loadTask(new Tasks(p), pos[0]);
      const store = openStore(p);
      const total = store.get<{ n: number }>("SELECT count(*) n FROM files")!.n;
      store.close();
      out(`TASK ${t.id}: ${t.text.split("\n")[0].slice(0, 120)}`);
      out(`confidence ${t.confidence}; package ~${t.packageTokens} tokens est.\n`);
      out("CONTEXT SELECTED");
      for (const s of t.selected.filter((x) => x.level !== "listed")) {
        out(`✓ ${s.path}  [${s.score.toFixed(1)}] ${s.level}${s.symbols.length ? ` → ${s.symbols.slice(0, 4).join(", ")}` : ""}`);
        for (const r of s.reasons.slice(0, 5)) out(`    ${r}`);
      }
      const listed = t.selected.filter((x) => x.level === "listed");
      if (listed.length) {
        out("\nCANDIDATES NOT LOADED (budget)");
        for (const s of listed.slice(0, 10)) out(`· ${s.path}  [${s.score.toFixed(1)}] ${s.reasons[0] ?? ""}`);
      }
      if (t.tests.length) out(`\nTESTS\n${t.tests.map((x) => `✓ ${x}`).join("\n")}`);
      if (t.memory.length) out(`\nMEMORY\n${t.memory.join(", ")}`);
      out(`\nEXCLUDED\n${fmtNum(Math.max(0, total - t.selected.length))} files with no relevance signal.`);
      if (t.events.length) {
        out(`\nAGENT REQUESTS (${t.events.length})`);
        for (const e of t.events) out(`  ${e.at.slice(11, 19)} ${e.tool} ${JSON.stringify(e.args).slice(0, 80)} → ~${e.tokens} tok`);
      }
      if (t.runs.length) {
        out(`\nCOMMANDS (${t.runs.length})`);
        for (const r of t.runs) out(`  ${r.command.slice(0, 60)} exit ${r.exit}: ~${fmtNum(r.rawTokens)} → ~${fmtNum(r.compressedTokens)} tok (${r.kind})`);
      }
      if (t.closed) out(`\nOUTCOME ${t.closed.outcome}; modified ${t.closed.filesModified.length}, selection recall ${t.closed.recall === null ? "n/a" : (t.closed.recall * 100).toFixed(0) + "%"}${t.closed.missed.length ? `; missed: ${t.closed.missed.join(", ")}` : ""}`);
      return 0;
    }
    case "context": {
      const t = loadTask(new Tasks(p), pos[0]);
      const f = join(p.tasks, `${t.id}.context.md`);
      out(existsSync(f) ? readFileSync(f, "utf8") : "(no saved package for this task)");
      return 0;
    }
    case "expand": {
      requireInit(p);
      const tasks = new Tasks(p);
      const t = loadTask(tasks, pos[0]);
      const store = openStore(p);
      indexRepo(p, store);
      const r = expandTask(p, loadConfig(p), store, t, args.flags.budget ? Number(args.flags.budget) : 4000);
      store.close();
      tasks.update(t.id, (x) => {
        x.given.push(...r.given);
        x.events.push({ at: now(), tool: "cli:expand", args: {}, tokens: Math.ceil(r.text.length / 3.6) });
      });
      out(r.text);
      return 0;
    }
    case "close": {
      requireInit(p);
      const tasks = new Tasks(p);
      const t = loadTask(tasks, pos[0]);
      const outcome = args.flags.success ? "success" : args.flags.failure ? "failure" : args.flags.abandoned ? "abandoned" : "unknown";
      const changed = t.head ? changedSince(root, t.head).filter((f) => !f.startsWith(".narrowbit/") && !t.dirtyAtStart.includes(f)) : [];
      const sel = new Set(t.selected.filter((s) => s.level !== "listed").map((s) => s.path));
      const store = openStore(p);
      const known = changed.filter((f) => store.fileByPath(f) && !/\.(?:test|spec)\./.test(f));
      store.close();
      const selectedModified = known.filter((f) => sel.has(f));
      const missed = known.filter((f) => !sel.has(f));
      const updated = tasks.update(t.id, (x) => {
        x.closed = {
          at: now(),
          outcome,
          filesModified: changed,
          selectedModified,
          missed,
          recall: known.length ? selectedModified.length / known.length : null,
          note: typeof args.flags.note === "string" ? args.flags.note : undefined,
        };
      })!;
      if (tasks.current() === t.id) tasks.setCurrent(null);
      const c = updated.closed!;
      out(`closed ${t.id}: ${outcome}; ${changed.length} file(s) changed; selection recall ${c.recall === null ? "n/a" : (c.recall * 100).toFixed(0) + "%"}${missed.length ? `; not in package: ${missed.join(", ")}` : ""}`);
      out("tip: record what you learned — narrowbit memory add decision|failure|constraint \"...\"");
      return 0;
    }
    case "symbol":
    case "grep":
    case "refs":
    case "outline":
    case "search":
    case "tests": {
      requireInit(p);
      const q = pos.join(" ");
      if (!q) {
        process.stderr.write(`usage: narrowbit ${cmd} <${cmd === "outline" || cmd === "tests" ? "path" : "name"}>\n`);
        return 2;
      }
      const store = openStore(p);
      indexRepo(p, store);
      const text =
        cmd === "symbol" ? symbolText(p, store, q)
        : cmd === "grep" ? grepText(p, store, q, { regex: !!args.flags.regex })
        : cmd === "refs" ? refsText(store, q)
        : cmd === "outline" ? outlineText(store, q)
        : cmd === "tests" ? testsText(store, q)
        : searchText(p, store, q, args.flags.limit ? Number(args.flags.limit) : 10);
      store.close();
      out(text);
      return 0;
    }
    case "run": {
      ensureDirs(p);
      const command = (args.rest.length ? args.rest : pos).join(" ");
      if (!command) {
        process.stderr.write("usage: narrowbit run -- <command>\n");
        return 2;
      }
      const r = await runCommand(p, command);
      const tasks = new Tasks(p);
      const id = tasks.current();
      if (id)
        tasks.update(id, (t) =>
          t.runs.push({ at: now(), command, exit: r.exit, rawLog: r.rawLog, rawTokens: r.rawTokens, compressedTokens: r.compressedTokens, kind: r.compressed.kind }),
        );
      out(r.rendered);
      process.stderr.write(`narrowbit: ~${fmtNum(r.rawTokens)} → ~${fmtNum(r.compressedTokens)} tokens est.\n`);
      return r.exit;
    }
    case "verify": {
      requireInit(p);
      const cfg = loadConfig(p);
      const tasks = new Tasks(p);
      const id = tasks.current();
      const t = id ? tasks.load(id) : null;
      const store = openStore(p);
      indexRepo(p, store);
      const v = await verify(p, cfg, store, t, { full: !!args.flags.full });
      store.close();
      if (t) tasks.update(t.id, (x) => (x.verify = verifyRecord(v)));
      out(v.report);
      return v.ok ? 0 : 1;
    }
    case "agent": {
      requireInit(p);
      let text = pos.join(" ");
      if (!text && !args.flags.skill) {
        process.stderr.write('usage: narrowbit agent "<task>" [--skill <name>] [--provider <name>] [--model X | --explore X --execute X --escalate X] [--effort medium] [--max-steps N] [--force] [--dry-run]\n');
        return 2;
      }
      if (args.flags.skill) {
        const s = getSkill(p, String(args.flags.skill));
        if (!s) {
          process.stderr.write(`narrowbit: no skill named "${args.flags.skill}" (narrowbit skills to list)\n`);
          return 2;
        }
        // The skill is a reusable instruction template, not the task itself — any task text given
        // is the specific request; the skill supplies the standing "how" around it.
        text = text ? `${s.body}\n\n${text}` : s.body;
      }
      const g = gitState(root);
      // A follow-up (--continue) builds on the earlier request's uncommitted edits, so it skips this.
      if (g.isRepo && (g.dirty.length || g.staged.length) && !args.flags.force && !strFlag(args, "continue")) {
        process.stderr.write(
          `narrowbit: working tree has uncommitted changes (${g.dirty.length + g.staged.length} file(s)) — commit or stash first, or pass --force to let the agent's edits mix with them.\n`,
        );
        return 2;
      }
      const headBefore = g.head;
      const cfg = loadConfig(p);
      let sel: Selection;
      try {
        sel = resolveSelection(cfg.agent, {
          provider: strFlag(args, "provider"),
          model: strFlag(args, "model"),
          explore: strFlag(args, "explore"),
          execute: strFlag(args, "execute"),
          escalate: strFlag(args, "escalate"),
          effort: strFlag(args, "effort"),
        });
      } catch (e: any) {
        process.stderr.write(`narrowbit: ${e.message}\n`);
        return 2;
      }
      const maxSteps = args.flags["max-steps"] ? Number(args.flags["max-steps"]) : 20;
      const modelsLine = `provider=${sel.provider}  models: explore=${sel.tiers.explore} execute=${sel.tiers.execute} escalate=${sel.tiers.escalate}  effort=${sel.effort}  lead mode: ${args.flags["no-boss"] || cfg.agent?.boss === false ? "off" : `on (${sel.tiers.escalate} plans + reviews)`}`;
      if (args.flags["dry-run"]) {
        const verifyEntries = Object.entries(cfg.verify).filter(([, v]) => v);
        out(`narrowbit agent (dry run): ${text}`);
        out(modelsLine);
        out(`max steps: ${maxSteps}`);
        out(`verify: ${verifyEntries.length ? verifyEntries.map(([k, v]) => `${k}=${v}`).join(", ") : "(none)"}`);
        return 0;
      }
      const unavailable = unavailableReason(sel, cfg.agent);
      if (unavailable) {
        process.stderr.write(`narrowbit: ${unavailable}\n`);
        return 2;
      }
      out(`narrowbit agent: ${text}`);
      out(`${modelsLine}\n`);
      // The agent runs shell commands, and it reads files that can contain instructions aimed at it, so
      // like the app the terminal asks first. --allow-commands opts out (scripts, or a repo you trust).
      let allowAll = !!args.flags["allow-commands"];
      const approve = async (command: string): Promise<boolean> => {
        if (allowAll) return true;
        if (!process.stdin.isTTY) {
          process.stderr.write(`      ! not run (no terminal to ask): ${command}   — pass --allow-commands to let the agent run commands unattended\n`);
          return false;
        }
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        const a = (await rl.question(`      run \`${command}\`? [y]es / [n]o / [a]lways for this task: `)).trim().toLowerCase();
        rl.close();
        if (a === "a") allowAll = true;
        return a === "y" || a === "a";
      };
      const ask = async (question: string, options: string[]): Promise<string | null> => {
        if (!process.stdin.isTTY) return null;
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        process.stderr.write(`\n      ? ${question}\n${options.map((o, i) => `        ${i + 1}) ${o}\n`).join("")}`);
        const a = (await rl.question("      your answer: ")).trim();
        rl.close();
        const n = Number(a);
        return options.length && Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : a || null;
      };
      const attachments = (strFlag(args, "attach") ?? "").split(",").map((f) => f.trim()).filter(Boolean).map((f) => resolve(f));
      for (const f of attachments) if (!attachmentKind(f) || !existsSync(f)) throw new Error(`--attach: ${f} is not an existing image (png, jpg, gif, webp) or PDF`);
      const scoutFlag = strFlag(args, "scout");
      const scoutSpec = scoutFlag === "none" || scoutFlag === "off" ? undefined : (scoutFlag ?? cfg.agent?.scout);
      if (scoutFlag && scoutFlag !== "none" && scoutFlag !== "off" && !parseScout(scoutFlag)) {
        process.stderr.write("narrowbit: --scout must look like provider:model, for example codex:gpt-6-sol (or none)\n");
        return 2;
      }
      const result = await runTask(p, text, {
        scout: parseScout(scoutSpec) ?? undefined,
        attachments,
        approve,
        ask,
        isolate: !!args.flags.isolate,
        testFirst: !!args.flags["test-first"],
        maxSteps,
        boss: args.flags["no-boss"] ? false : (cfg.agent?.boss ?? true),
        reviewOnly: !!args.flags["review-only"],
        planApproval: !!args.flags["approve-plan"],
        continueTask: strFlag(args, "continue"),
        provider: sel.provider,
        models: sel.tiers,
        effort: sel.effort,
        claudeBin: typeof args.flags["claude-bin"] === "string" ? args.flags["claude-bin"] : undefined,
        compactThreshold: args.flags["compact-threshold"] ? Number(args.flags["compact-threshold"]) : undefined,
        log: (line) => process.stderr.write(line + "\n"),
      });
      const changed = headBefore ? changedSince(root, headBefore).filter((f) => !f.startsWith(".narrowbit/")) : [];
      const label = result.outcome === "done" ? "DONE" : result.outcome === "blocked" ? "BLOCKED" : result.outcome === "error" ? "ERROR" : result.outcome === "stopped" ? "STOPPED" : "STOPPED (step budget)";
      out(`\n${label}: ${result.summary}`);
      out(`${result.steps} step(s)${result.compactions ? `, ${result.compactions} compaction(s)` : ""} — files changed: ${changed.length ? changed.join(", ") : "(none)"}`);
      const state = fold(result.taskId, readEvents(p, result.taskId));
      const roles = Object.values(state.ledgerByRole);
      const totalTok = roles.reduce((a, r) => a + r.inputTokens + r.cacheCreationTokens + r.cacheReadTokens + r.outputTokens, 0);
      const totalCost = roles.reduce((a, r) => a + r.costUsd, 0);
      out(`usage: ~${fmtNum(totalTok)} tokens, ~$${totalCost.toFixed(3)} notional (subscription usage — nothing is billed per token)`);
      if (result && args.flags.isolate && readIsolated(p, result.taskId)) out(`\nmade in a separate copy — nothing in your folder changed yet.\n  bring the changes over:  narrowbit apply ${result.taskId}\n  throw them away:         narrowbit discard ${result.taskId}`);
      out(`task: ${result.taskId}  (full log: .narrowbit/runtime/${result.taskId}/events.jsonl)`);
      if (result.outcome !== "done") out(`tip: review the diff before trusting this — the task did not report a clean completion.`);
      return result.outcome === "done" ? 0 : result.outcome === "blocked" ? 1 : 2;
    }
    case "ui": {
      // --app: launched by the macOS app, which has no meaningful cwd — open the last-used repo
      // instead, and exit when the app closes our stdin (so a crashed app never leaves us running).
      const fromApp = !!args.flags.app;
      const uiRoot = args.flags.root || (!fromApp && root !== "/" && root !== process.env.HOME) ? root : null;
      const port = args.flags.port ? Number(args.flags.port) : fromApp ? 0 : 4747;
      startUi({
        root: uiRoot,
        port,
        restartOnUpdate: fromApp && process.env.NARROWBIT_SHELL_RESTART === "1",
        onListening: (url) => {
          out(`narrowbit ui: ${url}`);
          if (!fromApp && !args.flags["no-open"] && process.platform === "darwin") sh("open", [url], process.cwd());
          else if (!fromApp) out("open that address in a browser; Ctrl+C to stop");
        },
      });
      if (fromApp) {
        process.stdin.on("end", () => process.exit(0));
        process.stdin.resume();
      }
      return await new Promise<number>(() => {});
    }
    case "limits": {
      // Codex is asked directly (free); Claude's reading comes from the latest call, or --refresh
      // makes one tiny Haiku call to get a current one.
      const [claude, codex] = await Promise.all([
        args.flags.refresh || !readLimits().claude ? refreshClaude(strFlag(args, "claude-bin")) : Promise.resolve(readLimits().claude),
        refreshCodex(),
      ]);
      out(fmtLimits("Claude", claude));
      out(fmtLimits("Codex ", codex));
      if (!args.flags.refresh && claude) out("(Claude's reading is from its most recent call; --refresh checks now with one tiny Haiku call)");
      return 0;
    }
    case "keys": {
      // API keys live in ~/.narrowbit/keys.json (0600), shared by every repo; env vars win.
      const [sub, prov] = pos;
      if (sub === "set" || sub === "remove") {
        if (!prov || !isProvider(prov) || PROVIDER_INFO[prov].kind === "subscription") {
          process.stderr.write(`usage: narrowbit keys ${sub} <${PROVIDERS.filter((x) => PROVIDER_INFO[x].kind !== "subscription").join("|")}>\n`);
          return 2;
        }
        if (sub === "remove") {
          setKey(prov, null);
          out(`removed the saved ${PROVIDER_INFO[prov].label} key`);
          return 0;
        }
        // Read the key without echoing it or putting it on the command line (shell history).
        let key = "";
        if (process.stdin.isTTY) {
          process.stdout.write(`${PROVIDER_INFO[prov].label} API key${PROVIDER_INFO[prov].keyUrl ? ` (from ${PROVIDER_INFO[prov].keyUrl})` : ""}: `);
          process.stdin.setRawMode(true);
          key = await new Promise<string>((res) => {
            let buf = "";
            const onData = (d: Buffer) => {
              for (const ch of d.toString("utf8")) {
                if (ch === "\r" || ch === "\n") {
                  process.stdin.off("data", onData);
                  process.stdin.setRawMode(false);
                  process.stdin.pause();
                  process.stdout.write("\n");
                  return res(buf);
                }
                if (ch === "\u0003") {
                  process.stdin.setRawMode(false);
                  process.stdout.write("\n");
                  process.exit(1);
                }
                if (ch === "\u007f") buf = buf.slice(0, -1);
                else buf += ch;
              }
            };
            process.stdin.on("data", onData);
            process.stdin.resume();
          });
        } else key = (await readStdin()).trim();
        if (!key.trim()) {
          process.stderr.write("narrowbit: no key entered — nothing saved\n");
          return 1;
        }
        setKey(prov, key);
        out(`saved the ${PROVIDER_INFO[prov].label} key to ~/.narrowbit/keys.json (readable only by you)`);
        return 0;
      }
      if (sub && sub !== "list") {
        process.stderr.write("usage: narrowbit keys [list | set <provider> | remove <provider>]\n");
        return 2;
      }
      for (const pr of PROVIDERS) {
        const info = PROVIDER_INFO[pr];
        if (info.kind !== "api") continue;
        const src = keySource(pr, info.keyEnv);
        out(`  ${pr.padEnd(11)} ${src === "env" ? `set (from $${info.keyEnv})` : src === "file" ? "set (saved)" : "not set"}${!src && info.keyUrl ? `   — get one at ${info.keyUrl}` : ""}`);
      }
      return 0;
    }
    case "models": {
      const cfg = loadConfig(p);
      const sub = pos[0];
      if (!sub) {
        let current: Selection;
        try {
          current = resolveSelection(cfg.agent);
        } catch (e: any) {
          process.stderr.write(`narrowbit: ${e.message} — fix .narrowbit/config.json or run \`narrowbit models set provider claude\`\n`);
          return 2;
        }
        out(`default provider: ${current.provider}   effort: ${current.effort}${existsSync(p.config) ? "" : "   (built-in defaults; nothing saved for this repo yet)"}\n`);
        for (const prov of PROVIDERS) {
          const s = resolveSelection(cfg.agent, { provider: prov });
          const info = PROVIDER_INFO[prov];
          const why = unavailableReason(s, cfg.agent);
          const chosen = PHASES.some((ph) => s.tiers[ph]) ? `  ${PHASES.map((ph) => `${ph}=${s.tiers[ph] || "?"}`).join(" ")}` : "";
          out(`${prov === current.provider ? "*" : " "} ${prov.padEnd(11)} ${info.label} — ${info.kind}, ${info.pricing}${chosen}${why ? `\n               not ready: ${why}` : ""}`);
        }
        // Model catalogs can be long (OpenRouter lists hundreds), so only the default provider's.
        const avail = await availableModels(current.provider, cfg.agent);
        out(`\n${current.provider} models: ${avail.models.length ? (avail.models.length > 40 ? `${avail.models.length} available${avail.free.length ? ` (${avail.free.length} free: ${avail.free.slice(0, 12).join(", ")}${avail.free.length > 12 ? ", …" : ""})` : ""}` : `\n${avail.models.map((m, i) => `  ${String(i + 1).padStart(2)}) ${m}${avail.labels[m] ? `  — ${avail.labels[m]}` : ""}`).join("\n")}`) : "(unknown)"}\n  (${avail.note})`);
        out("switch with `narrowbit models set provider <name>` or `narrowbit models choose`");
        return 0;
      }
      if (sub === "choose") {
        if (!process.stdin.isTTY) {
          process.stderr.write("narrowbit: `models choose` is interactive — in scripts use `narrowbit models set <slot> <number|name>`\n");
          return 2;
        }
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const pick = async (title: string, options: readonly string[], current: string, o: { labels?: string[]; allowName?: boolean } = {}): Promise<string> => {
          out(`\n${title}`);
          options.forEach((opt, i) => out(`  ${i + 1}) ${o.labels?.[i] ?? opt}${opt === current ? "   ← current" : ""}`));
          const keep = current ? `, or Enter to keep ${current}` : "";
          for (;;) {
            const a = (await rl.question(`choose 1-${options.length}${o.allowName ? " or type a model id" : ""}${keep}: `)).trim();
            if (!a && current) return current;
            const n = Number(a);
            if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
            if (a && o.allowName && !/^\d+$/.test(a)) return a;
            out(a ? `  "${a}" isn't one of the numbers above` : "  a model is required here");
          }
        };
        try {
          const agent = (cfg.agent ??= {});
          const start = resolveSelection(isProvider(agent.provider ?? "claude") ? agent : { ...agent, provider: "claude" });
          const provider = (await pick("Provider", PROVIDERS, start.provider, {
            labels: PROVIDERS.map((pr) => `${PROVIDER_INFO[pr].label} — ${PROVIDER_INFO[pr].kind}, ${PROVIDER_INFO[pr].pricing}`),
          })) as ProviderName;
          const current = resolveSelection(agent, { provider });
          const avail = await availableModels(provider, agent);
          // Long catalogs: number the free models (or the first 40) and accept any typed id.
          const long = avail.models.length > 40;
          const menu = long ? (avail.free.length ? avail.free : avail.models).slice(0, 40) : avail.models;
          if (long) out(`\n${avail.models.length} ${provider} models available — listing ${avail.free.length ? "free ones" : "the first 40"}; type any other id directly.`);
          if (!avail.models.length) out(`\n(no model list: ${avail.note} — type model ids directly)`);
          const pickOpts = { allowName: long || !avail.models.length || PROVIDER_INFO[provider].kind !== "subscription" };
          const slots: Record<Phase, string> = {
            explore: "Model 1 — explore: reading and orienting, before any edit (a cheap model is usually enough)",
            execute: "Model 2 — execute: making edits and verifying them",
            escalate: "Model 3 — escalate: only when the loop is stuck (your strongest model)",
          };
          const saved = ((agent.models ??= {})[provider] ??= {});
          const modelLabels = menu.map((m) => (avail.labels[m] ? `${m}  — ${avail.labels[m]}` : m));
          for (const ph of PHASES) saved[ph] = await pick(slots[ph], menu, current.tiers[ph], { ...pickOpts, labels: modelLabels });
          agent.effort = await pick("Effort", EFFORT_LEVELS, current.effort);
          agent.provider = provider;
          ensureDirs(p);
          saveConfig(p, cfg);
          out(`\nsaved for this repo: provider=${provider}  ${PHASES.map((ph) => `${ph}=${saved[ph]}`).join("  ")}  effort=${agent.effort}`);
          const why = unavailableReason(resolveSelection(agent, { provider }), agent);
          if (why) out(`note: ${why}`);
          return 0;
        } catch (e: any) {
          // Ctrl+C / Ctrl+D mid-menu: nothing has been saved yet, so just say so.
          if (e?.name === "AbortError" || e?.code === "ABORT_ERR") {
            out("\ncancelled — nothing saved");
            return 1;
          }
          throw e;
        } finally {
          rl.close();
        }
      }
      if (sub === "endpoint") {
        // narrowbit models endpoint <provider> <base-url|default> [--key-env NAME]
        const [prov, url] = [pos[1], pos[2]];
        if (!prov || !isProvider(prov) || PROVIDER_INFO[prov].kind === "subscription" || !url) {
          process.stderr.write("usage: narrowbit models endpoint <openrouter|groq|gemini|openai|deepseek|ollama|lmstudio|custom> <base-url|default> [--key-env NAME]\n");
          return 2;
        }
        const agent = (cfg.agent ??= {});
        const eps = (agent.endpoints ??= {});
        if (url === "default") delete eps[prov];
        else eps[prov] = { ...eps[prov], baseUrl: url, ...(strFlag(args, "key-env") ? { keyEnv: strFlag(args, "key-env") } : {}) };
        ensureDirs(p);
        saveConfig(p, cfg);
        out(`${prov}: ${url === "default" ? `back to ${PROVIDER_INFO[prov].baseUrl ?? "(no default)"}` : url}`);
        return 0;
      }
      if (sub !== "set" && sub !== "reset") {
        process.stderr.write("usage: narrowbit models [choose | set <explore|execute|escalate|all|provider|effort> <value> [--provider X] | reset [--provider X]]\n");
        return 2;
      }
      const agent = (cfg.agent ??= {});
      const provider = strFlag(args, "provider") ?? agent.provider ?? "claude";
      if (!isProvider(provider)) {
        process.stderr.write(`narrowbit: unknown provider "${provider}" (expected one of ${PROVIDERS.join(", ")})\n`);
        return 2;
      }
      if (sub === "reset") {
        if (agent.models) delete agent.models[provider];
        ensureDirs(p);
        saveConfig(p, cfg);
        out(`${provider}: models reset to defaults (${PHASES.map((ph) => `${ph}=${DEFAULT_TIERS[provider][ph]}`).join(" ")})`);
        return 0;
      }
      const [key, value] = [pos[1], pos[2]];
      if (!key || !value) {
        process.stderr.write("usage: narrowbit models set <explore|execute|escalate|all|provider|effort|fallback|scout> <value> [--provider <name>]\n");
        return 2;
      }
      if (key === "provider") {
        if (!isProvider(value)) {
          process.stderr.write(`narrowbit: unknown provider "${value}" (expected one of ${PROVIDERS.join(", ")})\n`);
          return 2;
        }
        agent.provider = value;
      } else if (key === "fallback") {
        if (value === "none" || value === "off") delete agent.fallback;
        else if (!isProvider(value)) {
          process.stderr.write(`narrowbit: unknown provider "${value}" (expected one of ${PROVIDERS.join(", ")}, or none)\n`);
          return 2;
        } else agent.fallback = value;
      } else if (key === "scout") {
        if (value === "none" || value === "off") delete agent.scout;
        else if (!parseScout(value)) {
          process.stderr.write(`narrowbit: scout must look like provider:model, for example codex:gpt-6-sol (or none)\n`);
          return 2;
        } else agent.scout = value;
      } else if (key === "effort") {
        agent.effort = value;
      } else if (key === "all" || (PHASES as readonly string[]).includes(key)) {
        const avail = await availableModels(provider, agent);
        // A number picks from the numbered "available" list that `narrowbit models` prints.
        let model = value;
        if (/^\d+$/.test(value)) {
          const i = Number(value) - 1;
          if (!avail.models[i]) {
            process.stderr.write(`narrowbit: no model number ${value} for ${provider} (${avail.models.slice(0, 40).map((m, j) => `${j + 1}) ${m}`).join("  ") || "none listed"})\n`);
            return 2;
          }
          model = avail.models[i];
        } else if (provider !== "claude" && avail.models.length && !avail.models.includes(value)) {
          process.stderr.write(`narrowbit: warning — "${value}" isn't in ${PROVIDER_INFO[provider].label}'s model list; saving anyway\n`);
        }
        const phases: Phase[] = key === "all" ? [...PHASES] : [key as Phase];
        const saved = ((agent.models ??= {})[provider] ??= {});
        for (const ph of phases) saved[ph] = model;
      } else {
        process.stderr.write(`narrowbit: unknown setting "${key}" (expected explore, execute, escalate, all, provider or effort)\n`);
        return 2;
      }
      ensureDirs(p);
      saveConfig(p, cfg);
      const shown = key === "provider" ? (value as ProviderName) : provider;
      const updated = resolveSelection(cfg.agent, { provider: shown });
      out(`saved. ${shown}: ${PHASES.map((ph) => `${ph}=${updated.tiers[ph] || "?"}`).join(" ")}   default provider: ${agent.provider ?? "claude"}   effort: ${updated.effort}`);
      return 0;
    }
    case "apply":
    case "discard": {
      const id = pos[0];
      if (!id || !/^rt-[\w-]+$/.test(id)) { process.stderr.write(`usage: narrowbit ${cmd} <task id from an --isolate run>\n`); return 2; }
      const root = findRoot();
      const p = paths(root);
      if (cmd === "discard") { discardIsolated(p, id); out(`discarded the separate copy for ${id}; your folder was never touched`); return 0; }
      const r = applyIsolated(p, id);
      out(r.message);
      if (!r.ok) return 1;
      discardIsolated(p, id);
      return 0;
    }
    case "rewind": {
      const id = pos[0];
      if (!id || !/^rt-[\w-]+$/.test(id)) { process.stderr.write("usage: narrowbit rewind <task id> [checkpoint id]   (with no checkpoint id, lists the task's checkpoints)\n"); return 2; }
      const root = findRoot();
      const p = paths(root);
      const cps = listCheckpoints(p, id);
      if (!cps.length) { out(`${id} has no checkpoints (a checkpoint is recorded before the task starts and after each edit).`); return 0; }
      const which = pos[1];
      if (!which) {
        out(`Checkpoints for ${id}:`);
        for (const c of cps) out(`  ${c.id}  step ${c.step}  ${c.summary}`);
        out(`\nnarrowbit rewind ${id} <id>   restores your folder to that point`);
        return 0;
      }
      const target = cps.find((c) => c.id === which);
      if (!target) { process.stderr.write(`narrowbit: no checkpoint "${which}" for ${id} (see \`narrowbit rewind ${id}\`)\n`); return 2; }
      const isolated = readIsolated(p, id);
      const r = restoreCheckpoint(isolated ? isolated.dir : root, target.commit);
      if (!r.ok) { process.stderr.write(`narrowbit: ${r.message}\n`); return 1; }
      out(r.message);
      return 0;
    }
    case "memory": {
      ensureDirs(p);
      const m = openMemory(p);
      const sub = pos[0];
      if (sub === "add") {
        const type = pos[1] as MemoryType;
        const text = pos.slice(2).join(" ");
        if (!MEMORY_TYPES.includes(type) || !text) {
          process.stderr.write(`usage: narrowbit memory add <${MEMORY_TYPES.join("|")}> "<text>" [--reason ..] [--files a,b]\n`);
          return 2;
        }
        const e = m.add({
          type,
          text,
          reason: args.flags.reason as string | undefined,
          attempt: args.flags.attempt as string | undefined,
          result: args.flags.result as string | undefined,
          files: typeof args.flags.files === "string" ? args.flags.files.split(",").map((s) => s.trim()) : undefined,
          tags: typeof args.flags.tags === "string" ? args.flags.tags.split(",").map((s) => s.trim()) : undefined,
          source: new Tasks(p).current() ?? "cli",
        });
        out(`recorded ${e.id}`);
        return 0;
      }
      if (sub === "resolve" || sub === "supersede") {
        const e = m.setStatus(pos[1], sub === "resolve" ? "resolved" : "superseded", pos[2]);
        out(e ? `${e.id} → ${e.status}` : `no memory entry ${pos[1]}`);
        return e ? 0 : 1;
      }
      const list = m.load(sub && MEMORY_TYPES.includes(sub as MemoryType) ? (sub as MemoryType) : undefined).filter((e) => args.flags.all || e.status === "active");
      out(list.length ? list.map(renderMemory).join("\n") : "no memory entries");
      return 0;
    }
    case "audit": {
      // Deterministic, model-free, sends nothing anywhere. --changed limits it to uncommitted files.
      const g = gitState(root);
      const files = args.flags.changed ? [...new Set([...g.dirty, ...g.staged, ...g.untracked])] : undefined;
      const findings = auditRepo(root, { files });
      out(formatFindings(findings));
      if (!files && sh("gitleaks", ["version"], root).code !== 0) out("\n(Install gitleaks for a full git-history scan: brew install gitleaks)");
      return findings.some((f) => f.severity === "high") ? 1 : 0;
    }
    case "doctor": {
      out(formatReadiness(await checkReadiness(true)));
      return 0;
    }
    case "connectors": {
      const sub = pos[0];
      if (sub === "add") {
        const name = pos[1];
        const [command, ...cargs] = args.rest;
        if (!name || !command) {
          process.stderr.write('usage: narrowbit connectors add "<name>" [--env KEY=VAL,KEY2=VAL2] -- <command> [args...]\n');
          return 2;
        }
        const env: Record<string, string> = {};
        if (typeof args.flags.env === "string") {
          for (const pair of args.flags.env.split(",")) {
            const eq = pair.indexOf("=");
            if (eq > 0) env[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
          }
        }
        try {
          saveConnector(name, command, cargs, env);
          out(`saved connector "${name}" (${command} ${cargs.join(" ")})`);
          return 0;
        } catch (e: any) {
          process.stderr.write(`narrowbit: ${e.message}\n`);
          return 2;
        }
      }
      if (sub === "remove" || sub === "rm") {
        const name = pos[1];
        const ok = name ? removeConnector(name) : false;
        out(ok ? `removed "${name}"` : `no connector named "${name}"`);
        return ok ? 0 : 1;
      }
      if (sub === "test") {
        const name = pos[1];
        const c = name ? getConnector(name) : null;
        if (!c) {
          out(`no connector named "${name}"`);
          return 1;
        }
        try {
          const tools = await listConnectorTools(c, 20_000);
          out(`"${c.name}" is reachable — ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ") || "(none)"}`);
          return 0;
        } catch (e: any) {
          process.stderr.write(`narrowbit: ${e.message}\n`);
          return 1;
        }
      }
      const list = listConnectors();
      out(list.length ? list.map((c) => `${c.name} — ${c.command} ${c.args.join(" ")}`).join("\n") : 'no connectors yet — narrowbit connectors add "<name>" -- <command> [args...]');
      return 0;
    }
    case "skills": {
      ensureDirs(p);
      const sub = pos[0];
      if (sub === "add" || sub === "set") {
        const name = pos[1];
        const body = pos.slice(2).join(" ");
        if (!name || !body) {
          process.stderr.write('usage: narrowbit skills add "<name>" "<instructions>" [--description "..."]\n');
          return 2;
        }
        try {
          saveSkill(p, name, typeof args.flags.description === "string" ? args.flags.description : "", body);
          out(`saved skill "${name}"`);
          return 0;
        } catch (e: any) {
          process.stderr.write(`narrowbit: ${e.message}\n`);
          return 2;
        }
      }
      if (sub === "import") {
        const url = pos[1];
        if (!url) { process.stderr.write("usage: narrowbit skills import <github link to a SKILL.md, a folder or a repo> [--yes]\n"); return 2; }
        try {
          const found = await findSkills(url);
          for (const c of found) {
            out(`\n=== ${c.name}${c.description ? ` — ${c.description}` : ""}   (${c.path})\n${c.body.slice(0, 1500)}${c.body.length > 1500 ? "\n…" : ""}`);
            for (const w of c.warnings) out(`  ⚠ [${w.severity}] line ${w.line}: ${w.check} — ${w.detail}`);
          }
          const risky = found.filter((c) => c.warnings.some((w) => w.severity === "high"));
          if (risky.length && !args.flags.force) {
            out(`\n${risky.length} skill(s) contain wording aimed at the AI (marked ⚠). Not added. Read them; if you still want them, re-run with --yes --force.`);
            return 1;
          }
          if (!args.flags.yes) {
            out(`\nThese are someone else's instructions and will be given to the agent. Read them above, then re-run with --yes to add ${found.length === 1 ? "it" : `all ${found.length}`}.`);
            return 0;
          }
          for (const c of found) saveSkill(p, c.name, c.description, c.body);
          out(`added ${found.length} skill${found.length === 1 ? "" : "s"}`);
          return 0;
        } catch (e: any) {
          process.stderr.write(`narrowbit: ${e.message}\n`);
          return 1;
        }
      }
      if (sub === "rename") {
        const [oldName, newName] = [pos[1], pos[2]];
        if (!oldName || !newName) {
          process.stderr.write('usage: narrowbit skills rename "<old name>" "<new name>"\n');
          return 2;
        }
        try {
          renameSkill(p, oldName, newName);
          out(`renamed "${oldName}" → "${newName}"`);
          return 0;
        } catch (e: any) {
          process.stderr.write(`narrowbit: ${e.message}\n`);
          return 1;
        }
      }
      if (sub === "remove" || sub === "rm") {
        const name = pos[1];
        if (name && getSkill(p, name)?.builtin) {
          out(`"${name}" is built in. To change it, save your own skill with the same name.`);
          return 1;
        }
        const ok = name ? removeSkill(p, name) : false;
        out(ok ? `removed "${name}"` : `no skill named "${name}"`);
        return ok ? 0 : 1;
      }
      if (sub === "show") {
        const s = pos[1] ? getSkill(p, pos[1]) : null;
        if (!s) {
          out(`no skill named "${pos[1] ?? ""}"`);
          return 1;
        }
        out(`${s.name}${s.description ? " — " + s.description : ""}\n\n${s.body}`);
        return 0;
      }
      const list = listSkills(p);
      out(list.length ? list.map((s) => `${s.name}${s.builtin ? " (built in)" : ""}${s.description ? " — " + s.description : ""}`).join("\n") : "no skills yet — narrowbit skills add \"<name>\" \"<instructions>\"");
      return 0;
    }
    case "claude": {
      requireInit(p);
      const text = pos.join(" ");
      if (!text) {
        process.stderr.write("usage: narrowbit claude \"<task>\" [-- <claude args>]\n");
        return 2;
      }
      return launchClaude(p, text, args.rest, { dryRun: !!args.flags["dry-run"], budget: args.flags.budget ? Number(args.flags.budget) : undefined });
    }
    case "install": {
      if (pos[0] !== "claude") {
        process.stderr.write("usage: narrowbit install claude [--no-hook]\n");
        return 2;
      }
      requireProject(p, !!args.flags.force);
      ensureDirs(p);
      for (const c of installClaude(p, { hook: !args.flags["no-hook"] })) out(`updated ${relative(process.cwd(), c) || c}`);
      out("restart Claude Code in this repo to pick up the narrowbit MCP server and hook.");
      return 0;
    }
    case "hook": {
      // Hooks must never break the user's session: swallow all errors.
      try {
        const stdin = await readStdin();
        if (pos[0] === "prompt") {
          const o = await hookPrompt(p, stdin);
          if (o) out(o);
        }
      } catch (e: any) {
        process.stderr.write(`narrowbit hook: ${e?.message ?? e}\n`);
      }
      return 0;
    }
    case "mcp": {
      ensureDirs(p);
      await serveMcp(p);
      return 0;
    }
    case "train": {
      requireInit(p);
      const t = await train(p, { commits: args.flags.commits ? Number(args.flags.commits) : 150, skip: args.flags.skip ? Number(args.flags.skip) : 0 });
      const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
      out(`\nTRAINED on ${t.examples} examples from ${t.commits} commits (held-out 30%)`);
      out(`  before: hit@1 ${pct(t.before.hitAt1)}  recall@5 ${pct(t.before.recallAt5)}  MRR ${t.before.mrr.toFixed(3)}`);
      out(`  after:  hit@1 ${pct(t.after.hitAt1)}  recall@5 ${pct(t.after.recallAt5)}  MRR ${t.after.mrr.toFixed(3)}`);
      out(`  weights: ${Object.entries(t.weights).map(([k, v]) => `${k} ${v}`).join(", ")}`);
      out(t.after.mrr >= t.before.mrr ? `  saved to .narrowbit/weights.json (applied automatically)` : `  NOT applied: held-out ordering got worse`);
      return 0;
    }
    case "eval": {
      requireInit(p);
      const noWeights = !!args.flags["no-weights"];
      const rerankOpt = args.flags.rerank
        ? { weight: args.flags["rerank-weight"] ? Number(args.flags["rerank-weight"]) : undefined, topN: args.flags["rerank-top"] ? Number(args.flags["rerank-top"]) : undefined }
        : undefined;
      const r = await evalHistory(p, { noWeights, rerank: rerankOpt as any, commits: args.flags.commits ? Number(args.flags.commits) : 40, budget: args.flags.budget ? Number(args.flags.budget) : undefined, ref: args.flags.ref as string | undefined });
      const s = r.summary;
      const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
      out(`\nSELECTION EVAL over ${s.cases} commits (commit message as task; lower bound)`);
      out(`  recall@5 ${pct(s.recallAt5)}   recall@10 ${pct(s.recallAt10)}   hit@1 ${pct(s.hitAt1)}   MRR ${s.mrr.toFixed(3)}`);
      out(`  gold files loaded as code: ${pct(s.recallLoaded)}   in package (incl. outline): ${pct(s.recallInPackage)}`);
      out(`  mean package ~${fmtNum(Math.round(s.meanPackageTokens))} tokens est.`);
      out(`  by confidence: ${Object.entries(s.byConfidence).map(([k, v]: any) => `${k} n=${v.n}${v.recallInPackage !== null ? ` in-pkg ${pct(v.recallInPackage)}` : ""}`).join("; ")}`);
      const rr: any = (s as any).rerank;
      if (rr) {
        out(`\n  RE-RANKED by ${rr.model} (weight ${rr.weight}): recall@5 ${pct(rr.recallAt5)} (${rr.recallAt5 >= s.recallAt5 ? "+" : ""}${((rr.recallAt5 - s.recallAt5) * 100).toFixed(1)}pp)   recall@10 ${pct(rr.recallAt10)} (${((rr.recallAt10 - s.recallAt10) * 100).toFixed(1)}pp)   hit@1 ${pct(rr.hitAt1)} (${((rr.hitAt1 - s.hitAt1) * 100).toFixed(1)}pp)   MRR ${rr.mrr.toFixed(3)}`);
        out(`  cost: ${rr.calls} calls, ${rr.errors} error(s), ~${fmtNum(rr.inputTokens)} input tokens, ${rr.estCostUsd ? `~$${rr.estCostUsd.toFixed(4)}` : "cost n/a"} (${rr.provider ?? "provider"} credit, not Claude quota)`);
        if (rr.firstError) out(`  first error: ${rr.firstError}`);
      }
      out(`  details: ${relative(process.cwd(), r.file)}`);
      return 0;
    }
    case "benchmark": {
      ensureDirs(p);
      const sub = pos[0];
      if (sub === "init") {
        const f = resolve(pos[1] ?? "benchmark.json");
        if (existsSync(f)) {
          process.stderr.write(`${f} exists\n`);
          return 1;
        }
        writeFileSync(f, benchmarkTemplate());
        out(`wrote ${relative(process.cwd(), f)} — add 30–50 real tasks with verify commands, then: narrowbit benchmark run ${relative(process.cwd(), f)}`);
        return 0;
      }
      if (sub === "run") {
        if (!pos[1]) {
          process.stderr.write("usage: narrowbit benchmark run <tasks.json>\n");
          return 2;
        }
        const rows = await runBenchmark(p, resolve(pos[1]), {
          only: typeof args.flags.only === "string" ? args.flags.only.split(",") : undefined,
          arms: typeof args.flags.arms === "string" ? args.flags.arms.split(",") : undefined,
          dryRun: !!args.flags["dry-run"],
        });
        if (rows.length) out("\n" + benchmarkReport(p, { runId: rows[0].runId }));
        return 0;
      }
      if (sub === "report") {
        out(benchmarkReport(p, { runId: args.flags.run as string | undefined, baseline: args.flags.baseline as string | undefined, treatment: args.flags.treatment as string | undefined }));
        return 0;
      }
      process.stderr.write("usage: narrowbit benchmark init|run|report\n");
      return 2;
    }
    case "stats": {
      const ts = new Tasks(p).list().filter((t) => t.source !== "eval");
      if (!ts.length) {
        out("no tasks recorded");
        return 0;
      }
      const closed = ts.filter((t) => t.closed && t.closed.recall !== null);
      const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
      const runs = ts.flatMap((t) => t.runs);
      out(`tasks: ${ts.length} (${ts.filter((t) => t.closed).length} closed)`);
      out(`mean package: ~${fmtNum(Math.round(avg(ts.map((t) => t.packageTokens))))} tokens est.; confidence high/med/low: ${["high", "medium", "low"].map((c) => ts.filter((t) => t.confidence === c).length).join("/")}`);
      out(`agent expansion requests per task: ${avg(ts.map((t) => t.events.length)).toFixed(1)}`);
      if (closed.length) out(`selection recall on closed tasks: ${(avg(closed.map((t) => t.closed!.recall!)) * 100).toFixed(1)}% (n=${closed.length})`);
      const outcomes = ts.filter((t) => t.closed).reduce<Record<string, number>>((a, t) => ((a[t.closed!.outcome] = (a[t.closed!.outcome] ?? 0) + 1), a), {});
      if (Object.keys(outcomes).length) out(`outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(", ")}`);
      if (runs.length) {
        const raw = runs.reduce((a, r) => a + r.rawTokens, 0);
        const comp = runs.reduce((a, r) => a + r.compressedTokens, 0);
        out(`command output: ${runs.length} runs, ~${fmtNum(raw)} → ~${fmtNum(comp)} tokens est. (${raw ? ((1 - comp / raw) * 100).toFixed(0) : 0}% smaller)`);
      }
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}
