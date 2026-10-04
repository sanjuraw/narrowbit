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
  /** Ships with Narrowbit and appears in every project; save a skill with the same name to override it. */
  builtin?: boolean;
}

/** The checks worth doing before anything ships, as one skill every project gets. `narrowbit audit` is
 * the deterministic floor (no model); this asks the agent for the judgement-based rest. */
const SECURITY_SKILLS: Skill[] = [
  {
    name: "Security review",
    description: "Check this project for leaked secrets, unsafe data handling, missing access checks and production gaps",
    builtin: true,
    body: `Review this project's security before it ships. Read the code; change nothing until the end, then fix only what is clearly wrong and say exactly what you changed.

1. Secrets. Search the whole tree for hardcoded keys, tokens, passwords, connection strings and private keys. Anything sensitive must come from environment variables; .env files must be git-ignored, with a placeholder .env.example committed instead. No secret may use a browser-exposed prefix (NEXT_PUBLIC_, REACT_APP_, VITE_). Run \`narrowbit audit\` with the run action and include what it reports. Remind me to rotate anything that was ever committed.
2. Personal data. Trace where user data (emails, phones, addresses, ids, payment details) enters, where it is stored and where it is sent: logs, analytics, error trackers, third-party APIs. Nothing personal in logs. Passwords hashed with bcrypt, argon2 or scrypt. Cookies httpOnly, secure and sameSite. No personal data in localStorage.
3. Access control. Every endpoint that returns or changes data must check who is asking and that they own that record: never trust a user, order or document id sent by the client. Roles are enforced on the server, not by hiding buttons.
4. Input handling. Parameterised queries only. Anything rendered as HTML is escaped or sanitised. Uploads are validated for type and size and not served from an executable location. No shell command or file path is built from user input without validation.
5. Money and trust. Prices, totals and permissions are computed on the server. Webhook signatures are verified. Payment state is confirmed server-side before granting access.
6. Production hygiene. No debug endpoints, leftover test credentials or commented-out auth. Errors shown to users are generic, with no stack traces or file paths. Security headers are set, CORS is not a wildcard on private APIs, login, signup and password reset are rate limited, and the database connection uses TLS.
7. Dependencies. Note outdated or unmaintained packages, and run the package manager's audit command if there is one.

Finish with a report: each numbered check as passed, failed or not applicable; for each failure the file and line, how an attacker would exploit it, and the fix (applied or proposed). Do not call something safe that you did not read. If this project handles real money or sensitive data at scale, say plainly that this review does not replace a human security review.`,
  },
];

import { BUILTIN_SKILLS as GENERAL_SKILLS } from "./builtin-skills.js";

export const BUILTIN_SKILLS: Skill[] = [...GENERAL_SKILLS, ...SECURITY_SKILLS];

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
  // A project's own skill can replace a built-in of the same name (that is how you customise one), but a repository you
  // opened can ship such a skill too, so the listing says so wherever the description is shown.
  const builtinNames = new Set(BUILTIN_SKILLS.map((b) => b.name));
  const mine = listUserSkills(p).map((s) => (builtinNames.has(s.name) ? { ...s, description: `Replaces the built-in "${s.name}" with this project's own version. ${s.description}`.trim() } : s));
  const overridden = new Set(mine.map((s) => s.name));
  return [...BUILTIN_SKILLS.filter((b) => !overridden.has(b.name)), ...mine].sort((a, b) => a.name.localeCompare(b.name));
}

function listUserSkills(p: Paths): Skill[] {
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
  const all = listSkills(p);
  return all.find((s) => s.name === name || s.file === `${slugify(name)}.md`) ?? all.find((s) => s.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

/** Creates or overwrites a skill by name (case-sensitive match on the existing name, if any). */
export function saveSkill(p: Paths, name: string, description: string, body: string): Skill {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("a skill needs a name");
  const trimmedBody = body.trim();
  if (!trimmedBody) throw new Error("a skill needs instructions");
  // The listing prefixes a skill that replaces a built-in; an editor that saves the listed text back must not store it.
  description = description.replace(/^Replaces the built-in "[^"]*" with this project's own version\. ?/, "");
  const existing = listUserSkills(p).find((s) => s.name === trimmedName);
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
  if (s.builtin) throw new Error(`"${oldName}" is built in and can't be renamed`);
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("a skill needs a name");
  const newFile = `${slugify(trimmed)}.md`;
  if (s.file && s.file !== newFile && existsSync(join(p.skills, s.file))) renameSync(join(p.skills, s.file), join(p.skills, newFile));
  return saveSkill(p, trimmed, s.description, s.body);
}
