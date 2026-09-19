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
  changed: string[];
  unexpected: string[];
  steps: { name: string; ok: boolean; exit: number; summary: string; run?: RunResult }[];
  report: string;
}

/**
 * Deterministic checks after the agent claims completion. Focused tests first
 * (tests mapped to changed files); the full suite only with `full: true`.
 */
export async function verify(p: Paths, cfg: NarrowbitConfig, store: Store, task: TaskRecord | null, opts: { full?: boolean; base?: string } = {}): Promise<VerifyResult> {
  const base = opts.base ?? task?.head ?? "HEAD";
  const changed = changedSince(p.root, base).filter((f) => !f.startsWith(".narrowbit/"));
  const steps: VerifyResult["steps"] = [];

  const step = async (name: string, cmd: string | undefined) => {
    if (!cmd) return;
    const run = await runCommand(p, cmd);
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
  else if (cfg.verify.test) steps.push({ name: "tests", ok: true, exit: 0, summary: "no tests mapped to changed files (run with --full for the whole suite)" });

  // Unexpected changes: modified files that were neither selected nor mapped tests nor dirty before the task.
  const expected = new Set([...(task?.selected.map((s) => s.path) ?? []), ...(task?.tests ?? []), ...(task?.dirtyAtStart ?? [])]);
  const unexpected = task ? changed.filter((f) => !expected.has(f)) : [];

  const ok = steps.every((s) => s.ok);
  const lines = [`VERIFICATION ${ok ? "PASSED" : "FAILED"}  (${changed.length} changed file(s) vs ${base.slice(0, 8)})`];
  for (const s of steps) {
    lines.push(`${s.ok ? "✓" : "✗"} ${s.name}: ${s.summary}`);
    if (!s.ok && s.run) lines.push(s.run.compressed.text.split("\n").slice(0, 60).join("\n"), `  raw: ${s.run.rawLog}`);
  }
  if (unexpected.length) lines.push(`note: changed outside selected context: ${unexpected.slice(0, 10).join(", ")}`);
  return { ok, changed, unexpected, steps, report: lines.join("\n") };
}

export function verifyRecord(v: VerifyResult): NonNullable<TaskRecord["verify"]> {
  return { at: now(), ok: v.ok, steps: v.steps.map(({ name, ok, exit, summary }) => ({ name, ok, exit, summary })), unexpected: v.unexpected };
}
