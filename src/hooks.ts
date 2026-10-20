import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Paths, NarrowbitConfig } from "./config.js";
import { runCommand } from "./compress.js";
import { redact } from "./redact.js";

/**
 * Hooks: commands of your own that run around what the agent does. `afterEdit` runs after each edit it applies (a formatter, say,
 * with the file's path in $NARROWBIT_FILE); `afterTask` runs when a task ends (a notice, say, with $NARROWBIT_OUTCOME). They run in
 * the project folder with the project's usual environment and a time limit, and a failing hook never stops the task. Because a hook is
 * code that runs without asking, one that a repository ships in its own settings only runs once you have accepted it (trust.ts).
 */
export type HookName = "afterEdit" | "afterTask";
export const HOOK_NAMES: HookName[] = ["afterEdit", "afterTask"];
const HOOK_TIMEOUT_MS = 30_000;

export function configuredHooks(cfg: Pick<NarrowbitConfig, "hooks">): Partial<Record<HookName, string>> {
  const out: Partial<Record<HookName, string>> = {};
  for (const n of HOOK_NAMES) {
    const v = cfg.hooks?.[n];
    if (typeof v === "string" && v.trim()) out[n] = v.trim();
  }
  return out;
}

const fileHash = (path: string): string | null => {
  try {
    return createHash("sha1").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
};

export interface HookResult {
  ran: boolean;
  exit?: number;
  /** One line for the log and, for a failed hook or a changed file, for the model. */
  note: string;
  /** afterEdit only: the hook rewrote the file (a formatter), so what the model remembers of it is out of date. */
  changed?: boolean;
}

/** Runs one hook if it is configured. `env` is what the hook can read (NARROWBIT_FILE, NARROWBIT_OUTCOME…); `file` is watched for changes. */
export async function runHook(p: Paths, cfg: Pick<NarrowbitConfig, "hooks">, name: HookName, env: Record<string, string>, file?: string): Promise<HookResult> {
  const command = configuredHooks(cfg)[name];
  if (!command) return { ran: false, note: "" };
  const before = file ? fileHash(file) : null;
  const r = await runCommand(p, command, { timeoutMs: HOOK_TIMEOUT_MS, env: { ...env, NARROWBIT_HOOK: name, NARROWBIT_ROOT: p.root } });
  const changed = file ? fileHash(file) !== before : false;
  const out = redact(r.compressed.text.trim()).split("\n").slice(0, 4).join(" | ").slice(0, 300);
  const timedOut = r.exit === 124;
  const note = `hook ${name} ${r.exit === 0 ? "ran" : timedOut ? "timed out (30 s)" : `failed (exit ${r.exit})`}${changed ? "; it rewrote the file" : ""}${out && r.exit !== 0 ? `: ${out}` : ""}`;
  return { ran: true, exit: r.exit, note, changed };
}
