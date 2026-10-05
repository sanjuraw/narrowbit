import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { MemoryPaths } from "./paths.js";
import { redact } from "./redact.js";
import { assertPlain, isLink } from "./safefs.js";
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
  /** "path:hash" for each file in `files` as it was when the note was saved — lets a later reader tell the note may be out of date. */
  fileHashes?: string[];
  tags?: string[];
  source?: string;
  date: string;
  confidence?: "low" | "medium" | "high";
  status: "active" | "superseded" | "resolved";
  supersededBy?: string;
  /** Where the note lives on disk (not serialised). */
  file?: string;
  /** Read-only notes from an external folder (e.g. an Obsidian vault). */
  external?: boolean;
}

// ---------- Markdown + frontmatter (Obsidian-compatible) ----------

const FM_KEYS = ["id", "type", "status", "date", "confidence", "files", "fileHashes", "tags", "source", "supersededBy"] as const;
const SECTIONS: [keyof MemoryEntry, string][] = [
  ["reason", "Reason"],
  ["attempt", "Attempt"],
  ["result", "Result"],
];

/** YAML subset writer: scalars as JSON strings (valid YAML), lists as block sequences. */
function yamlValue(v: unknown): string {
  if (Array.isArray(v)) return v.length ? "\n" + v.map((x) => `  - ${JSON.stringify(String(x))}`).join("\n") : " []";
  return " " + JSON.stringify(String(v));
}

export function toMarkdown(e: MemoryEntry): string {
  const fm = FM_KEYS.filter((k) => e[k] !== undefined && e[k] !== "").map((k) => `${k}:${yamlValue(e[k])}`);
  const body = [e.text.trim()];
  for (const [key, title] of SECTIONS) if (e[key]) body.push(`## ${title}\n${String(e[key]).trim()}`);
  return `---\n${fm.join("\n")}\n---\n\n${body.join("\n\n")}\n`;
}

function parseScalar(s: string): string {
  s = s.trim();
  if (!s) return "";
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Parse a note written by us *or by hand* (Obsidian-style frontmatter subset). */
export function fromMarkdown(md: string, fallback: { id: string; type?: MemoryType; date?: string }): MemoryEntry | null {
  const fm: Record<string, unknown> = {};
  let body = md;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (m) {
    body = md.slice(m[0].length);
    let listKey: string | null = null;
    for (const line of m[1].split(/\r?\n/)) {
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item && listKey) {
        (fm[listKey] as string[]).push(parseScalar(item[1]));
        continue;
      }
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      listKey = null;
      const [, k, v] = kv;
      if (!v.trim()) {
        fm[k] = [];
        listKey = k;
      } else if (v.trim().startsWith("[")) {
        fm[k] = v
          .trim()
          .slice(1, -1)
          .split(",")
          .map(parseScalar)
          .filter(Boolean);
      } else fm[k] = parseScalar(v);
    }
  }
  // Body: leading text until the first "## " heading; known headings map to fields.
  const parts = body.split(/^##\s+/m);
  const text = parts[0].replace(/^#\s+.*\n/, "").trim();
  const e: MemoryEntry = {
    id: String(fm.id ?? fallback.id),
    type: (MEMORY_TYPES.includes(fm.type as MemoryType) ? fm.type : fallback.type ?? "fact") as MemoryType,
    text,
    date: String(fm.date ?? fallback.date ?? now()),
    status: (["active", "superseded", "resolved"].includes(String(fm.status)) ? fm.status : "active") as MemoryEntry["status"],
  };
  for (const k of ["source", "supersededBy", "confidence"] as const) if (fm[k]) (e as any)[k] = String(fm[k]);
  for (const k of ["files", "fileHashes", "tags"] as const) if (Array.isArray(fm[k]) && (fm[k] as string[]).length) e[k] = fm[k] as string[];
  for (const p of parts.slice(1)) {
    const [title, ...rest] = p.split("\n");
    const sec = SECTIONS.find(([, t]) => t.toLowerCase() === title.trim().toLowerCase());
    if (sec) (e as any)[sec[0]] = rest.join("\n").trim();
  }
  if (!e.text && !e.reason && !e.attempt) return null;
  if (!e.text) e.text = (e.attempt ?? e.reason ?? "").split("\n")[0];
  return e;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "note"
  );
}

/**
 * Durable project knowledge as Markdown notes with frontmatter, one note per entry,
 * one folder per type: `.narrowbit/memory/decisions/raw-body-for-webhook-signatures.md`.
 * The folder opens directly as an Obsidian vault; hand-written notes are picked up too.
 * Extra read-only folders (e.g. project notes in an existing vault) come from config `memoryDirs`.
 */
export class Memory {
  /**
   * False when the notes folder (or `.narrowbit/` around it) is a symlink. A cloned repository can ship either one, aimed
   * at a folder of the user's own: reading through it would show the model files the repo was never given, and writing
   * would put notes (or, via an old-format file, anything) there. Such a store is treated as absent and refuses writes.
   */
  private readonly regular: boolean;

  constructor(
    private p: MemoryPaths,
    private extraDirs: string[] = [],
  ) {
    const isLink = (f: string) => { try { return lstatSync(f).isSymbolicLink(); } catch { return false; } };
    this.regular = !isLink(p.memory) && !isLink(dirname(p.memory));
    if (this.regular && existsSync(p.memory)) {
      // Visible structure for humans browsing the vault; hand-written notes get their type from the folder.
      for (const t of MEMORY_TYPES) mkdirSync(this.dir(t), { recursive: true, mode: 0o700 });
      this.migrateJson();
    }
  }

  private dir(type: MemoryType) {
    return join(this.p.memory, `${type}s`);
  }

  /** One-time migration from the V0 JSON format. */
  private migrateJson() {
    if (!existsSync(this.p.memory)) return;
    for (const t of MEMORY_TYPES) {
      const f = join(this.p.memory, `${t}s.json`);
      // A shipped `facts.json -> ~/private.json` must not be read as notes: only a plain file counts.
      if (isLink(f) || !existsSync(f)) continue;
      try {
        const list = JSON.parse(readFileSync(f, "utf8")) as MemoryEntry[];
        for (const e of list) {
          // The file is data from the repository: it decides neither where a note is written (`file`) nor which folder
          // (`type`), only the note's own text. Entries that aren't shaped like notes are skipped.
          if (!e || typeof e !== "object" || !MEMORY_TYPES.includes(e.type) || typeof e.text !== "string" || typeof e.id !== "string") continue;
          const { file: _f, external: _x, ...clean } = e;
          this.write({ ...clean, id: /^[\w.-]{1,80}$/.test(clean.id) ? clean.id : `${e.type.slice(0, 3)}-${shortId()}` });
        }
        renameSync(f, f + ".migrated");
      } catch {
        /* leave the file for manual inspection */
      }
    }
  }

  private write(e: MemoryEntry): string {
    if (!this.regular) throw new Error("the notes folder is a symlink (or sits inside one) — refusing to write through it");
    if (!MEMORY_TYPES.includes(e.type)) throw new Error(`unknown memory type: ${e.type}`);
    const dir = this.dir(e.type);
    assertPlain(dir); // a shipped `memory/facts -> <elsewhere>` must not become the place notes are written
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { file: _f, external: _x, ...data } = e;
    const md = toMarkdown(data as MemoryEntry);
    // A note is only ever rewritten in place if it is a regular file inside the notes folder.
    if (e.file && resolve(e.file).startsWith(resolve(this.p.memory) + sep) && !isLink(e.file)) {
      writeFileSync(e.file, md, { mode: 0o600 });
      return e.file;
    }
    // A new note gets the first free name, created exclusively: a link someone placed on a predictable name makes
    // that attempt fail (EEXIST, even for a dangling link) instead of being written through.
    const base = slug(e.text);
    const names = [`${base}.md`, `${base}-${e.id.split("-").pop()}.md`, ...Array.from({ length: 40 }, (_, i) => `${base}-${i + 2}.md`)];
    for (const name of names) {
      const file = join(dir, name);
      try {
        writeFileSync(file, md, { mode: 0o600, flag: "wx" });
        return file;
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
      }
    }
    throw new Error("couldn't find a free file name for the note");
  }

  private readDir(dir: string, type: MemoryType | undefined, external: boolean, out: MemoryEntry[], depth = 0) {
    if (!existsSync(dir) || depth > 4) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      // The project's own notes are never read through a link (see `regular`). A folder the user listed as extra notes
      // is theirs, so a vault that uses links keeps working.
      if (!external && ent.isSymbolicLink()) continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        const t = MEMORY_TYPES.find((x) => ent.name === `${x}s` || ent.name === x);
        this.readDir(abs, t ?? type, external, out, depth + 1);
      } else if (ent.name.endsWith(".md")) {
        try {
          const e = fromMarkdown(readFileSync(abs, "utf8"), { id: basename(ent.name, ".md"), type });
          if (e) out.push({ ...e, file: abs, external });
        } catch {
          /* unreadable note: skip */
        }
      }
    }
  }

  load(type?: MemoryType): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    if (this.regular) this.readDir(this.p.memory, undefined, false, out);
    for (const d of this.extraDirs) this.readDir(d, undefined, true, out);
    return type ? out.filter((e) => e.type === type) : out;
  }

  add(e: Omit<MemoryEntry, "id" | "date" | "status"> & Partial<Pick<MemoryEntry, "status">>): MemoryEntry {
    if (!MEMORY_TYPES.includes(e.type)) throw new Error(`unknown memory type: ${e.type} (expected ${MEMORY_TYPES.join(", ")})`);
    // Notes are plain Markdown that outlives the task (and may be synced or shared), so a secret must never reach them:
    // scrubbed here, at the one place every note passes through (idea from Hindsight's "memory defense").
    // Token-shaped secrets go through redact(); notes are prose, so also "password is X" / "api_key=X" style assignments.
    const scrub = (x: string) => redact(x).replace(/\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b(\s*(?:is|=|:)\s*)(['"]?)([^\s'",;]{6,})\3/gi, "$1$2$3[REDACTED]$3");
    const clean = (x?: string) => (typeof x === "string" ? scrub(x) : x);
    const entry: MemoryEntry = { id: `${e.type.slice(0, 3)}-${shortId()}`, date: now(), status: "active", ...e, text: scrub(e.text), reason: clean(e.reason), attempt: clean(e.attempt), result: clean(e.result) };
    if (entry.files?.length && !entry.fileHashes) entry.fileHashes = this.hashFiles(entry.files);
    entry.file = this.write(entry);
    return entry;
  }

  /** "path:hash" for each readable in-project file (a short content hash). Files that don't exist yet are left out. */
  private hashFiles(files: string[]): string[] {
    const out: string[] = [];
    for (const f of files.slice(0, 12)) {
      const h = fileHash(this.p.root, f);
      if (h) out.push(`${f}:${h}`);
    }
    return out;
  }

  /**
   * Files this note was about that have changed (or gone) since it was saved: the note may no longer be true. A note
   * saved without hashes (older, hand-written, or about no files) is never judged — nothing is claimed it can't back.
   */
  staleFilesOf(e: MemoryEntry): string[] {
    if (e.external || !e.fileHashes?.length) return [];
    const stale: string[] = [];
    for (const entry of e.fileHashes) {
      const i = entry.lastIndexOf(":");
      const path = entry.slice(0, i), saved = entry.slice(i + 1);
      if (fileHash(this.p.root, path) !== saved) stale.push(path);
    }
    return stale;
  }

  setStatus(id: string, status: MemoryEntry["status"], supersededBy?: string): MemoryEntry | null {
    const e = this.load().find((x) => x.id === id && !x.external);
    if (!e) return null;
    e.status = status;
    if (supersededBy) e.supersededBy = supersededBy;
    this.write(e);
    return e;
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
      if (e.external) score *= 0.8; // curated-for-humans notes are less targeted
      if (score >= 1.5) scored.push({ entry: e, score, why: whys.join("; ") });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

export function openMemory(p: MemoryPaths): Memory {
  return new Memory(p, p.extraDirs ?? []);
}

/** A short content hash of a file inside the project, or null if it isn't a readable file there. */
function fileHash(root: string, rel: string): string | null {
  try {
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) return null;
    if (!lstatSync(abs).isFile()) return null;
    return createHash("sha1").update(readFileSync(abs)).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

/** `stale`: files the note was about that have changed since it was saved (see Memory.staleFilesOf). */
export function renderMemory(e: MemoryEntry, stale: string[] = []): string {
  const head = e.type === "failure" ? "FAILED APPROACH" : e.type.toUpperCase();
  const lines = [`${head} [${e.id}]: ${e.text.split("\n").slice(0, 3).join(" ").slice(0, 400)}`];
  if (stale.length) lines.push(`  ⚠ may be out of date: ${stale.slice(0, 4).join(", ")} changed since this was saved — check the code before relying on it`);
  if (e.attempt) lines.push(`  attempt: ${e.attempt}`);
  if (e.result) lines.push(`  result: ${e.result}`);
  if (e.reason) lines.push(`  reason: ${e.reason}`);
  if (e.files?.length) lines.push(`  files: ${e.files.join(", ")}`);
  return lines.join("\n");
}
