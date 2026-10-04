export { now, shortId, estimateTokens } from "narrowbit-memory";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function sha1(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}


/** Anything inside a `.git` directory at any depth, in any letter case (macOS treats `.GIT/config` as `.git/config`).
 * Git executes settings from there on its next call, so the agent may neither read nor edit it. */
export function isGitInternal(relPath: string): boolean {
  return relPath.split(/[\\/]+/).some((seg) => seg.toLowerCase() === ".git");
}

/** Narrowbit's own state in a project: `.narrowbit/` (config, routing, logs) and `.narrowbitignore`. */
export function isNarrowbitOwn(relPath: string): boolean {
  return /^\.narrowbit(ignore$|$|[\\/])/i.test(relPath.replace(/^(\.[\\/])+/, ""));
}

/**
 * Where `abs` really lands, relative to the project's real root — or null if that is outside it. Judged on the real
 * path of the deepest part that exists, so a symlinked *directory* anywhere along the way (not just a symlinked
 * leaf) can't carry a path out of the project, and so a symlink alias of a protected file shows up as that file.
 */
export function realRel(root: string, abs: string): string | null {
  try {
    let probe = abs;
    while (!existsSyncOrLink(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
    const real = join(realpathSync(probe), relative(probe, abs));
    const rel = relative(realpathSync(root), real);
    return rel.startsWith("..") || isAbsolute(rel) ? null : rel;
  } catch {
    return null;
  }
}
function existsSyncOrLink(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return existsSync(p);
  }
}

/**
 * Arguments for every git command Narrowbit runs itself. Besides `safe.directory` (see sh() below), this switches off
 * the settings git would otherwise *execute* from a repository's own config on an ordinary, non-interactive call:
 * `core.fsmonitor` (runs on status/diff/add — i.e. constantly, with nobody doing anything) and, for diffs, external
 * diff programs and textconv filters. A hostile `.git/config` (a folder unpacked from an archive, say) can't run code
 * through Narrowbit's own git calls this way. Clean/smudge filters can't be switched off without breaking real tools
 * (git-lfs, git-crypt), so those are handled by asking before opening a repo that defines them (trust.ts).
 */
export function gitArgs(root: string, args: string[]): string[] {
  const rest = args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
  return ["-c", `safe.directory=${root}`, "-c", "core.fsmonitor=false", ...rest];
}

export function sh(cmd: string, args: string[], cwd: string, input?: string): { code: number; stdout: string; stderr: string } {
  // Git refuses to touch a repository it doesn't own (a real safety feature — protects against another
  // user planting a malicious repo you'd cd into) — but on a shared Mac, or a project folder that existed
  // before Narrowbit ever touched it, "doesn't own" often just means a different macOS account created the
  // folder. Without this, every git call fails silently from Narrowbit's own perspective: gitState() and
  // remoteInfo() see a plain error, not a special case, and simply report "not a repo" / "no remote" — no
  // banner, no clue anything is wrong, the whole git-aware half of the UI just vanishes. Narrowbit is only
  // ever asked to operate on a folder the user explicitly pointed it at, so it's reasonable to trust that
  // one folder for its own commands, scoped to this single invocation — not a persistent config change.
  const realArgs = cmd === "git" ? gitArgs(cwd, args) : args;
  const r = spawnSync(cmd, realArgs, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, input });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r(?!\n)/g, "");
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Files the repository's own git config pulls in (`[include] path = …`, `[includeIf …]`, and anything those include).
 * They are config: a filter or other program named there is run by git exactly as if it were in .git/config, so the
 * agent may not edit them either. A path that doesn't exist yet still counts — git ignores a missing include, and
 * creating the file would switch it on.
 */
export function gitConfigIncludeFiles(root: string): string[] {
  const out = new Set<string>();
  const gd = sh("git", ["rev-parse", "--absolute-git-dir"], root);
  if (gd.code !== 0) return [];
  const gitDir = gd.stdout.trim();
  const direct = sh("git", ["config", "--local", "--get-regexp", "^include(if\\..*)?\\.path$"], root);
  for (const line of direct.stdout.split("\n")) {
    const value = line.replace(/^\S+\s+/, "").trim();
    if (!value) continue;
    out.add(value.startsWith("~/") ? join(homedir(), value.slice(2)) : isAbsolute(value) ? value : join(gitDir, value));
  }
  // Includes of includes (each exists, or it wouldn't have been read).
  const all = sh("git", ["config", "--local", "--includes", "--list", "--show-origin"], root);
  for (const line of all.stdout.split("\n")) {
    const m = /^file:(\S.*?)\t/.exec(line);
    if (m && resolve(m[1]!) !== resolve(gitDir, "config")) out.add(resolve(m[1]!));
  }
  return [...out].map((f) => resolve(f));
}

/** True if `abs` (an absolute path, or its real path) is one of the repo's git-config include files. */
export function isGitConfigInclude(root: string, abs: string, realAbs?: string | null): boolean {
  const targets = gitConfigIncludeFiles(root);
  if (!targets.length) return false;
  const real = (f: string) => {
    try {
      return realpathSync(f);
    } catch {
      return f;
    }
  };
  const mine = new Set([resolve(abs), real(abs), ...(realAbs ? [resolve(realAbs)] : [])]);
  return targets.some((t) => mine.has(t) || mine.has(real(t)));
}

/** Shows control characters and text-direction overrides as visible escapes, so a command can't use them to look like
 * something else in a terminal prompt (a carriage return plus an erase sequence can overwrite what the user is reading).
 * Tabs and newlines stay as they are. */
export function visible(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (c) => {
    const n = c.charCodeAt(0);
    return n === 13 ? "\\r" : n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u${n.toString(16)}`;
  });
}

/**
 * A page that sends the browser to `url`, in a folder only this user can read. The app's address carries its access token;
 * handing that to `open` as an argument would show it on the command line, where other accounts on this Mac can read it
 * (`ps`). The path of this file is all that is passed instead. It removes itself shortly after.
 */
export function launcherPage(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "narrowbit-open-"));
  chmodSync(dir, 0o700);
  const file = join(dir, "open.html");
  const esc = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${esc}"><title>Narrowbit</title><a href="${esc}">Open Narrowbit</a>\n`, { mode: 0o600 });
  setTimeout(() => rmSync(dir, { recursive: true, force: true }), 30_000).unref();
  return file;
}
