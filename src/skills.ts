import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./config.js";

/**
 * Skills: user-authored, reusable task templates, saved once and reused across sessions instead of
 * retyping the same instructions. Deliberately not auto-injected into every task — like memory.ts's
 * "store automatically, inject only on demonstrated relevance" (CLAUDE.md), a skill is applied by an
 * explicit user action (picking it in the app, or `narrowbit agent --skill <name> "..."`), never
 * silently prepended, so it can't become a fixed per-task token tax the way predictive injection was.
 * Stored one Markdown file per skill in `.narrowbit/skills/`, hand-editable like memory.ts's notes.
 */
export interface Skill {
  name: string;
  description: string;
  body: string;
  /** Filename on disk (not serialised into the file itself). */
  file?: string;
}

export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "skill";
}

function parse(raw: string, file: string): Skill | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  let name = "";
  let description = "";
  let body = raw;
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^(\w+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const v = kv[2].trim().replace(/^"(.*)"$/, "$1");
      if (kv[1] === "name") name = v;
      else if (kv[1] === "description") description = v;
    }
  }
  body = body.trim();
  if (!body) return null;
  return { name: name || file.replace(/\.md$/, ""), description, body, file };
}

export function listSkills(p: Paths): Skill[] {
  if (!existsSync(p.skills)) return [];
  return readdirSync(p.skills)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      try {
        return parse(readFileSync(join(p.skills, f), "utf8"), f);
      } catch {
        return null;
      }
    })
    .filter((s): s is Skill => !!s)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(p: Paths, name: string): Skill | null {
  return listSkills(p).find((s) => s.name === name || s.file === `${slugify(name)}.md`) ?? null;
}

/** Creates or overwrites a skill by name (case-sensitive match on the existing name, if any). */
export function saveSkill(p: Paths, name: string, description: string, body: string): Skill {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("a skill needs a name");
  const trimmedBody = body.trim();
  if (!trimmedBody) throw new Error("a skill needs instructions");
  const existing = listSkills(p).find((s) => s.name === trimmedName);
  const file = existing?.file ?? `${slugify(trimmedName)}.md`;
  const fm = [`name: ${JSON.stringify(trimmedName)}`, description.trim() ? `description: ${JSON.stringify(description.trim())}` : null].filter(Boolean).join("\n");
  writeFileSync(join(p.skills, file), `---\n${fm}\n---\n\n${trimmedBody}\n`, "utf8");
  return { name: trimmedName, description: description.trim(), body: trimmedBody, file };
}

export function removeSkill(p: Paths, name: string): boolean {
  const s = getSkill(p, name);
  if (!s?.file) return false;
  unlinkSync(join(p.skills, s.file));
  return true;
}

/** Renaming changes the file's slug too, so it doesn't collide with a later same-named skill. */
export function renameSkill(p: Paths, oldName: string, newName: string): Skill {
  const s = getSkill(p, oldName);
  if (!s) throw new Error(`no skill named "${oldName}"`);
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("a skill needs a name");
  const newFile = `${slugify(trimmed)}.md`;
  if (s.file && s.file !== newFile && existsSync(join(p.skills, s.file))) renameSync(join(p.skills, s.file), join(p.skills, newFile));
  return saveSkill(p, trimmed, s.description, s.body);
}
