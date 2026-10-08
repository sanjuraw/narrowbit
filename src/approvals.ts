import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
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
 * own checks (`verify`, `npx vitest …`), so asking for each one was most of the clicking (history entry 55).
 *
 * This is an ALLOWLIST OF PARSED COMMANDS, not a list of things to exclude. Three review rounds found a new way around every
 * regular-expression exclusion, because a check on the spelling of a command is not a check on what the tool receives. So the
 * command is first parsed the way the shell would (quotes grouped and removed, expansions refused), and then each program is
 * admitted only in forms written out below: an exact set of flags, operands that are plain relative paths inside the project
 * (never a secret file, never through a link out), and nothing else. A program or flag not listed asks. Recursive discovery
 * (`grep -r`, `rg`, `find`, `tree`, `du`) is not listed: the agent has its own grep, search and read actions that respect the
 * ignore rules, and a shell tool that walks the folder would also walk into `.env`.
 *
 * Allowed: the project's configured check commands (exactly as configured), the forms below, and `2>&1`; any of them may be
 * piped into a stdin-only filter (`| tail -15`). Chaining, redirects, substitutions, background jobs, and every command after
 * the agent edited a file that defines what a check runs (`warning` from scriptWarning) ask. Running the project's tests still
 * runs code the agent may have edited; that is what choosing this mode accepts.
 */

/** The words the shell would pass to the program: quotes group a word (so a path with a space stays one path) and are removed.
 * Null when a quote is left open. Backslashes never reach here (they are refused before). */
export function shellWords(part: string): string[] | null {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: string | null = null;
  for (const ch of part) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "#" && !inWord) {
      break;   // an unquoted # at the start of a word begins a comment: the shell ignores the rest of the line
    } else if (ch === " " || ch === "\t") {
      // The shell splits words on space and tab only (and newline, which is refused earlier); NBSP, form feed and the like are part of a word.
      if (inWord) { words.push(cur); cur = ""; inWord = false; }
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) words.push(cur);
  return words;
}

/** A path operand: relative, inside the project (also through links), not a secret file under any spelling (`.e'nv'`, `HEAD:.env`). */
function plainPath(word: string, root?: string): boolean {
  if (!word || word.startsWith("-")) return false;
  if (word.startsWith("/") || word.startsWith("~") || word.split(/[\\/]/).includes("..")) return false;
  for (const seg of word.split(":")) if (isSecretFile(seg)) return false;
  if (root) {
    try {
      const real = realpathSync(resolve(root, word));
      const base = realpathSync(root);
      if (real !== base && !real.startsWith(base + sep)) return false;
    } catch { /* does not exist: a pattern, a revision, or a path that will fail on its own */ }
    // A name that does not exist yet could be created through a linked parent: the nearest parent that exists must be inside too.
    let probe = resolve(root, word);
    for (let i = 0; i < 64; i++) {
      try { lstatSync(probe); break; } catch { probe = dirname(probe); }
    }
    try {
      const real = realpathSync(probe);
      const base = realpathSync(root);
      if (real !== base && !real.startsWith(base + sep)) return false;
    } catch { /* nothing to judge */ }
  }
  return true;
}

const NUM = /^\d+$/;

/** Walks flags and operands: a flag must match `flags` (one that takes a value is listed in `valued`, its next word is consumed);
 * anything else is an operand and must satisfy `operand`. A `--` ends the flags. */
function argsOk(args: string[], flags: RegExp, operand: (w: string) => boolean, valued?: RegExp, valueOk: (w: string) => boolean = () => true): boolean {
  let afterDashes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!afterDashes && a === "--") { afterDashes = true; continue; }
    if (!afterDashes && a.startsWith("-") && a.length > 1) {
      if (valued && valued.test(a)) { if (i + 1 >= args.length || !valueOk(args[i + 1])) return false; i++; continue; }
      if (!flags.test(a)) return false;
      continue;
    }
    if (!operand(a)) return false;
  }
  return true;
}

type Check = (args: string[], root: string | undefined, filter: boolean) => boolean;

const files = (root?: string) => (w: string) => plainPath(w, root);
const none = () => false;

const READERS: Record<string, Check> = {
  pwd: (a) => a.length === 0,
  ls: (a, r, f) => !f && argsOk(a, /^-[alhtrS1FdiA]+$/, files(r)),
  wc: (a, r, f) => argsOk(a, /^-[lwcmL]+$/, f ? none : files(r)),
  cat: (a, r, f) => argsOk(a, /^-[nbs]+$/, f ? none : files(r)),
  head: (a, r, f) => argsOk(a, /^(-\d+|-n\d+|-c\d+)$/, f ? none : files(r), /^-[nc]$/, (w) => NUM.test(w)),
  tail: (a, r, f) => argsOk(a, /^(-\d+|-n\d+|-c\d+)$/, f ? none : files(r), /^-[nc]$/, (w) => NUM.test(w)),
  file: (a, r, f) => !f && argsOk(a, /^-[bi]+$/, files(r)),
  sort: (a, _r, f) => f && argsOk(a, /^-[nrufbdVs]+$/, none),
  uniq: (a, _r, f) => f && argsOk(a, /^-[cdui]+$/, none),
  // grep names its pattern first, then (as a head command) files; as a filter it has the pattern only. Never recursive, never -f.
  grep: (a, r, f) => {
    const pos: string[] = [];
    if (!argsOk(a, /^-[ivEFwxcnoHhq]+$/, (w) => { pos.push(w); return true; })) return false;
    return pos.length >= 1 && (f ? pos.length === 1 : pos.slice(1).every((w) => plainPath(w, r)));
  },
};

const GIT_REV = (r?: string) => (w: string) => plainPath(w, r);
const GIT: Record<string, (a: string[], r?: string) => boolean> = {
  status: (a, r) => argsOk(a, /^(-s|--short|-b|--branch|--porcelain(=v[12])?|-u(no|normal|all)?|--untracked-files(=(no|normal|all))?|--ignored|--no-renames)$/, GIT_REV(r)),
  diff: (a, r) => argsOk(a, /^(--stat|--shortstat|--numstat|--name-only|--name-status|--cached|--staged|--no-color|--color=never|-w|--ignore-all-space|-b|--patch|-p|-U\d+|--unified=\d+|--no-renames|-M|--summary|--check|--diff-filter=[A-Za-z]+|--quiet|--exit-code|--minimal|--word-diff(=\w+)?|--full-index)$/, GIT_REV(r)),
  log: (a, r) => argsOk(a, /^(--oneline|--stat|--shortstat|--name-only|--name-status|-p|--patch|--graph|--decorate|--no-decorate|--no-merges|--merges|--first-parent|--reverse|--follow|--all|--abbrev-commit|--no-color|-\d+|-n\d+|--max-count=\d+|--since=.+|--until=.+|--author=.+|--grep=.+|--format=.*|--pretty=.*|--date=[\w:-]+|-i|--regexp-ignore-case|--diff-filter=[A-Za-z]+|-U\d+)$/, GIT_REV(r), /^-n$/, (w) => NUM.test(w)),
  show: (a, r) => argsOk(a, /^(--stat|--shortstat|--name-only|--name-status|--oneline|-s|--no-patch|-p|--patch|--no-color|--pretty=.*|--format=.*|-U\d+|--summary)$/, GIT_REV(r)),
  "rev-parse": (a, r) => argsOk(a, /^(--short(=\d+)?|--abbrev-ref|--show-toplevel|--is-inside-work-tree|--verify|--symbolic-full-name)$/, GIT_REV(r)),
  "ls-files": (a, r) => argsOk(a, /^(-c|--cached|-o|--others|-m|--modified|-d|--deleted|-s|--stage|--exclude-standard)$/, GIT_REV(r)),
  blame: (a, r) => argsOk(a, /^(-w|-e|-l|-s|--abbrev=\d+|-L\d+,\d+)$/, GIT_REV(r)),
  // `git branch` lists; with a name it creates, and -d / -D / -m / -c delete, rename or copy: only the listing forms.
  branch: (a) => a.every((x) => /^(-a|-r|-v|-vv|--all|--remotes|--verbose|--list|--show-current)$/.test(x)),
};

const SCRIPT_NAME = /^(test|typecheck|type-check|lint|check)(:[\w-]+)?$/;
const QUIET = /^(--silent|-s|--quiet|--if-present)$/;

/** package-manager script runs: only the conventional check scripts, with no arguments forwarded to them. */
function packageScript(a: string[]): boolean {
  const rest = a[0] === "run" || a[0] === "run-script" ? a.slice(1) : a;
  if (!rest.length || !SCRIPT_NAME.test(rest[0])) return false;
  return rest.slice(1).every((x) => QUIET.test(x));
}

const testFiles = (r?: string) => (w: string) => plainPath(w, r);

const TOOLS: Record<string, (a: string[], r?: string) => boolean> = {
  vitest: (a, r) => argsOk(a[0] === "run" ? a.slice(1) : a, /^(--run|--silent|--reporter=(dot|default|verbose|tap|json)|--bail=\d+|--passWithNoTests|--coverage\.enabled=false|--allowOnly)$/, testFiles(r), /^(-t|--testNamePattern)$/),
  jest: (a, r) => argsOk(a, /^(--ci|--silent|--runInBand|-i|--bail|--passWithNoTests|--verbose)$/, testFiles(r), /^(-t|--testNamePattern)$/),
  mocha: (a, r) => argsOk(a, /^(--reporter=\w+|--bail|--exit)$/, testFiles(r)),
  ava: (a, r) => argsOk(a, /^$/, testFiles(r)),
  tap: (a, r) => argsOk(a, /^$/, testFiles(r)),
  eslint: (a, r) => argsOk(a, /^(--max-warnings=\d+|--quiet|--no-fix)$/, testFiles(r), /^(-f|--format)$/, (w) => /^\w+$/.test(w)),
  // tsc only as a typecheck: --noEmit is required (without it tsc writes the compiled files into the project).
  tsc: (a, r) => a.includes("--noEmit") && argsOk(a, /^(--noEmit|--pretty|--skipLibCheck|--strict)$/, none, /^(-p|--project)$/, (w) => plainPath(w, r)),
  pytest: (a, r) => argsOk(a, /^(-q|-qq|-x|-v|-vv|-s|-ra|--lf|--tb=(short|line|no|long|native)|--maxfail=\d+|--no-header)$/, testFiles(r), /^(-k|-m)$/),
  mypy: (a, r) => argsOk(a, /^(--strict|--ignore-missing-imports|--no-error-summary|--pretty)$/, testFiles(r)),
  unittest: (a, r) => argsOk(a, /^(-v|-q|-b)$/, testFiles(r)),
};

function runnerOk(words: string[], root?: string): boolean {
  const [prog, ...a] = words;
  if (["npm", "pnpm", "yarn", "bun"].includes(prog)) {
    if (a[0] === "exec" && prog === "pnpm") return execTool(a.slice(1), root);
    if (a[0] === "test") return a.slice(1).every((x) => QUIET.test(x));
    return packageScript(a);
  }
  if (prog === "npx" || prog === "bunx") return execTool(a, root);
  if (/^(\.?venv\/bin\/)?python3?$/.test(prog)) return a[0] === "-m" && !!TOOLS[a[1]] && ["pytest", "mypy", "unittest"].includes(a[1]) && TOOLS[a[1]](a.slice(2), root);
  if (/^(\.?venv\/bin\/)?(pytest|mypy)$/.test(prog)) return TOOLS[prog.split("/").pop()!](a, root);
  const bare = /^(?:\.\/node_modules\/\.bin\/)?(vitest|jest|mocha|ava|tap|eslint|tsc)$/.exec(prog);
  if (bare) return TOOLS[bare[1]](a, root);
  if (/^(\.?venv\/bin\/)?ruff$/.test(prog)) return a[0] === "check" && argsOk(a.slice(1), /^(--no-fix|--statistics|--output-format=\w+|--quiet)$/, testFiles(root));
  if (prog === "go") return (a[0] === "test" || a[0] === "vet") && argsOk(a.slice(1), /^(-v|-race|-short|-cover|-count=\d+)$/, testFiles(root), /^-run$/);
  if (prog === "cargo") return ["test", "check", "clippy"].includes(a[0]) && argsOk(a.slice(1), /^(--workspace|--all-targets|-q|--quiet|--lib|--bins|--tests|--release)$/, none);
  return false;
}

function execTool(a: string[], root?: string): boolean {
  const tool = a[0];
  return !!tool && ["vitest", "jest", "mocha", "ava", "tap", "eslint", "tsc"].includes(tool) && TOOLS[tool](a.slice(1), root);
}

/** Splits at the `|` characters the shell treats as pipes (not those inside quotes). Null when a quote is left open. */
function splitPipes(cmd: string): string[] | null {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of cmd) {
    if (quote) { if (ch === quote) quote = null; cur += ch; }
    else if (ch === "'" || ch === '"') { quote = ch; cur += ch; }
    else if (ch === "|") { parts.push(cur.replace(/^[ \t]+|[ \t]+$/g, "")); cur = ""; }
    else cur += ch;
  }
  if (quote) return null;
  parts.push(cur.replace(/^[ \t]+|[ \t]+$/g, ""));
  return parts;
}

export function allowedAsCheck(command: string, checks: readonly string[], warning?: string, root?: string): boolean {
  if (warning) return false;
  // Only plain ASCII text with space and tab between words. Every other control or space-like character (CR, vertical tab, form
  // feed, NBSP, line and paragraph separators, byte-order mark …) is part of a word for sh but would be trimmed or split by JavaScript,
  // so the path that was checked would not be the path that is opened.
  if (/[^\x20-\x7e\t\u00a1-\u2027\u202a-\u205e\u2060-\ufefe\uff00-\u{10ffff}]/u.test(command) || /[\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(command)) return false;
  const cmd = command.replace(/^[ \t]+|[ \t]+$/g, "").replace(/[ \t]+2>&1(?=[ \t]|$)/g, "");
  if (!cmd || /[;&`\n<>]|\$\(|\|\|/.test(cmd)) return false;
  const parts = splitPipes(cmd);
  if (!parts || parts.some((p) => !p)) return false;
  const [head, ...rest] = parts;
  const configured = checks.some((c) => c.replace(/^[ \t]+|[ \t]+$/g, "").replace(/[ \t]+2>&1(?=[ \t]|$)/g, "") === head);
  const check = (part: string, filter: boolean): boolean => {
    // Expansions are refused as the shell would perform them: an unquoted glob, variable or `~`, a `$` or backtick inside double quotes.
    const noSingle = part.replace(/'[^']*'/g, "''");
    for (const dq of noSingle.match(/"[^"]*"/g) ?? []) if (/[$`\\]/.test(dq)) return false;
    if (/[*?\[\]{}$\\]/.test(noSingle.replace(/"[^"]*"/g, '""'))) return false;
    if (/(^|[ \t])~/.test(noSingle.replace(/"[^"]*"/g, '""'))) return false;
    const words = shellWords(part);
    if (!words || !words.length) return false;
    const [prog, ...args] = words;
    // The program must be written plainly. Hardening of what runs (git, npx) is done on the spelling it sees, so a quoted `"git"`
    // would be admitted here and then run unhardened.
    if (!part.startsWith(prog + " ") && !part.startsWith(prog + "\t") && part !== prog) return false;
    if (prog === "git") return !filter && !!GIT[args[0]] && GIT[args[0]](args.slice(1), root);
    if (READERS[prog]) return READERS[prog](args, root, filter);
    return !filter && runnerOk(words, root);
  };
  if (!configured && !check(head, false)) return false;
  // A filter after a pipe reads its standard input and nothing else.
  return rest.every((s) => check(s, true));
}
