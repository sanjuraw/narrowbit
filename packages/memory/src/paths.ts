import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLink } from "./safefs.js";

/**
 * Where the memory system keeps things for one project. Narrowbit's own `Paths` has all of these fields, so it can be
 * passed straight in; another tool builds one with `memoryPaths(root)`.
 */
export interface MemoryPaths {
  /** The project folder. Notes about files are checked against files under here. */
  root: string;
  /** Notes: one Markdown file each, in subfolders per type — opens as an Obsidian vault. */
  memory: string;
  /** Per-task event logs and evidence (`<runtime>/<taskId>/events.jsonl`). */
  runtime: string;
  /** Extra read-only folders of Markdown notes (e.g. an existing vault), already resolved to absolute paths. */
  extraDirs?: string[];
}

/** The default layout, shared with Narrowbit: everything under `<root>/.narrowbit/`. */
export function memoryPaths(root: string): MemoryPaths {
  const nb = join(root, ".narrowbit");
  return { root, memory: join(nb, "memory"), runtime: join(nb, "runtime") };
}

/** Creates the folders and keeps them out of git (a `.gitignore` of `*` inside `.narrowbit/`), like `narrowbit init` does. */
export function ensureMemoryDirs(p: MemoryPaths): void {
  // A cloned repository can ship `.narrowbit -> <elsewhere>`: mkdir would follow it, so nothing is created through a link.
  if ([join(p.root, ".narrowbit"), dirname(p.memory), p.memory, dirname(p.runtime), p.runtime].some(isLink)) return;
  mkdirSync(p.memory, { recursive: true, mode: 0o700 });
  mkdirSync(p.runtime, { recursive: true, mode: 0o700 });
  const gi = join(p.root, ".narrowbit", ".gitignore");
  // "wx" fails on anything already there, a dangling symlink included, so this never creates a file through a link.
  try { writeFileSync(gi, "*\n", { flag: "wx" }); } catch { /* already present (or not ours to write) */ }
}
