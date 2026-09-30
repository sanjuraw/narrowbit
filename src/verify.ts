import type { NarrowbitConfig, Paths } from "./config.js";
import { runCommand, type RunResult } from "./compress.js";
import { isTestPath } from "./files.js";
import { changedSince } from "./git.js";
import { relatedTests } from "./ranker.js";
import type { Store } from "./store.js";
import type { TaskRecord } from "./tasks.js";
import { now } from "./util.js";

export interface VerifyResult {
  ok: boolean;
  ran: boolean;
  changed: string[];
  unexpected: string[];
  steps: { name: string; ok: boolean; exit: number; summary: string; run?: RunResult; skipped?: boolean }[];
  report: string;
}

/**
 * Deterministic checks after the agent claims completion. Focused tests first
 * (tests mapped to changed files); the full suite only with `full: true`.
 *
 * `opts.approve`, when given, is asked before each configured command runs — verify's commands
 * come from the repo's own config (package.json scripts, pyproject.toml, ...), so an untrusted
 * repo can put anything there; without this gate they'd run unasked even though the otherwise
 * equivalent `run` action always asks. The CLI's own `narrowbit verify` and the MCP `nb_verify`
 * tool don't pass one, since running verify there is already the user's own direct, deliberate
 * action — only the agent loop's autonomous `verify` action needs the gate.
 */
export async function verify(
  p: Paths,
  cfg: NarrowbitConfig,
  store: Store,
  task: TaskRecord | null,
  opts: { full?: boolean; base?: string; approve?: (command: string) => Promise<boolean> } = {},
): Promise<VerifyResult> {
  const base = opts.base ?? task?.head ?? "HEAD";
  const changed = changedSince(p.root, base).filter((f) => !f.startsWith(".narrowbit/"));
  const steps: VerifyResult["steps"] = [];

  const step = async (name: string, cmd: string | undefined) => {
    if (!cmd) return;
    if (opts.approve && !(await opts.approve(cmd))) {
      steps.push({ name, ok: false, exit: -1, summary: "declined by user — not run; this check is unconfirmed, not passing" });
      return;
    }
    const run = await runCommand(p, cmd);
    // Exit 127 is the shell saying the command doesn't exist here (mypy/ruff named in pyproject.toml
    // but not installed in the active environment, say). That is a missing tool, not failing code:
    // counting it as a failure made every verify red on tests that passed, and repeated failed
    // checks feed the runtime's escalation to the most expensive model. Report it as not run.
    if (run.exit === 127) {
      const tool = cmd.trim().split(/\s+/)[0];
      steps.push({ name, ok: true, skipped: true, exit: 127, summary: `skipped — \`${tool}\` isn't installed here, so this check did not run (it did not pass either)`, run });
      return;
    }
    steps.push({ name, ok: run.exit === 0, exit: run.exit, summary: run.compressed.summary, run });
  };

  await step("typecheck", cfg.verify.typecheck);
  await step("lint", cfg.verify.lint);

  const changedTests = changed.filter(isTestPath);
  const ids = changed.map((f) => store.fileByPath(f)?.id).filter((x): x is number => !!x);
  const mapped = relatedTests(store, ids, 12).map((t) => t.path);
  const focused = [...new Set([...changedTests, ...mapped])];
  if (opts.full || !cfg.verify.testFocused) await step("test", cfg.verify.test);
  else if (focused.length) await step(`tests (focused: ${focused.length})`, cfg.verify.testFocused.replace("{files}", focused.map((f) => JSON.stringify(f)).join(" ")));
  else if (cfg.verify.test) steps.push({ name: "tests", ok: true, skipped: true, exit: 0, summary: "no tests mapped to changed files (run with --full for the whole suite)" });

  // Unexpected changes: modified files that were neither selected nor mapped tests nor dirty before the task.
  const expected = new Set([...(task?.selected.map((s) => s.path) ?? []), ...(task?.tests ?? []), ...(task?.dirtyAtStart ?? [])]);
  const unexpected = task ? changed.filter((f) => !expected.has(f)) : [];

  // "Ran" means at least one check really executed. Zero configured checks, or only skipped ones
  // (tool missing, no tests mapped), is not the same as everything passing — Array.every on an
  // empty array is vacuously true, and reporting "PASSED" there was misleading. Say so plainly.
  // A declined check has no `run` (it never executed), so it doesn't count as having run either.
  const ran = steps.some((s) => !s.skipped && !!s.run);
  const ok = ran && steps.every((s) => s.ok);
  const status = steps.length === 0 ? "NO CHECKS CONFIGURED" : !ran ? "NO CHECKS RAN" : ok ? "PASSED" : "FAILED";
  const lines = [`VERIFICATION ${status}  (${changed.length} changed file(s) vs ${base.slice(0, 8)})`];
  if (steps.length === 0) lines.push("no verify.test/typecheck/lint command is set for this repo (.narrowbit/config.json) — nothing was actually checked");
  else if (!ran) lines.push("no configured check actually ran (tool not installed, declined, or nothing to run) — nothing was actually checked");
  for (const s of steps) {
    lines.push(`${s.skipped ? "–" : s.ok ? "✓" : "✗"} ${s.name}: ${s.summary}`);
    if (!s.ok && s.run) lines.push(s.run.compressed.text.split("\n").slice(0, 60).join("\n"), `  raw: ${s.run.rawLog}`);
  }
  if (unexpected.length) lines.push(`note: changed outside selected context: ${unexpected.slice(0, 10).join(", ")}`);
  return { ok, ran, changed, unexpected, steps, report: lines.join("\n") };
}

export function verifyRecord(v: VerifyResult): NonNullable<TaskRecord["verify"]> {
  return { at: now(), ok: v.ok, steps: v.steps.map(({ name, ok, exit, summary }) => ({ name, ok, exit, summary })), unexpected: v.unexpected };
}
