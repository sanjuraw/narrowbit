import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "../config.js";
import { taskDir } from "./events.js";
import { redact } from "../redact.js";
import { estimateTokens, shortId } from "../util.js";

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

function evidenceDir(p: Paths, taskId: string): string {
  return join(taskDir(p, taskId), "evidence");
}

export function writeEvidence(p: Paths, taskId: string, kind: EvidenceKind, content: string, summary: string, path?: string): EvidenceHandle {
  const dir = evidenceDir(p, taskId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = shortId();
  const clean = redact(content);
  writeFileSync(join(dir, id), clean, { mode: 0o600 });
  return { id, kind, path, summary, tokens: estimateTokens(clean) };
}

export function readEvidence(p: Paths, taskId: string, id: string): string {
  const f = join(evidenceDir(p, taskId), id);
  if (!existsSync(f)) throw new Error(`no evidence ${id} for task ${taskId}`);
  return readFileSync(f, "utf8");
}
