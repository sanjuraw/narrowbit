import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeProjectFile, stateText } from "./util.js";
import { redactCommand, redactValue } from "./redact.js";
import { dirname, join } from "node:path";
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
    // Whoever produced the record, a credential in a command or a tool argument is hidden before it reaches the disk.
    const safe = { ...t, ...(Array.isArray(t.runs) ? { runs: t.runs.map((r) => ({ ...r, command: redactCommand(r.command) })) } : {}), ...(Array.isArray(t.events) ? { events: t.events.map((e) => (e.args ? { ...e, args: redactValue(e.args) as typeof e.args } : e)) } : {}) };
    writeProjectFile(dirname(this.p.nb), f, JSON.stringify(safe, null, 2) + "\n");
  }

  load(id: string): TaskRecord | null {
    if (!TASK_ID.test(id)) return null;
    const f = this.path(id);
    const text = stateText(dirname(this.p.nb), f);
    if (text === null) return null;
    const rec = JSON.parse(text);
    return rec && rec.id === id ? rec : null;
  }

  current(): string | null {
    const env = process.env.NARROWBIT_TASK;
    if (env && this.load(env)) return env;
    const f = join(this.p.nb, "current-task");
    const id = (stateText(dirname(this.p.nb), f) ?? "").trim();
    return TASK_ID.test(id) ? id : null;
  }

  setCurrent(id: string | null) {
    if (id !== null && !TASK_ID.test(id)) throw new Error(`invalid task id: ${JSON.stringify(id).slice(0, 60)}`);
    writeProjectFile(dirname(this.p.nb), join(this.p.nb, "current-task"), id ?? "");
  }

  list(): TaskRecord[] {
    if (!existsSync(this.p.tasks) || isLink(this.p.nb) || isLink(this.p.tasks)) return [];
    return readdirSync(this.p.tasks)
      .filter((f) => f.endsWith(".json") && !isLink(join(this.p.tasks, f)))
      .map((f) => {
        try {
          const rec = JSON.parse(stateText(dirname(this.p.nb), join(this.p.tasks, f)) ?? "null") as TaskRecord;
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
