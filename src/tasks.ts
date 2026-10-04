import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./config.js";

export type Level = "full" | "symbols" | "outline" | "listed";

export interface SelectedItem {
  path: string;
  score: number;
  level: Level;
  tokens: number;
  fileTokens: number;
  reasons: string[];
  symbols: string[];
}

export interface TaskEvent {
  at: string;
  tool: string;
  args: Record<string, unknown>;
  tokens: number;
}

export interface RunRecord {
  at: string;
  command: string;
  exit: number;
  rawLog: string;
  rawTokens: number;
  compressedTokens: number;
  kind: string;
}

export interface TaskRecord {
  id: string;
  text: string;
  createdAt: string;
  head: string | null;
  branch: string | null;
  dirtyAtStart: string[];
  budget: number;
  packageTokens: number;
  confidence: string;
  selected: SelectedItem[];
  tests: string[];
  memory: string[];
  /** Keys of content already delivered to the agent (`file:<path>`, `sym:<id>`), for dedupe on expansion. */
  given: string[];
  events: TaskEvent[];
  runs: RunRecord[];
  stats: { repoCodeTokens: number; selectedFullTokens: number; codeFiles: number; candidates: number; rankMs: number };
  verify?: { at: string; ok: boolean; steps: { name: string; ok: boolean; exit: number; summary: string }[]; unexpected: string[] };
  closed?: {
    at: string;
    outcome: "success" | "failure" | "abandoned" | "unknown";
    filesModified: string[];
    selectedModified: string[];
    missed: string[];
    recall: number | null;
    note?: string;
  };
  source?: "cli" | "hook" | "mcp" | "benchmark" | "eval";
}

/** Task records are files a cloned repository can ship, so an id is only ever a plain name, the folder isn't a link, and a
 * record is only trusted under the name it was found by: the id *inside* the JSON must not decide where anything is written. */
const TASK_ID = /^[\w-]{1,80}$/;
const isLink = (f: string) => {
  try {
    return lstatSync(f).isSymbolicLink();
  } catch {
    return false;
  }
};

export class Tasks {
  constructor(private p: Paths) {}

  path(id: string) {
    if (!TASK_ID.test(id)) throw new Error(`invalid task id: ${JSON.stringify(id).slice(0, 60)}`);
    return join(this.p.tasks, `${id}.json`);
  }

  save(t: TaskRecord) {
    const f = this.path(t.id);
    if (isLink(this.p.nb) || isLink(this.p.tasks) || isLink(f)) throw new Error("the tasks folder or file is a symlink — refusing to write through it");
    writeFileSync(f, JSON.stringify(t, null, 2) + "\n", { mode: 0o600 });
  }

  load(id: string): TaskRecord | null {
    if (!TASK_ID.test(id)) return null;
    const f = this.path(id);
    if (isLink(this.p.nb) || isLink(this.p.tasks) || isLink(f) || !existsSync(f)) return null;
    const rec = JSON.parse(readFileSync(f, "utf8"));
    return rec && rec.id === id ? rec : null;
  }

  current(): string | null {
    const env = process.env.NARROWBIT_TASK;
    if (env && this.load(env)) return env;
    const f = join(this.p.nb, "current-task");
    if (isLink(f) || !existsSync(f)) return null;
    const id = readFileSync(f, "utf8").trim();
    return TASK_ID.test(id) ? id : null;
  }

  setCurrent(id: string | null) {
    if (id !== null && !TASK_ID.test(id)) throw new Error(`invalid task id: ${JSON.stringify(id).slice(0, 60)}`);
    writeFileSync(join(this.p.nb, "current-task"), id ?? "", { mode: 0o600 });
  }

  list(): TaskRecord[] {
    if (!existsSync(this.p.tasks) || isLink(this.p.nb) || isLink(this.p.tasks)) return [];
    return readdirSync(this.p.tasks)
      .filter((f) => f.endsWith(".json") && !isLink(join(this.p.tasks, f)))
      .map((f) => {
        try {
          const rec = JSON.parse(readFileSync(join(this.p.tasks, f), "utf8")) as TaskRecord;
          return rec && `${rec.id}.json` === f ? rec : null;
        } catch {
          return null;
        }
      })
      .filter((t): t is TaskRecord => !!t)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Mutate a task record atomically-ish (read-modify-write). */
  update(id: string, fn: (t: TaskRecord) => void): TaskRecord | null {
    const t = this.load(id);
    if (!t) return null;
    fn(t);
    t.id = id; // saved under the name it was loaded by, whatever the record claims
    this.save(t);
    return t;
  }
}
