import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Notes, events and evidence live under `.narrowbit/`, which a cloned repository can ship — including symlinks aimed at
 * folders and files of the user's own. Nothing here is ever read or written *through* a link: an existing link in the
 * path is refused, and new files are created exclusively (so a link squatting on the name fails instead of being followed).
 */
export const TASK_ID = /^[\w-]{1,80}$/;

export function isLink(f: string): boolean {
  try {
    return lstatSync(f).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Throws if any of these paths is a symlink (a path that doesn't exist yet is fine). */
export function assertPlain(...paths: string[]): void {
  for (const f of paths) if (isLink(f)) throw new Error(`${f} is a symlink — refusing to read or write through it`);
}

/** The first symlink on the way from `root` (not itself checked: the user chose it) down to `target`, or null. */
export function linkInPath(root: string, target: string): string | null {
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  let at = root;
  for (const part of rel.split(sep)) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) return at;
    } catch {
      return null; // nothing there (yet): no link to follow from here on
    }
  }
  return null;
}

/**
 * Opens a file that must be one plain file with one name: never through a symlink (O_NOFOLLOW), and never a file with a
 * second hard link (the other name can be anywhere on the disk). The link count is read from the open descriptor, so a
 * link made between a check and the open is still caught. Returns the descriptor; the caller closes it.
 */
export function openPlain(file: string, flags: number, mode = 0o600): number {
  const fd = openSync(file, flags | constants.O_NOFOLLOW, mode);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if (st.nlink > 1) throw new Error(`${file} has a second hard link — refusing to read or write through it`);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/** Replaces a file's contents (or creates it). Truncation happens only after the file is known to be plain. */
export function writePlain(file: string, data: string | Uint8Array, mode = 0o600): void {
  const fd = openPlain(file, constants.O_WRONLY | constants.O_CREAT, mode);
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, data as any);
  } finally {
    closeSync(fd);
  }
}

/** Reads a file that must be plain (see openPlain). Throws ENOENT when it isn't there. */
export function readPlain(file: string): string {
  const fd = openPlain(file, constants.O_RDONLY);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Appends to a file without following a link on the file itself, and never to one with a second hard link. */
export function appendNoFollow(file: string, text: string): void {
  const fd = openPlain(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
