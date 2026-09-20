import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { benchmarkReport, benchmarkTemplate, runBenchmark } from "./bench.js";
import { hookPrompt, installClaude, launchClaude } from "./claude.js";
import { runCommand } from "./compress.js";
import { DEFAULT_IGNORE, detectVerify, ensureDirs, findRoot, loadConfig, paths, saveConfig, type Paths } from "./config.js";
import { evalHistory } from "./eval.js";
import { changedSince } from "./git.js";
import { indexRepo, openStore } from "./indexer.js";
import { serveMcp } from "./mcp.js";
import { Memory, openMemory, MEMORY_TYPES, renderMemory, type MemoryType } from "./memory.js";
import { buildPackage } from "./package.js";
import { expandTask, grepText, outlineText, refsText, searchText, symbolText, testsText } from "./query.js";
import { Tasks, type TaskRecord } from "./tasks.js";
import { fmtNum, now } from "./util.js";
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

const VALUE_FLAGS = new Set(["budget", "root", "reason", "attempt", "result", "files", "note", "commits", "only", "arms", "run", "error-file", "limit", "tags", "baseline", "treatment", "ref", "rerank-weight", "rerank-top"]);

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

  narrowbit memory add <type> "<text>" [--reason ..] [--attempt ..] [--result ..] [--files a,b]
      types: ${MEMORY_TYPES.join(", ")}
  narrowbit memory list [type]        narrowbit memory resolve <id>   narrowbit memory supersede <id>

  narrowbit claude "<task>" [--dry-run] [-- <claude args>]   launch Claude Code with Narrowbit context + MCP tools
  narrowbit install claude [--no-hook]                        register MCP server + UserPromptSubmit hook in this repo
  narrowbit mcp                       MCP stdio server (used by agents)

  narrowbit eval [--commits 40] [--rerank]   offline selection benchmark over git history (--rerank A/Bs a hosted decision model)
  narrowbit benchmark init            write a benchmark task template (benchmark.json)
  narrowbit benchmark run <file> [--only id,..] [--arms native,narrowbit] [--dry-run]
  narrowbit benchmark report [--run id]
  narrowbit stats                     aggregate metrics from recorded tasks
`;

function out(s: string) {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
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
      ensureDirs(p);
      if (!existsSync(p.config)) {
        const cfg = loadConfig(p);
        cfg.verify = detectVerify(root);
        saveConfig(p, cfg);
      }
      if (!existsSync(p.ignore)) writeFileSync(p.ignore, DEFAULT_IGNORE);
      out(`initialised ${relative(process.cwd(), p.nb) || p.nb}`);
      const cfg = loadConfig(p);
      const v = Object.entries(cfg.verify);
      out(v.length ? `verify commands: ${v.map(([k, c]) => `${k}=\`${c}\``).join(", ")}` : "verify commands: none detected (edit .narrowbit/config.json)");
      if (!args.flags["no-index"]) {
        const store = openStore(p);
        printIndexStats(indexRepo(p, store));
        store.close();
      }
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
    case "eval": {
      requireInit(p);
      const rerankOpt = args.flags.rerank
        ? { weight: args.flags["rerank-weight"] ? Number(args.flags["rerank-weight"]) : undefined, topN: args.flags["rerank-top"] ? Number(args.flags["rerank-top"]) : undefined }
        : undefined;
      const r = await evalHistory(p, { rerank: rerankOpt as any, commits: args.flags.commits ? Number(args.flags.commits) : 40, budget: args.flags.budget ? Number(args.flags.budget) : undefined, ref: args.flags.ref as string | undefined });
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
