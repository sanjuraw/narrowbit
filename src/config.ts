import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sh } from "./util.js";

export const NB_DIR = ".narrowbit";

export interface VerifyConfig {
  typecheck?: string;
  lint?: string;
  test?: string;
  /** Command template for focused tests; `{files}` is replaced with space-separated test paths. */
  testFocused?: string;
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
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, NB_DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const g = sh("git", ["rev-parse", "--show-toplevel"], start);
  if (g.code === 0 && g.stdout.trim()) return g.stdout.trim();
  return resolve(start);
}

export function ensureDirs(p: Paths): void {
  for (const d of [p.nb, p.memory, p.tasks, p.logs, p.benchmarks, p.sessions, p.runtime, p.skills]) mkdirSync(d, { recursive: true, mode: 0o700 });
  // Self-ignoring: Narrowbit state never shows up in git status or diffs.
  const gi = join(p.nb, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*\n");
}

export function loadConfig(p: Paths): NarrowbitConfig {
  if (!existsSync(p.config)) return structuredClone(DEFAULT_CONFIG);
  const raw = JSON.parse(readFileSync(p.config, "utf8"));
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    budget: { ...DEFAULT_CONFIG.budget, ...(raw.budget ?? {}) },
    verify: { ...(raw.verify ?? {}) },
  };
}

export function saveConfig(p: Paths, c: NarrowbitConfig): void {
  writeFileSync(p.config, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

/** Detect verification commands from package.json. Deterministic, no guessing beyond what the repo declares. */
export function detectVerify(root: string): VerifyConfig {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return {};
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
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
  if (scripts.test && !/no test specified/.test(scripts.test)) v.test = pm === "npm" ? "npm test --silent" : `${pm} test`;
  if (scripts.build) v.build = run("build");
  if (deps.vitest) v.testFocused = "npx vitest run {files}";
  else if (deps.jest || deps["ts-jest"]) v.testFocused = "npx jest {files}";
  else if (deps.mocha) v.testFocused = "npx mocha {files}";
  return v;
}
