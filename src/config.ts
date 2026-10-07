import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isTrusted, repoConfigRisks } from "./trust.js";
import { sh, writeProjectFile, stateText, sourceText } from "./util.js";

export const NB_DIR = ".narrowbit";

export interface VerifyConfig {
  typecheck?: string;
  lint?: string;
  test?: string;
  /** Command template for focused tests; `{files}` is replaced with space-separated test paths. */
  testFocused?: string;
  /** Command template for linting only the changed files; `{files}` is replaced with their paths. Used instead of `lint` unless a full check is asked for. */
  lintFocused?: string;
  build?: string;
}

export interface NarrowbitConfig {
  version: 1;
  budget: { initial: number; reserve: number; max: number };
  verify: VerifyConfig;
  /** Files larger than this are indexed for outline only, never inlined whole. */
  maxInlineFileTokens: number;
  /** Skip parsing files larger than this many bytes. */
  maxFileBytes: number;
  /** Extra read-only folders of Markdown notes used as project memory (e.g. a folder in an Obsidian vault). */
  memoryDirs: string[];
  /** `narrowbit agent` defaults for this repo; CLI flags override. See providers/models.ts. */
  agent?: AgentConfig;
}

export interface AgentConfig {
  provider?: string;
  effort?: string;
  /** Per-provider model per phase, e.g. { claude: { explore: "haiku" }, codex: { escalate: "gpt-6-sol" } }. */
  models?: Record<string, { explore?: string; execute?: string; escalate?: string }>;
  /** Per-provider endpoint overrides for API/local providers, e.g. { custom: { baseUrl: "http://…/v1", keyEnv: "MY_KEY" } }. */
  endpoints?: Record<string, { baseUrl?: string; keyEnv?: string }>;
  /** Backup provider (its saved models are used) that takes over mid-task if the main one fails with a limit, timeout or
   * server error — instead of ending the task. Idea from OmniRoute's fallback chain. Off unless set. */
  fallback?: string;
  /** Research first on another model, as "provider:model" (e.g. "codex:gpt-6-sol"): it reads the repository in its own
   * conversation and hands the worker a short report. Off unless set. See runtime.ts scoutPhase. */
  scout?: string;
  /** Lead mode: model 3 plans the task up front and reviews the diff before "done". Default off (measured worse than a single model for typical tasks; kept as an opt-in). */
  boss?: boolean;
  /** Skip the plan call, still review the diff (a cheaper alternative to full lead mode). Ignored when `boss` is on. */
  reviewOnly?: boolean;
  /** Ask the user to approve the lead's plan (or ask for changes) before work starts. Needs `boss` on. Default off. */
  planApproval?: boolean;
  /** Pin the model's context window (tokens) — what automatic compaction at 95% is measured against. Normally discovered. */
  contextWindow?: number;
}

export const DEFAULT_CONFIG: NarrowbitConfig = {
  version: 1,
  budget: { initial: 8000, reserve: 2000, max: 30000 },
  verify: {},
  maxInlineFileTokens: 1500,
  maxFileBytes: 1_000_000,
  memoryDirs: [],
};

export const DEFAULT_IGNORE = `# Narrowbit exclusions (gitignore syntax subset). .gitignore is also respected.
.env
.env.*
*.pem
*.key
*.p12
*.pfx
id_rsa*
id_ed25519*
*.keystore
credentials*.json
secrets.*
node_modules/
dist/
build/
out/
coverage/
.next/
.nuxt/
.turbo/
.cache/
*.min.js
*.map
*.lock
package-lock.json
pnpm-lock.yaml
yarn.lock
*.snap
`;

export interface Paths {
  root: string;
  nb: string;
  db: string;
  config: string;
  ignore: string;
  memory: string;
  tasks: string;
  logs: string;
  benchmarks: string;
  sessions: string;
  /** Owned-runtime state (events.ts/evidence.ts): one dir per task, `<id>/events.jsonl` + `<id>/evidence/`. */
  runtime: string;
  /** User-authored, reusable task templates (skills.ts): one `<slug>.md` per skill. */
  skills: string;
}

export function paths(root: string): Paths {
  const nb = join(root, NB_DIR);
  return {
    root,
    nb,
    db: join(nb, "index.db"),
    config: join(nb, "config.json"),
    ignore: join(root, ".narrowbitignore"),
    memory: join(nb, "memory"),
    tasks: join(nb, "tasks"),
    logs: join(nb, "logs"),
    benchmarks: join(nb, "benchmarks"),
    sessions: join(nb, "sessions"),
    runtime: join(nb, "runtime"),
    skills: join(nb, "skills"),
  };
}

/** Find repo root: nearest ancestor containing .narrowbit, else git toplevel, else cwd. */
export function findRoot(start = process.cwd()): string {
  const from = resolve(start);
  const real = (d: string) => {
    try {
      return realpathSync(d);
    } catch {
      return d;
    }
  };
  // Inside a git repository the project is that repository, or a folder inside it with its own .narrowbit/. The walk
  // up stops at the repository's top folder, so a .narrowbit/ further up can't become the project — in particular the
  // home folder's ~/.narrowbit, which holds Narrowbit's own settings and is never a project.
  const g = sh("git", ["rev-parse", "--show-toplevel"], from);
  const top = g.code === 0 && g.stdout.trim() ? real(g.stdout.trim()) : null;
  const home = real(homedir());
  let dir = from;
  for (;;) {
    if (real(dir) !== home && existsSync(join(dir, NB_DIR))) return dir;
    if (top && real(dir) === top) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

/** Throws if `.narrowbit` or one of the folders inside it is a symlink. A repository can ship such a link (git tracks a
 * symlink as one entry), and creating state "inside" it would put the config, index and logs wherever it points. */
export function assertStateNotLinked(p: Paths, extra: string[] = []): void {
  for (const d of [p.nb, p.memory, p.tasks, p.logs, p.benchmarks, p.sessions, p.runtime, p.skills, ...extra]) {
    let linked = false;
    try { linked = lstatSync(d).isSymbolicLink(); } catch { /* not there yet */ }
    if (linked) throw new Error(`${d} is a symlink — Narrowbit won't keep its state through a link (remove it, or replace it with a real folder)`);
  }
}

export function ensureDirs(p: Paths): void {
  assertStateNotLinked(p);
  for (const d of [p.nb, p.memory, p.tasks, p.logs, p.benchmarks, p.sessions, p.runtime, p.skills]) mkdirSync(d, { recursive: true, mode: 0o700 });
  // Self-ignoring: Narrowbit state never shows up in git status or diffs. "wx": never through a link squatting on the name.
  try { writeFileSync(join(p.nb, ".gitignore"), "*\n", { flag: "wx" }); } catch { /* already there */ }
}

const warned = new Set<string>();

export function loadConfig(p: Paths): NarrowbitConfig {
  // A settings file reached through a link, or that is also some other file, counts as no settings file.
  const text = stateText(dirname(p.nb), p.config);
  if (text === null) return structuredClone(DEFAULT_CONFIG);
  const raw = JSON.parse(text);
  const cfg: NarrowbitConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    budget: { ...DEFAULT_CONFIG.budget, ...(raw.budget ?? {}) },
    verify: { ...(raw.verify ?? {}) },
  };
  // A repo can ship its own config. Endpoint overrides and extra memory folders decide where your code and keys go
  // and what notes are read, so they only count once the user has accepted them (trust.ts); until then they are
  // dropped here, which covers every entry point (CLI, app, MCP) without each having to remember to check.
  const risks = repoConfigRisks(raw);
  if (risks.length && !isTrusted(p.root, risks)) {
    cfg.memoryDirs = [];
    if (cfg.agent?.endpoints) cfg.agent = { ...cfg.agent, endpoints: undefined };
    if (!warned.has(p.root)) {
      warned.add(p.root);
      process.stderr.write(`narrowbit: ignoring the API endpoint / memory folder settings in ${p.config} — this repository isn't trusted yet (narrowbit agent --trust, or open it in the app).\n`);
    }
  }
  return cfg;
}

export function saveConfig(p: Paths, c: NarrowbitConfig): void {
  writeProjectFile(dirname(p.nb), p.config, JSON.stringify(c, null, 2) + "\n");
}

/** Detect verification commands from package.json, or from pyproject.toml/setup.cfg for a Python project. */
export function detectVerify(root: string): VerifyConfig {
  const pkgPath = join(root, "package.json");
  let present = true;
  try { lstatSync(pkgPath); } catch { present = false; }
  if (!present) return detectVerifyPython(root);
  let pkg: any;
  try {
    // Not through a link: what package.json says decides which commands verify runs.
    pkg = JSON.parse(sourceText(root, pkgPath) ?? "not readable");
  } catch {
    return {};
  }
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const pm = existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(root, "yarn.lock")) ? "yarn" : "npm";
  const run = (s: string) => (pm === "npm" ? `npm run -s ${s}` : `${pm} ${s}`);
  const v: VerifyConfig = {};
  const tc = ["typecheck", "type-check", "tsc", "check-types"].find((s) => scripts[s]);
  if (tc) v.typecheck = run(tc);
  else if (deps.typescript && existsSync(join(root, "tsconfig.json"))) v.typecheck = "npx tsc --noEmit -p .";
  if (scripts.lint) v.lint = run("lint");
  // ESLint over the whole tree was the slowest check on Hono (4 s of a ~5 s verify, history entry 62); the changed files alone take ~1 s.
  if (scripts.lint && /\beslint\b/.test(scripts.lint) && deps.eslint) v.lintFocused = "npx eslint {files}";
  if (scripts.test && !/no test specified/.test(scripts.test)) v.test = pm === "npm" ? "npm test --silent" : `${pm} test`;
  if (scripts.build) v.build = run("build");
  if (deps.vitest) v.testFocused = "npx vitest run {files}";
  else if (deps.jest || deps["ts-jest"]) v.testFocused = "npx jest {files}";
  else if (deps.mocha) v.testFocused = "npx mocha {files}";
  return v;
}

function tryRead(path: string): string {
  return sourceText(dirname(path), path) ?? "";
}

/** Same detection, for a Python project: only what the repo's own config files declare, nothing guessed. */
function detectVerifyPython(root: string): VerifyConfig {
  const text = tryRead(join(root, "pyproject.toml"));
  const setupCfg = tryRead(join(root, "setup.cfg"));
  const isPython =
    text !== "" ||
    existsSync(join(root, "setup.py")) ||
    setupCfg !== "" ||
    existsSync(join(root, "requirements.txt")) ||
    existsSync(join(root, "requirements-dev.txt"));
  if (!isPython) return {};
  const v: VerifyConfig = {};
  const hasTests =
    existsSync(join(root, "tests")) || existsSync(join(root, "test")) || /\[tool\.pytest/.test(text) || /^\[pytest/m.test(setupCfg) || existsSync(join(root, "pytest.ini"));
  if (hasTests) {
    v.test = "pytest -q";
    v.testFocused = "pytest -q {files}";
  }
  if (/\[tool\.mypy\]/.test(text) || existsSync(join(root, "mypy.ini"))) v.typecheck = "mypy .";
  if (/\[tool\.ruff/.test(text) || existsSync(join(root, "ruff.toml")) || existsSync(join(root, ".ruff.toml"))) v.lint = "ruff check .";
  else if (existsSync(join(root, ".flake8")) || /\[flake8\]/.test(setupCfg)) v.lint = "flake8";
  return v;
}
