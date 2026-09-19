import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

export class Tasks {
  constructor(private p: Paths) {}

  path(id: string) {
    return join(this.p.tasks, `${id}.json`);
  }

  save(t: TaskRecord) {
    writeFileSync(this.path(t.id), JSON.stringify(t, null, 2) + "\n", { mode: 0o600 });
  }

  load(id: string): TaskRecord | null {
    const f = this.path(id);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf8"));
  }

  current(): string | null {
    const env = process.env.NARROWBIT_TASK;
    if (env && this.load(env)) return env;
    const f = join(this.p.nb, "current-task");
    return existsSync(f) ? readFileSync(f, "utf8").trim() || null : null;
  }

  setCurrent(id: string | null) {
    writeFileSync(join(this.p.nb, "current-task"), id ?? "", { mode: 0o600 });
  }

  list(): TaskRecord[] {
    if (!existsSync(this.p.tasks)) return [];
    return readdirSync(this.p.tasks)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.p.tasks, f), "utf8")) as TaskRecord;
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
    this.save(t);
    return t;
  }
}
