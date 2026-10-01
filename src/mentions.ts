import { existsSync, readFileSync } from "node:fs";
import type { Paths } from "./config.js";
import { listFiles } from "./files.js";
import { redact } from "./redact.js";
import { capSummary, safeAbsPath } from "./runtime.js";

/**
 * "@path" file mentions in a task's text, the same shorthand Claude Code uses: instead of the model
 * spending a `read`/`grep`/`search` turn to find a file the user already knows the name of, the
 * mentioned file's content goes straight into the task's first prompt. Cheaper (skips exploration
 * turns entirely for the mentioned file) and more reliable (no chance of grepping for the wrong file).
 */
// Plain form: @src/café.ts (letters and digits in any language). A path with spaces or other odd characters is
// written @"my file.ts" — the app's autocomplete does that for you.
const MENTION_RE = /(^|[\s(])@(?:"([^"\n]+)"|([\p{L}\p{N}_./-]+))/gu;
const PLAIN_PATH = /^[\p{L}\p{N}_./-]+$/u;

/** How to write `path` as a mention so parseMentions reads it back whole. */
export function mentionText(path: string): string {
  return PLAIN_PATH.test(path) ? `@${path}` : `@"${path.replace(/"/g, "")}"`;
}

/** Every "@token" in `text`, in order, deduplicated. Doesn't validate against the repo — see `resolveMentions`. */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const token = m[2] ?? m[3];
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

export interface ResolvedMention {
  token: string;
  path: string | null; // repo-relative path if resolved, else null
  content: string | null; // capped file content if readable, else null
}

/**
 * Resolves each mention against the repo's tracked files: an exact path match wins; otherwise the
 * shortest tracked path whose basename matches (so "@runtime.ts" finds "src/runtime.ts") — the same
 * lenient-but-not-ambiguous rule a person typing a partial path would expect. Unresolved or unreadable
 * mentions are reported, not silently dropped, so the model (and the user) can see what didn't match.
 */
export function resolveMentions(p: Paths, tokens: string[]): ResolvedMention[] {
  if (!tokens.length) return [];
  const files = listFiles(p);
  const byBasename = new Map<string, string[]>();
  for (const f of files) {
    const base = f.split("/").pop()!;
    (byBasename.get(base) ?? byBasename.set(base, []).get(base)!).push(f);
  }
  return tokens.map((token) => {
    let match: string | null = null;
    // macOS file names are often decomposed Unicode (é as e + accent); compare in one normal form.
    const norm = (x: string) => x.normalize("NFC");
    const exact = files.find((f) => norm(f) === norm(token));
    if (exact) match = exact;
    else {
      const base = token.split("/").pop()!;
      const candidates = [...byBasename.entries()].filter(([b]) => norm(b) === norm(base)).flatMap(([, v]) => v);
      if (candidates?.length === 1) match = candidates[0]!;
      else if (candidates?.length) match = candidates.sort((a, b) => a.length - b.length)[0]!;
    }
    if (!match) return { token, path: null, content: null };
    const abs = safeAbsPath(p, match);
    if (!abs || !existsSync(abs)) return { token, path: match, content: null };
    try {
      const raw = readFileSync(abs);
      if (raw.subarray(0, 4096).includes(0)) return { token, path: match, content: null }; // binary
      return { token, path: match, content: capSummary(redact(raw.toString("utf8")), 1500) };
    } catch {
      return { token, path: match, content: null };
    }
  });
}

/** Renders resolved mentions as a block to prepend to the task's first prompt; empty string if there were none. */
export function renderMentions(resolved: ResolvedMention[]): string {
  if (!resolved.length) return "";
  const parts = resolved.map((r) => {
    if (r.content !== null) return `File ${r.path} (mentioned with ${mentionText(r.token)}):\n${r.content}`;
    if (r.path) return `${mentionText(r.token)} matched ${r.path}, but it couldn't be read (binary or missing).`;
    return `${mentionText(r.token)} didn't match any file in this repository — say so rather than guessing what it refers to.`;
  });
  return `The user's message mentions specific files:\n\n${parts.join("\n\n")}\n\n`;
}

/** Up to `limit` repo file paths whose path contains `query` (case-insensitive), shortest first — for the app's @ autocomplete. */
export function suggestFiles(p: Paths, query: string, limit = 20): string[] {
  const q = query.toLowerCase();
  const files = listFiles(p);
  const matches = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
  return matches.sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
}
