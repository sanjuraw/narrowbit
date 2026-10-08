import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isSecretFile } from "./util.js";

/**
 * What "Allow for this task" remembers, shared by the terminal and the app so they cannot disagree.
 *
 * A remembered allowance covers the exact command, but a command runs code the agent can change: after you allow `npm test`,
 * an edited test or source file is what `npm test` would run next. So by default an allowance ends the moment the agent
 * has edited a file; the next run is asked about again, and the prompt lists the files that changed since you allowed it.
 * "For the whole task" is the explicit opt-out, for someone who trusts the agent with the task. A change to a file that
 * defines what a command does (package.json, a Makefile, …) always asks, whatever was chosen (runtime.ts scriptWarning).
 * A connector call is keyed to the exact call and arguments, so edits to files don't change what it will do.
 */
export interface Grant {
  /** The whole-task choice: keeps covering the command after edits. */
  always: boolean;
  /** How many edits the agent had made when this was allowed. */
  editLen: number;
}

export function covered(grant: Grant | undefined, warning: string | undefined, key: string | undefined, edits: readonly string[]): boolean {
  if (!grant || warning) return false;
  if (key) return true;
  return grant.always || edits.length === grant.editLen;
}

/** The files edited after the grant was made, each once, in the order they were first edited since. */
export function editsSince(grant: Grant, edits: readonly string[]): string[] {
  return [...new Set(edits.slice(grant.editLen))];
}

/**
 * "Ask, except checks": what may run without asking. 82% of the commands the agent asked to run on Hono were the project's
 * own checks (`verify`, `npx vitest …`), so asking for each one was most of the clicking (history entry 55). Allowed:
 * the project's configured check commands, a plain test/typecheck/lint runner call, and read-only inspection commands;
 * each may be piped into a read-only filter (`| tail -15`) and may merge stderr (`2>&1`). Anything else asks: chaining
 * (`;`, `&&`), redirects into files, substitutions, background jobs, fix/write flags, a secret file named anywhere, and
 * every command after the agent edited a file that defines what a check runs (`warning` from scriptWarning). Running the
 * project's tests still runs code the agent may have edited; that is what choosing this mode accepts.
 */
const CHECK_RUNNERS: RegExp[] = [
  /^(npx\s+|pnpm\s+exec\s+|yarn\s+|bunx\s+)?(vitest|jest|mocha|ava|tap|playwright\s+test)(\s|$)/,
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|typecheck|type-check|lint|check)(:[\w-]+)?(\s|$)/,
  /^(npx\s+)?tsc(\s|$)/,
  /^(npx\s+)?eslint(\s|$)/,
  /^((\.?venv\/bin\/)?python3?\s+-m\s+)?(pytest|mypy|unittest)(\s|$)/,
  /^(\.?venv\/bin\/)?ruff\s+check(\s|$)/,
  /^(go|cargo)\s+(test|vet|check|clippy)(\s|$)/,
];
const READ_ONLY: RegExp[] = [
  /^git\s+(status|diff|log|show|branch|rev-parse|ls-files|blame)(\s|$)/,
  /^(ls|pwd|wc|cat|head|tail|grep|rg|find|file|stat|du|tree)(\s|$)/,
];
const FILTERS = /^(tail|head|grep|rg|wc|sort|uniq|cat)(\s|$)/;
// Flags that make a check write files, update snapshots or keep running; and flags that make a reader write or run something.
const RUNNER_WRITES = /(^|\s)(--fix\b|--write\b|-u\b|--update(Snapshot)?\b|--watch\b|-w\b|--outDir\b|--outFile\b|--output\b|-o\b)/;
const READER_WRITES = /(^|\s)(-exec\b|-execdir\b|-delete\b|-ok\b|-okdir\b|-fprint\w*\b|-fls\b|--output\b|-o\b)/;

// Flags that make a read-only tool run a program or read outside what it was pointed at: rg --pre runs a script on every file,
// git --ext-diff / --textconv run configured drivers, -c sets git config, --output writes.
const READER_DANGER = /^(--pre(=|$)|--pre-glob|--ext-diff|--textconv|--output(=|$)|--exec-path|--git-dir|--work-tree|--no-index|--config|--hostname-bin|--open-files-in-pager|-O$|-c$|-C$|-fprint)/;

/**
 * A reader may look at this project's files only: no absolute or home paths, no `..`, and nothing that is (or is a link to)
 * something outside the project. Words that are not paths (a search pattern) simply do not exist as files and pass.
 */
function readerStaysInside(part: string, root?: string): boolean {
  for (const raw of part.split(/\s+/).slice(1)) {
    const word = raw.replace(/^["']|["']$/g, "");
    if (!word) continue;
    if (word.startsWith("-")) { if (READER_DANGER.test(word)) return false; continue; }
    if (word.startsWith("/") || word.startsWith("~") || word.split(/[\\/]/).includes("..")) return false;
    if (root) {
      try {
        const real = realpathSync(resolve(root, word));
        const base = realpathSync(root);
        if (real !== base && !real.startsWith(base + sep)) return false;
      } catch { /* does not exist: a pattern, or a path that will fail on its own */ }
    }
  }
  return true;
}

export function allowedAsCheck(command: string, checks: readonly string[], warning?: string, root?: string): boolean {
  if (warning) return false;
  const cmd = command.trim().replace(/\s+2>&1(?=\s|$)/g, "");
  if (!cmd || /[;&`\n<>]|\$\(|\|\|/.test(cmd)) return false;
  const parts = cmd.split("|").map((s) => s.trim());
  if (parts.some((s) => !s)) return false;
  for (const word of cmd.split(/\s+/)) if (isSecretFile(word.replace(/^["']|["']$/g, ""))) return false;
  const [head, ...rest] = parts;
  const configured = checks.some((c) => c.trim().replace(/\s+2>&1(?=\s|$)/g, "") === head);
  const runner = CHECK_RUNNERS.some((r) => r.test(head));
  const reader = READ_ONLY.some((r) => r.test(head));
  if (!configured && !(runner && !RUNNER_WRITES.test(head)) && !(reader && !READER_WRITES.test(head))) return false;
  // Readers (and their filters) are held to the project: see readerStaysInside.
  const readerOnly = !configured && !(runner && !RUNNER_WRITES.test(head));
  if (readerOnly && !readerStaysInside(head, root)) return false;
  if (!rest.every((x) => readerStaysInside(x, root))) return false;
  // A filter only reads its input; `sort -o` would write a file.
  return rest.every((s) => FILTERS.test(s) && !/^sort\b.*(\s-o\b|--output\b)/.test(s));
}
