#!/usr/bin/env node
/**
 * Build a Narrowbit benchmark task set from a repository's git history.
 *
 * Each candidate commit that changed source *and* its tests becomes a task:
 *   start state  = parent commit + the commit's test files applied
 *   success      = those tests pass
 * With --verify-each the script proves each task is winnable: the tests must FAIL
 * at the start state and PASS once the commit's source changes are applied.
 *
 * No model calls — this is all local git and test runs.
 *
 *   node scripts/build-tasks.mjs --repo ../hono --out bench-hono.json --max 40 --verify-each
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1]?.startsWith("--") ? true : args[i + 1]) : def;
};
const has = (name) => args.includes(`--${name}`);

const repo = resolve(String(flag("repo", ".")));
const out = resolve(String(flag("out", "benchmark.json")));
const scan = Number(flag("commits", 400));
const max = Number(flag("max", 40));
const maxFiles = Number(flag("max-files", 5));
const verifyEach = has("verify-each");
const model = String(flag("model", "sonnet"));
const keep = has("keep-worktree");
const withBody = has("with-body");

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const isTest = (p) => /(?:\.|-)(?:test|spec)\.[cm]?[jt]sx?$/.test(p) || /(?:^|\/)(?:__tests__|tests?)\//.test(p);
const isSource = (p) => /\.[cm]?[jt]sx?$/.test(p) && !isTest(p) && !/\.d\.ts$/.test(p) && !/(?:^|\/)(?:dist|build|examples?|benchmarks?|docs?)\//.test(p);

/** Commit subject → a prompt a developer would plausibly type. */
function toPrompt(subject, body, testPaths) {
  // Commit bodies usually explain the fix; including them hands the agent the answer.
  if (!withBody) body = "";
  const clean = subject
    .replace(/\s*\(#\d+\)\s*$/, "")
    .replace(/^(\w+)\(([^)]+)\):\s*/, (_, kind, scope) => `In ${scope}: `)
    .replace(/^(\w+):\s*/, "");
  const detail = body
    .split("\n")
    .filter((l) => l.trim() && !/^(?:Co-authored-by|Signed-off-by|Closes|Fixes|Refs)\b/i.test(l) && !/^https?:/.test(l.trim()))
    .slice(0, 4)
    .join(" ")
    .slice(0, 400);
  return [
    clean[0].toUpperCase() + clean.slice(1),
    detail ? `\n\n${detail}` : "",
    `\n\nThe tests in ${testPaths.join(", ")} currently fail. Make them pass. Do not modify the test files.`,
  ].join("");
}

function detectTestCmd(root) {
  const pkgPath = join(root, "package.json");
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : {};
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (deps.vitest) return "npx vitest run {files}";
  if (deps.jest || deps["ts-jest"]) return "npx jest {files}";
  if (deps.mocha) return "npx mocha {files}";
  return "npm test";
}
const testCmd = String(flag("test-cmd", detectTestCmd(repo)));
const setup = flag("setup", null);

console.error(`repo: ${repo}\ntest command: ${testCmd}\nscanning ${scan} commits…`);

// ---- 1. Candidate commits: changed source + tests, small, with a descriptive message.
const raw = git(repo, "log", "HEAD", `-n${scan}`, "--no-merges", "--format=%x1e%H%x1f%P%x1f%s%x1f%b", "--name-status");
const candidates = [];
for (const block of raw.split("\x1e")) {
  if (!block.trim()) continue;
  const [meta, ...rest] = block.split("\n");
  const [hash, parents, subject, bodyHead] = meta.split("\x1f");
  const parent = parents.split(" ")[0];
  if (!parent || !subject) continue;
  if (subject.length < 15 || /^(?:wip|merge|release|bump|v?\d+\.\d+|chore|docs|style|test|ci|build)\b/i.test(subject)) continue;
  const source = [];
  const tests = [];
  const body = [bodyHead ?? ""];
  let other = 0;
  for (const l of rest) {
    const m = /^([AMR])\d*\t(.+?)(?:\t(.+))?$/.exec(l);
    if (!m) {
      if (!source.length && !tests.length) body.push(l);
      continue;
    }
    const path = m[3] ?? m[2];
    if (isTest(path)) tests.push(path);
    else if (isSource(path)) source.push(path);
    else other++; // docs/config alongside the change: fine, but not part of the task
  }
  if (!source.length || !tests.length || source.length + tests.length > maxFiles || other > 2) continue;
  candidates.push({ hash, parent, subject, body: body.join("\n").trim(), source, tests });
}
console.error(`${candidates.length} candidate commit(s) changed source + tests`);

// ---- 2. Optionally prove each task is winnable (tests fail at start, pass with the real fix).
const wt = join(repo, "..", `.bench-build-${basename(repo)}`);
const tasks = [];
const run = (cmd, cwd) => spawnSync(cmd, { cwd, shell: true, encoding: "utf8", env: { ...process.env, CI: "1", NO_COLOR: "1" }, timeout: 15 * 60_000 });

if (verifyEach) {
  if (existsSync(wt)) git(repo, "worktree", "remove", "--force", wt);
  git(repo, "worktree", "add", "--detach", "--force", wt, "HEAD");
  if (setup) {
    console.error(`setup: ${setup}`);
    const s = run(String(setup), wt);
    if (s.status !== 0) console.error(`setup failed (exit ${s.status}); continuing: ${(s.stderr || "").slice(0, 300)}`);
  } else if (existsSync(join(repo, "node_modules")) && !existsSync(join(wt, "node_modules"))) {
    symlinkSync(join(repo, "node_modules"), join(wt, "node_modules"));
  }
}

for (const c of candidates) {
  if (tasks.length >= max) break;
  const files = c.tests.map((t) => JSON.stringify(t)).join(" ");
  const verify = testCmd.replace("{files}", files);
  const task = {
    id: `${c.hash.slice(0, 8)}`,
    category: /^fix/i.test(c.subject) ? "bugfix" : /^feat/i.test(c.subject) ? "feature" : /^perf/i.test(c.subject) ? "perf" : "refactor",
    prompt: toPrompt(c.subject, c.body, c.tests),
    commit: c.parent,
    apply: { from: c.hash, paths: c.tests },
    verify,
    expectedFiles: c.source,
  };

  if (!verifyEach) {
    tasks.push(task);
    continue;
  }
  try {
    git(wt, "checkout", "--detach", "--force", c.parent);
    run("git clean -fdq -e node_modules", wt);
    git(wt, "checkout", c.hash, "--", ...c.tests);
    const before = run(verify, wt);
    if (before.status === 0) {
      console.error(`skip ${task.id}: tests already pass before the fix`);
      continue;
    }
    git(wt, "checkout", c.hash, "--", ...c.source);
    const after = run(verify, wt);
    if (after.status !== 0) {
      console.error(`skip ${task.id}: tests still fail with the real fix applied (needs other files?)`);
      continue;
    }
    tasks.push(task);
    console.error(`✓ ${task.id} [${task.category}] ${c.subject.slice(0, 60)}`);
  } catch (e) {
    console.error(`skip ${c.hash.slice(0, 8)}: ${String(e.message).split("\n")[0].slice(0, 120)}`);
  }
}

if (verifyEach && !keep) {
  try {
    git(repo, "worktree", "remove", "--force", wt);
  } catch {
    rmSync(wt, { recursive: true, force: true });
  }
}

const spec = {
  model,
  repeats: Number(flag("repeats", 1)),
  timeoutMinutes: 30,
  maxBudgetUsd: Number(flag("max-budget-usd", 3)),
  ...(setup ? { setup: String(setup) } : {}),
  claudeArgs: ["--permission-mode", "acceptEdits", "--allowedTools", "Bash(npx vitest:*) Bash(npx jest:*) Bash(npm test:*) Bash(npx tsc:*) mcp__narrowbit"],
  arms: [{ name: "native" }, { name: "narrowbit", narrowbit: true }],
  tasks,
};
writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
const byCat = tasks.reduce((a, t) => ((a[t.category] = (a[t.category] ?? 0) + 1), a), {});
console.error(`\nwrote ${tasks.length} task(s) to ${out}${verifyEach ? " (each verified fail→pass)" : " (NOT verified; re-run with --verify-each)"}`);
console.error(`categories: ${Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(", ")}`);
