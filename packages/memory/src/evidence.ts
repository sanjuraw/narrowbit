import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertPlain, TASK_ID } from "./safefs.js";
import type { MemoryPaths } from "./paths.js";
import { taskDir } from "./events.js";
import { redact } from "./redact.js";
import { estimateTokens, shortId } from "./util.js";

/**
 * Generalizes compress.ts's existing "full output on disk, summary re-enters context" pattern
 * (runCommand's rawLog + compressed text) to file reads and diffs, so nothing raw has to enter
 * every model turn — only a handle + a one-line summary does, per CLAUDE.md's active-context design.
 */
export type EvidenceKind = "file" | "diff" | "command" | "other";

export interface EvidenceHandle {
  id: string;
  kind: EvidenceKind;
  /** Repo-relative path this evidence is about, if any. */
  path?: string;
  summary: string;
  tokens: number;
}

function evidenceDir(p: MemoryPaths, taskId: string): string {
  return join(taskDir(p, taskId), "evidence");
}

export function writeEvidence(p: MemoryPaths, taskId: string, kind: EvidenceKind, content: string, summary: string, path?: string): EvidenceHandle {
  const dir = evidenceDir(p, taskId);
  assertPlain(dirname(p.runtime), p.runtime, taskDir(p, taskId), dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPlain(dirname(p.runtime), p.runtime, taskDir(p, taskId), dir);
  const id = shortId();
  const clean = redact(content);
  writeFileSync(join(dir, id), clean, { mode: 0o600, flag: "wx" });
  return { id, kind, path, summary, tokens: estimateTokens(clean) };
}

export function readEvidence(p: MemoryPaths, taskId: string, id: string): string {
  if (!TASK_ID.test(id)) throw new Error(`invalid evidence id`);
  const f = join(evidenceDir(p, taskId), id);
  assertPlain(dirname(p.runtime), p.runtime, taskDir(p, taskId), evidenceDir(p, taskId), f);
  if (!existsSync(f)) throw new Error(`no evidence ${id} for task ${taskId}`);
  return readFileSync(f, "utf8");
}
