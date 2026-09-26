import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
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
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** Stores an uploaded file; returns its absolute path. Throws on an unsupported type or a file that is too large. */
export function saveAttachment(root: string, name: string, data: Buffer): string {
  const safe = basename(name).replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "file";
  if (!attachmentKind(safe)) throw new Error("only images (png, jpg, gif, webp) and PDFs can be attached");
  if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`that file is ${(data.length / 1048576).toFixed(1)} MB; the limit is ${MAX_ATTACHMENT_BYTES / 1048576} MB`);
  const f = join(attachmentDir(root), `${randomUUID().slice(0, 8)}-${safe}`);
  writeFileSync(f, data, { mode: 0o600 });
  return f;
}

export function readAttachment(path: string): { name: string; kind: "image" | "pdf"; mime: string; base64: string } | null {
  const kind = attachmentKind(path);
  if (!kind || !existsSync(path) || statSync(path).size > MAX_ATTACHMENT_BYTES) return null;
  return { name: basename(path).replace(/^[0-9a-f]{8}-/, ""), kind, mime: kind === "pdf" ? "application/pdf" : imageMime(path), base64: readFileSync(path).toString("base64") };
}

/** Text of a PDF for providers that can't take one natively (pdftotext, if installed). Redacted like all emitted text. */
export function pdfText(path: string, maxChars = 24_000): string {
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
