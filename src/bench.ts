import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureDirs, loadConfig, paths, saveConfig, detectVerify, type Paths } from "./config.js";
import { runCommand } from "./compress.js";
import { changedSince } from "./git.js";
import { indexRepo, openStore } from "./indexer.js";
import { buildPackage } from "./package.js";
import { Tasks } from "./tasks.js";
import { mcpServerConfig } from "./claude.js";
import { fold, readEvents } from "./events.js";
import { runTask } from "./runtime.js";
import { sh, shortId, now } from "./util.js";

export interface BenchTask {
  id: string;
  prompt: string;
  /** Git ref both arms start from. Defaults to HEAD at run start. */
  commit?: string;
  /** Success check, run in the worktree after the agent finishes. Exit 0 = success. */
  verify?: string;
  category?: string;
  /** Files a correct solution is expected to touch (optional; enables selection recall). */
  expectedFiles?: string[];
  /** Start state: check these paths out of another commit first (e.g. the fix's tests, which must fail). */
  apply?: { from: string; paths: string[] };
}

export interface BenchArm {
  name: string;
  narrowbit?: boolean;
  /** Narrowbit's MCP tools attached, but NO predictive package injected into the system prompt —
   * tests whether on-demand tools alone (nb_symbol/nb_grep/nb_search/...) help, Serena-style,
   * without the fixed injection cost that lost the two `narrowbit: true` benchmark runs. */
  mcpOnly?: boolean;
  /** Narrowbit's OWN agent loop (runtime.ts) drives the task end to end — no injected package,
   * no MCP round-trip, no external `claude` subprocess for tool use. Only each model turn goes
   * through the subscription CLI adapter (providers/claude-cli.ts), tool-free. Mutually exclusive
   * with narrowbit/mcpOnly; `args`/`appendSystemPrompt` are ignored for this arm. */
  runtime?: boolean;
  /** runtime arm only: cap on loop steps (default 20). */
  runtimeMaxSteps?: number;
  /** Extra args for `claude` in this arm. */
  args?: string[];
  /** Extra system prompt text (e.g. a "context hygiene" baseline arm). */
  appendSystemPrompt?: string;
}

export interface BenchFile {
  tasks: BenchTask[];
  model?: string;
  arms?: BenchArm[];
  repeats?: number;
  /** Shared claude args, e.g. ["--permission-mode", "acceptEdits", "--allowedTools", "Bash(npm test:*)"] */
  claudeArgs?: string[];
  /** Command run in each fresh worktree before the agent starts (e.g. "npm ci"). Default: symlink node_modules. */
  setup?: string;
  timeoutMinutes?: number;
  /** Claude Code executable; defaults to $NARROWBIT_CLAUDE or `claude` on PATH. */
  claudeBin?: string;
  maxBudgetUsd?: number;
}

export interface RunMetrics {
  runId: string;
  at: string;
  task: string;
  category?: string;
  arm: string;
  model?: string;
  repeat: number;
  commit: string;
  success: boolean | null;
  verifyExit: number | null;
  agentExit: number;
  isError: boolean;
  durationMs: number;
  turns: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** input + cache creation + cache read: everything the model had to process. */
  totalInputTokens: number;
  costUsd: number | null;
  toolCalls: Record<string, number>;
  totalToolCalls: number;
  filesRead: number;
  searches: number;
  narrowbitCalls: number;
  packageTokens: number | null;
  filesChanged: string[];
  expectedRecall: number | null;
  selectionRecall: number | null;
}

const DEFAULT_ARMS: BenchArm[] = [{ name: "native" }, { name: "narrowbit", narrowbit: true }];

export { parseStream } from "./streamjson.js";
import { parseStream } from "./streamjson.js";

function runClaude(bin: string, cwd: string, args: string[], outFile: string, env: Record<string, string>, timeoutMs: number): Promise<number> {
  return new Promise((res) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => appendFileSync(outFile + ".stderr", d));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(outFile, Buffer.concat(chunks));
      res(code ?? 1);
    });
    child.on("error", () => res(127));
  });
}

export async function runBenchmark(p: Paths, file: string, opts: { only?: string[]; arms?: string[]; dryRun?: boolean; log?: (s: string) => void } = {}): Promise<RunMetrics[]> {
  const log = opts.log ?? ((s: string) => process.stderr.write(s + "\n"));
  const spec: BenchFile = JSON.parse(readFileSync(file, "utf8"));
  const arms = (spec.arms ?? DEFAULT_ARMS).filter((a) => !opts.arms || opts.arms.includes(a.name));
  const tasks = spec.tasks.filter((t) => !opts.only || opts.only.includes(t.id));
  const repeats = spec.repeats ?? 1;
  const runId = shortId();
  const runDir = join(p.benchmarks, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const resultsFile = join(p.benchmarks, "results.jsonl");
  const head = sh("git", ["rev-parse", "HEAD"], p.root).stdout.trim();
  const out: RunMetrics[] = [];
  const baseArgs = spec.claudeArgs ?? ["--permission-mode", "acceptEdits"];
  const claudeBin = spec.claudeBin ?? process.env.NARROWBIT_CLAUDE ?? "claude";

  for (const t of tasks) {
    const commit = sh("git", ["rev-parse", t.commit ?? head], p.root).stdout.trim();
    for (let r = 0; r < repeats; r++) {
      // Alternate arm order per repeat/task to spread any time-of-day / cache effects.
      const ordered = (tasks.indexOf(t) + r) % 2 ? [...arms].reverse() : arms;
      for (const arm of ordered) {
        const wt = join(tmpdir(), `narrowbit-bench-${runId}-${t.id}-${arm.name}-${r}`.replace(/[^\w.-]/g, "_"));
        const tag = `${t.id} [${arm.name}${repeats > 1 ? ` #${r + 1}` : ""}]`;
        const args = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", ...baseArgs, ...(arm.args ?? [])];
        if (spec.model) args.push("--model", spec.model);
        if (spec.maxBudgetUsd) args.push("--max-budget-usd", String(spec.maxBudgetUsd));
        if (opts.dryRun) {
          log(`${tag}: would run in worktree at ${commit.slice(0, 8)}: claude ${args.join(" ")} <prompt>`);
          continue;
        }
        log(`${tag}: preparing worktree @ ${commit.slice(0, 8)}`);
        const add = sh("git", ["worktree", "add", "--detach", "--force", wt, commit], p.root);
        if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
        try {
          if (spec.setup) {
            const s = await runCommand(p, spec.setup, { cwd: wt });
            if (s.exit !== 0) log(`${tag}: setup failed (exit ${s.exit}); continuing`);
          } else if (existsSync(join(p.root, "node_modules")) && !existsSync(join(wt, "node_modules"))) {
            symlinkSync(join(p.root, "node_modules"), join(wt, "node_modules"));
          }
          if (t.apply?.paths.length) {
            const ap = sh("git", ["checkout", t.apply.from, "--", ...t.apply.paths], wt);
            if (ap.code !== 0) throw new Error(`${tag}: could not apply ${t.apply.paths.join(", ")} from ${t.apply.from}: ${ap.stderr.trim()}`);
          }
          const env: Record<string, string> = {};
          let packageTokens: number | null = null;
          let selectedPaths: string[] = [];
          const wp = paths(wt);
          if (arm.narrowbit) {
            ensureDirs(wp);
            const cfg = { ...loadConfig(p) };
            cfg.verify = detectVerify(wt);
            saveConfig(wp, cfg);
            // Memory is project knowledge that exists before the task; carry it over.
            if (existsSync(p.memory)) sh("cp", ["-R", p.memory + "/.", wp.memory], p.root);
            const store = openStore(wp);
            indexRepo(wp, store);
            const b = buildPackage(store, wp, cfg, t.prompt, { source: "benchmark" });
            store.close();
            const tasksStore = new Tasks(wp);
            tasksStore.save(b.record);
            tasksStore.setCurrent(b.record.id);
            packageTokens = b.record.packageTokens;
            selectedPaths = b.record.selected.filter((s) => s.level !== "listed").map((s) => s.path);
            const mcpFile = join(runDir, `${t.id}-${arm.name}-${r}.mcp.json`);
            writeFileSync(mcpFile, JSON.stringify({ mcpServers: { narrowbit: mcpServerConfig(wp, b.record.id) } }));
            args.push("--append-system-prompt", (arm.appendSystemPrompt ? arm.appendSystemPrompt + "\n\n" : "") + b.text, "--mcp-config", mcpFile, "--strict-mcp-config");
            if (!baseArgs.includes("--allowedTools") && !baseArgs.includes("--allowed-tools")) args.push("--allowedTools", "mcp__narrowbit");
            env.NARROWBIT_TASK = b.record.id;
          } else if (arm.mcpOnly) {
            // Index so the tools work when called, but inject nothing — no package, no protocol
            // text, no pre-created task. The agent must discover and choose to use nb_* itself,
            // from the tool descriptions alone, exactly like it would decide to use any other tool.
            ensureDirs(wp);
            const cfg = { ...loadConfig(p) };
            cfg.verify = detectVerify(wt);
            saveConfig(wp, cfg);
            if (existsSync(p.memory)) sh("cp", ["-R", p.memory + "/.", wp.memory], p.root);
            const store = openStore(wp);
            indexRepo(wp, store);
            store.close();
            const mcpFile = join(runDir, `${t.id}-${arm.name}-${r}.mcp.json`);
            writeFileSync(mcpFile, JSON.stringify({ mcpServers: { narrowbit: mcpServerConfig(wp) } }));
            args.push("--mcp-config", mcpFile, "--strict-mcp-config");
            if (!baseArgs.includes("--allowedTools") && !baseArgs.includes("--allowed-tools")) args.push("--allowedTools", "mcp__narrowbit");
            if (arm.appendSystemPrompt) args.push("--append-system-prompt", arm.appendSystemPrompt);
          } else if (arm.runtime) {
            // Index so read/grep/search work; `args` built above is irrelevant here, since this
            // arm never spawns an external `claude` subprocess for tool use — see the branch below.
            ensureDirs(wp);
            const cfg = { ...loadConfig(p) };
            cfg.verify = detectVerify(wt);
            saveConfig(wp, cfg);
            if (existsSync(p.memory)) sh("cp", ["-R", p.memory + "/.", wp.memory], p.root);
            const store = openStore(wp);
            indexRepo(wp, store);
            store.close();
          } else {
            args.push("--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }));
            if (arm.appendSystemPrompt) args.push("--append-system-prompt", arm.appendSystemPrompt);
          }
          const t0 = Date.now();
          let agentExit: number;
          let s: ReturnType<typeof parseStream>;
          if (arm.runtime) {
            log(`${tag}: running narrowbit's own loop…`);
            const result = await runTask(wp, t.prompt, { model: spec.model, maxSteps: arm.runtimeMaxSteps ?? 20, claudeBin });
            const ledger = fold(result.taskId, readEvents(wp, result.taskId)).ledgerByRole;
            const roles = Object.values(ledger);
            const sum = (k: "inputTokens" | "cacheCreationTokens" | "cacheReadTokens" | "outputTokens") => roles.reduce((a, x) => a + x[k], 0);
            const costUsd = roles.reduce((a, x) => a + x.costUsd, 0);
            const toolCalls = Object.fromEntries(Object.entries(result.actionCounts).map(([action, n]) => [`nb_${action}`, n]));
            agentExit = result.outcome === "error" ? 1 : 0;
            // Every action here is Narrowbit's own, driven in-process — there is no separate subprocess
            // transcript to parse, so this mirrors parseStream()'s shape directly instead of producing one.
            s = {
              toolCalls,
              filesRead: result.actionCounts.read ?? 0,
              turns: result.steps,
              durationMs: Date.now() - t0,
              costUsd: costUsd || null,
              isError: result.outcome === "error",
              usage: { input: sum("inputTokens"), cacheCreate: sum("cacheCreationTokens"), cacheRead: sum("cacheReadTokens"), output: sum("outputTokens") },
            };
            if (result.outcome === "error") log(`${tag}: runtime loop error — ${result.summary}`);
          } else {
            const outFile = join(runDir, `${t.id}-${arm.name}-${r}.jsonl`);
            log(`${tag}: running claude…`);
            agentExit = await runClaude(claudeBin, wt, [...args, "--", t.prompt], outFile, env, (spec.timeoutMinutes ?? 30) * 60_000);
            const rawStream = readFileSync(outFile, "utf8");
            s = parseStream(rawStream);
            const stderr = existsSync(outFile + ".stderr") ? readFileSync(outFile + ".stderr", "utf8") : "";
            // Harness/environment failures are not task failures: stop instead of recording a bogus result.
            const fatal =
              /"error":"authentication_failed"|Not logged in|Invalid API key/.test(rawStream + stderr) ? "claude CLI is not logged in (run `claude` then /login, or set ANTHROPIC_API_KEY)"
              : s.turns === 0 && !s.usage.input && stderr.trim() ? `claude failed to start: ${stderr.trim().split("\n")[0].slice(0, 200)}`
              : null;
            if (fatal) throw new Error(`${tag}: ${fatal} — aborting benchmark; nothing recorded for this run`);
          }
          const applied = new Set(t.apply?.paths ?? []);
          const filesChanged = changedSince(wt, commit).filter((f) => !f.startsWith(".narrowbit/") && f !== "node_modules" && !applied.has(f));
          writeFileSync(join(runDir, `${t.id}-${arm.name}-${r}.diff`), sh("git", ["diff", commit], wt).stdout);
          let verifyExit: number | null = null;
          if (t.verify) {
            const v = await runCommand(p, t.verify, { cwd: wt, timeoutMs: 15 * 60_000 });
            verifyExit = v.exit;
            writeFileSync(join(runDir, `${t.id}-${arm.name}-${r}.verify.txt`), v.rendered);
          }
          const expected = t.expectedFiles ?? [];
          const m: RunMetrics = {
            runId,
            at: now(),
            task: t.id,
            category: t.category,
            arm: arm.name,
            model: spec.model,
            repeat: r,
            commit,
            success: verifyExit === null ? null : verifyExit === 0 && !s.isError,
            verifyExit,
            agentExit,
            isError: s.isError,
            durationMs: s.durationMs || Date.now() - t0,
            turns: s.turns,
            inputTokens: s.usage.input,
            cacheCreationTokens: s.usage.cacheCreate,
            cacheReadTokens: s.usage.cacheRead,
            outputTokens: s.usage.output,
            totalInputTokens: s.usage.input + s.usage.cacheCreate + s.usage.cacheRead,
            costUsd: s.costUsd,
            toolCalls: s.toolCalls,
            totalToolCalls: Object.values(s.toolCalls).reduce((a, b) => a + b, 0),
            filesRead: s.filesRead,
            searches: arm.runtime ? (s.toolCalls.nb_grep ?? 0) + (s.toolCalls.nb_search ?? 0) : (s.toolCalls.Grep ?? 0) + (s.toolCalls.Glob ?? 0) + (s.toolCalls.LS ?? 0),
            // Every action in the runtime arm is Narrowbit's own by construction (no Claude Code tool loop involved).
            narrowbitCalls: arm.runtime ? Object.values(s.toolCalls).reduce((a, b) => a + b, 0) : Object.entries(s.toolCalls).filter(([k]) => k.startsWith("mcp__narrowbit")).reduce((a, [, v]) => a + v, 0),
            packageTokens,
            filesChanged,
            expectedRecall: expected.length ? expected.filter((f) => filesChanged.includes(f)).length / expected.length : null,
            selectionRecall: arm.narrowbit && filesChanged.length ? filesChanged.filter((f) => selectedPaths.includes(f)).length / filesChanged.length : null,
          };
          appendFileSync(resultsFile, JSON.stringify(m) + "\n");
          out.push(m);
          log(
            `${tag}: ${m.success === null ? "no verify" : m.success ? "SUCCESS" : "FAIL"} — ${m.totalInputTokens.toLocaleString()} input tok (${m.cacheReadTokens.toLocaleString()} cached), ${m.turns} turns, ${m.totalToolCalls} tools, ${m.costUsd !== null ? "$" + m.costUsd.toFixed(3) : ""}`,
          );
        } finally {
          sh("git", ["worktree", "remove", "--force", wt], p.root);
          if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
        }
      }
    }
  }
  return out;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function benchmarkReport(p: Paths, opts: { runId?: string; baseline?: string; treatment?: string } = {}): string {
  const file = join(p.benchmarks, "results.jsonl");
  if (!existsSync(file)) return "no benchmark results yet (narrowbit benchmark run <tasks.json>)";
  let rows: RunMetrics[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (opts.runId) rows = rows.filter((r) => r.runId === opts.runId);
  const arms = [...new Set(rows.map((r) => r.arm))];
  const lines: string[] = [];
  lines.push(`runs: ${rows.length}  tasks: ${new Set(rows.map((r) => r.task)).size}  arms: ${arms.join(", ")}`);
  lines.push("");
  lines.push(
    "arm".padEnd(14) +
      ["n", "success", "mean in-tok", "median in-tok", "fresh in-tok", "out-tok", "turns", "tools", "reads", "searches", "cost $", "succ/M tok"].map((h) => h.padStart(13)).join(""),
  );
  for (const a of arms) {
    const rs = rows.filter((r) => r.arm === a);
    const judged = rs.filter((r) => r.success !== null);
    const succ = judged.filter((r) => r.success).length;
    const totalIn = rs.reduce((x, r) => x + r.totalInputTokens, 0);
    const cost = rs.filter((r) => r.costUsd !== null).reduce((x, r) => x + (r.costUsd ?? 0), 0);
    lines.push(
      a.padEnd(14) +
        [
          rs.length,
          judged.length ? `${succ}/${judged.length}` : "n/a",
          Math.round(mean(rs.map((r) => r.totalInputTokens))).toLocaleString(),
          Math.round(median(rs.map((r) => r.totalInputTokens))).toLocaleString(),
          Math.round(mean(rs.map((r) => r.inputTokens + r.cacheCreationTokens))).toLocaleString(),
          Math.round(mean(rs.map((r) => r.outputTokens))).toLocaleString(),
          mean(rs.map((r) => r.turns)).toFixed(1),
          mean(rs.map((r) => r.totalToolCalls)).toFixed(1),
          mean(rs.map((r) => r.filesRead)).toFixed(1),
          mean(rs.map((r) => r.searches)).toFixed(1),
          cost ? cost.toFixed(2) : "n/a",
          totalIn ? ((succ / totalIn) * 1e6).toFixed(2) : "n/a",
        ]
          .map((v) => String(v).padStart(13))
          .join(""),
    );
  }

  // Paired comparison: same task (and repeat), baseline vs treatment.
  const base = opts.baseline ?? (arms.includes("native") ? "native" : arms[0]);
  const treat = opts.treatment ?? (arms.includes("narrowbit") ? "narrowbit" : arms[1]);
  if (base && treat && base !== treat) {
    const key = (r: RunMetrics) => `${r.runId}|${r.task}|${r.repeat}`;
    const bmap = new Map(rows.filter((r) => r.arm === base).map((r) => [key(r), r]));
    const pairs = rows.filter((r) => r.arm === treat && bmap.has(key(r))).map((t) => ({ b: bmap.get(key(t))!, t }));
    if (pairs.length) {
      const reductions = pairs.map(({ b, t }) => 1 - t.totalInputTokens / Math.max(b.totalInputTokens, 1));
      const freshRed = pairs.map(({ b, t }) => 1 - (t.inputTokens + t.cacheCreationTokens) / Math.max(b.inputTokens + b.cacheCreationTokens, 1));
      const bothJudged = pairs.filter((x) => x.b.success !== null && x.t.success !== null);
      const bSucc = bothJudged.filter((x) => x.b.success).length;
      const tSucc = bothJudged.filter((x) => x.t.success).length;
      const wins = bothJudged.filter((x) => x.t.success && !x.b.success).length;
      const losses = bothJudged.filter((x) => !x.t.success && x.b.success).length;
      const aggRed = 1 - pairs.reduce((a, x) => a + x.t.totalInputTokens, 0) / Math.max(pairs.reduce((a, x) => a + x.b.totalInputTokens, 0), 1);
      lines.push("");
      lines.push(`PAIRED: ${treat} vs ${base} over ${pairs.length} pair(s)`);
      lines.push(`  total input-token reduction (aggregate): ${(aggRed * 100).toFixed(1)}%`);
      lines.push(`  per-task reduction: median ${(median(reductions) * 100).toFixed(1)}%, mean ${(mean(reductions) * 100).toFixed(1)}%`);
      lines.push(`  fresh (uncached) input reduction: median ${(median(freshRed) * 100).toFixed(1)}%`);
      lines.push(`  success: ${base} ${bSucc}/${bothJudged.length}, ${treat} ${tSucc}/${bothJudged.length}  (treatment-only wins ${wins}, losses ${losses})`);
      const tasksN = new Set(pairs.map((x) => x.t.task)).size;
      const qualityOk = tSucc >= bSucc;
      let verdict: string;
      if (tasksN < 30) verdict = `INSUFFICIENT SAMPLE — ${tasksN} task(s); brief requires 30–50 before a go/no-go call`;
      else if (!qualityOk && bSucc - tSucc > Math.max(1, bothJudged.length * 0.05)) verdict = "NO-GO — quality materially worse";
      else if (aggRed < 0.2) verdict = "NO-GO — reduction under 20%";
      else if (aggRed < 0.4) verdict = "CONTINUE — 20–40% with equal quality";
      else if (aggRed < 0.6) verdict = qualityOk ? "GO — ≥40% with equal or better success" : "CONTINUE — ≥40% but slight quality loss";
      else verdict = qualityOk ? "STRONG GO — ≥60% with equal or better success" : "GO? — ≥60% but slight quality loss";
      lines.push(`  verdict: ${verdict}`);
    }
  }
  return lines.join("\n");
}

export function benchmarkTemplate(): string {
  const t: BenchFile = {
    model: "sonnet",
    repeats: 1,
    timeoutMinutes: 30,
    claudeArgs: ["--permission-mode", "acceptEdits", "--allowedTools", "Bash(npm test:*) Bash(npx vitest:*) Bash(npx tsc:*) mcp__narrowbit"],
    arms: DEFAULT_ARMS,
    tasks: [
      {
        id: "example-bugfix-001",
        category: "bugfix",
        prompt: "Fix: webhook signature verification fails after payment callback. Tests in tests/payments should pass.",
        commit: "HEAD",
        verify: "npx vitest run tests/payments",
        expectedFiles: ["src/payments/verify.ts"],
      },
    ],
  };
  return JSON.stringify(t, null, 2) + "\n";
}

