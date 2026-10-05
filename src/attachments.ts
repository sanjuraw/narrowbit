import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { redact } from "./redact.js";

/**
 * Files a user attaches to a task (screenshots, PDFs). They are kept under .narrowbit/attachments and sent to the
 * model on its first call only: an image costs a lot of tokens, and the model's own notes carry what it saw into
 * later turns. Claude, Codex and the vision-capable API models get the pixels; a provider that can't see images is
 * told so instead of being sent something it would reject. PDFs go to Claude as documents and to everyone else as text.
 */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export function attachmentKind(path: string): "image" | "pdf" | null {
  const ext = extname(path).toLowerCase();
  if (IMAGE_MIME[ext]) return "image";
  return ext === ".pdf" ? "pdf" : null;
}

export function imageMime(path: string): string {
  return IMAGE_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function attachmentDir(root: string): string {
  const d = join(root, ".narrowbit", "attachments");
  // A cloned repository can ship `.narrowbit/attachments -> <elsewhere>`: uploads must not be written through it.
  for (const f of [join(root, ".narrowbit"), d]) {
    try { if (lstatSync(f).isSymbolicLink()) throw new Error(`${f} is a symlink — refusing to store attachments through it`); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
  }
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** Stores an uploaded file; returns its absolute path. Throws on an unsupported type or a file that is too large. */
export function saveAttachment(root: string, name: string, data: Buffer): string {
  const safe = basename(name).replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "file";
  if (!attachmentKind(safe)) throw new Error("only images (png, jpg, gif, webp) and PDFs can be attached");
  if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`that file is ${(data.length / 1048576).toFixed(1)} MB; the limit is ${MAX_ATTACHMENT_BYTES / 1048576} MB`);
  const f = join(attachmentDir(root), `${randomUUID().slice(0, 8)}-${safe}`);
  const fd = openSync(f, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, data); } finally { closeSync(fd); }
  return f;
}

/** A file under a project's `.narrowbit/attachments` is Narrowbit's own copy, so it must be a plain file: a link or a
 * hard link there (a cloned repository can ship one) would send some other file's bytes to the model. A file the user
 * attached by its own path from anywhere else is theirs to choose and is read as it is. */
function storedButNotPlain(path: string): boolean {
  if (basename(dirname(path)) !== "attachments" || basename(dirname(dirname(path))).toLowerCase() !== ".narrowbit") return false;
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() || !st.isFile() || st.nlink > 1 || lstatSync(dirname(path)).isSymbolicLink() || lstatSync(dirname(dirname(path))).isSymbolicLink();
  } catch {
    return true;
  }
}

export function readAttachment(path: string): { name: string; kind: "image" | "pdf"; mime: string; base64: string } | null {
  const kind = attachmentKind(path);
  if (!kind || storedButNotPlain(path) || !existsSync(path) || statSync(path).size > MAX_ATTACHMENT_BYTES) return null;
  return { name: basename(path).replace(/^[0-9a-f]{8}-/, ""), kind, mime: kind === "pdf" ? "application/pdf" : imageMime(path), base64: readFileSync(path).toString("base64") };
}

/** Text of a PDF for providers that can't take one natively (pdftotext, if installed). Redacted like all emitted text. */
export function pdfText(path: string, maxChars = 24_000): string {
  if (storedButNotPlain(path)) return "";
  try {
    const t = execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
    return redact(t.length > maxChars ? `${t.slice(0, maxChars)}\n[…PDF text cut at ${maxChars} characters]` : t);
  } catch {
    return "";
  }
}

/**
 * The prompt for a provider that takes images itself but not PDFs (or nothing at all): PDFs become text, and images
 * a provider can't see are named so the model says so instead of guessing.
 */
export function promptWithFiles(prompt: string, paths: string[] | undefined, opts: { images: boolean; pdfs: boolean }): string {
  if (!paths?.length) return prompt;
  const parts: string[] = [];
  for (const p of paths) {
    const kind = attachmentKind(p);
    const name = basename(p).replace(/^[0-9a-f]{8}-/, "");
    if (kind === "pdf" && !opts.pdfs) {
      const t = pdfText(p);
      parts.push(t ? `Attached PDF "${name}" (text):\n${t}` : `A PDF "${name}" was attached but its text could not be read here (install poppler for pdftotext); tell the user rather than guessing.`);
    } else if (kind === "image" && !opts.images) {
      parts.push(`An image "${name}" was attached, but this model cannot view images. Say so to the user instead of guessing what it shows.`);
    }
  }
  return parts.length ? `${prompt}\n\n${parts.join("\n\n")}` : prompt;
}
