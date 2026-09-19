import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./config.js";
import { termsOf } from "./terms.js";
import { now, shortId } from "./util.js";

export const MEMORY_TYPES = ["fact", "decision", "constraint", "convention", "failure", "bug", "command", "environment"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  text: string;
  reason?: string;
  /** For failures: what was tried and what happened. */
  attempt?: string;
  result?: string;
  files?: string[];
  tags?: string[];
  source?: string;
  date: string;
  confidence?: "low" | "medium" | "high";
  status: "active" | "superseded" | "resolved";
  supersededBy?: string;
}

/**
 * Durable project knowledge, stored as plain JSON (one file per type) so it
 * can be reviewed by humans and committed to the repository if desired.
 */
export class Memory {
  constructor(private p: Paths) {}

  private file(type: MemoryType) {
    return join(this.p.memory, `${type}s.json`);
  }

  load(type?: MemoryType): MemoryEntry[] {
    const types = type ? [type] : MEMORY_TYPES;
    const out: MemoryEntry[] = [];
    for (const t of types) {
      const f = this.file(t);
      if (!existsSync(f)) continue;
      try {
        out.push(...(JSON.parse(readFileSync(f, "utf8")) as MemoryEntry[]));
      } catch {
        /* corrupted file: skip rather than crash the agent loop */
      }
    }
    return out;
  }

  private save(type: MemoryType, entries: MemoryEntry[]) {
    writeFileSync(this.file(type), JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
  }

  add(e: Omit<MemoryEntry, "id" | "date" | "status"> & Partial<Pick<MemoryEntry, "status">>): MemoryEntry {
    if (!MEMORY_TYPES.includes(e.type)) throw new Error(`unknown memory type: ${e.type} (expected ${MEMORY_TYPES.join(", ")})`);
    const entry: MemoryEntry = { id: `${e.type.slice(0, 3)}-${shortId()}`, date: now(), status: "active", ...e };
    const list = this.load(e.type);
    list.push(entry);
    this.save(e.type, list);
    return entry;
  }

  setStatus(id: string, status: MemoryEntry["status"], supersededBy?: string): MemoryEntry | null {
    for (const t of MEMORY_TYPES) {
      const list = this.load(t);
      const e = list.find((x) => x.id === id);
      if (e) {
        e.status = status;
        if (supersededBy) e.supersededBy = supersededBy;
        this.save(t, list);
        return e;
      }
    }
    return null;
  }

  /**
   * Relevant active entries for a task: constraints/conventions always compete,
   * others need term or file overlap. Deterministic scoring, no model calls.
   */
  relevant(taskTerms: string[], files: string[], limit = 8): { entry: MemoryEntry; score: number; why: string }[] {
    const tset = new Set(taskTerms);
    const fset = new Set(files);
    const scored: { entry: MemoryEntry; score: number; why: string }[] = [];
    for (const e of this.load()) {
      if (e.status !== "active") continue;
      const eterms = new Set(termsOf([e.text, e.reason, e.attempt, e.result, ...(e.tags ?? [])].filter(Boolean).join(" ")));
      let overlap = 0;
      for (const t of eterms) if (tset.has(t)) overlap++;
      const fileHits = (e.files ?? []).filter((f) => fset.has(f) || [...fset].some((s) => s.startsWith(f.replace(/\/?$/, "/"))));
      let score = overlap * 2 + fileHits.length * 4;
      const whys: string[] = [];
      if (overlap) whys.push(`${overlap} shared terms`);
      if (fileHits.length) whys.push(`touches ${fileHits.join(", ")}`);
      if (e.type === "constraint" || e.type === "convention") {
        score += 1.5;
        if (!whys.length) whys.push(`project-wide ${e.type}`);
      }
      if (e.type === "failure" && score > 0) score += 2; // dead ends are expensive to rediscover
      if (score >= 1.5) scored.push({ entry: e, score, why: whys.join("; ") });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

export function renderMemory(e: MemoryEntry): string {
  const head = e.type === "failure" ? "FAILED APPROACH" : e.type.toUpperCase();
  const lines = [`${head} [${e.id}]: ${e.text}`];
  if (e.attempt) lines.push(`  attempt: ${e.attempt}`);
  if (e.result) lines.push(`  result: ${e.result}`);
  if (e.reason) lines.push(`  reason: ${e.reason}`);
  if (e.files?.length) lines.push(`  files: ${e.files.join(", ")}`);
  return lines.join("\n");
}
