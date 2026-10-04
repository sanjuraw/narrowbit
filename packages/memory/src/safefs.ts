import { closeSync, constants, lstatSync, openSync, writeSync } from "node:fs";

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

/** Appends to a file without following a link on the file itself. */
export function appendNoFollow(file: string, text: string): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
