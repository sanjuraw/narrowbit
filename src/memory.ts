// The memory system lives in the narrowbit-memory package (packages/memory); this path stays so existing imports keep working.
import { digestWithMemory as digest, openMemory as open, proposeNotes as propose, recordTaskNote as record, type Memory } from "narrowbit-memory";
import { loadConfig, type Paths } from "./config.js";
import { isAbsolute, resolve } from "node:path";

export * from "narrowbit-memory";

/** Narrowbit's settings can name extra read-only folders of notes (e.g. an Obsidian vault); the package takes them as paths. */
export function memoryPathsOf(p: Paths) {
  const extraDirs = (loadConfig(p).memoryDirs ?? []).map((d) => (isAbsolute(d) ? d : resolve(p.root, d.replace(/^~(?=\/)/, process.env.HOME ?? "~"))));
  return { root: p.root, memory: p.memory, runtime: p.runtime, extraDirs };
}

export function openMemory(p: Paths): Memory {
  return open(memoryPathsOf(p));
}
export function digestWithMemory(p: Paths, taskId: string, budget: number): string {
  return digest(memoryPathsOf(p), taskId, budget);
}
export function recordTaskNote(p: Paths, taskId: string, fallbackGoal = "") {
  return record(memoryPathsOf(p), taskId, fallbackGoal);
}
export function proposeNotes(p: Paths, taskId: string) {
  return propose(memoryPathsOf(p), taskId);
}
