export { now, shortId, estimateTokens } from "narrowbit-memory";
import { linkInPath, openPlain, readPlain } from "narrowbit-memory";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
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

/**
 * Why touching `target` could reach outside the project, or null. A project folder can come from someone else (a clone,
 * an unzipped download) with links already in place where Narrowbit keeps its state. Nothing between the project folder
 * and the target may be a symlink, the target itself may not be one (dangling included: writing would create what it
 * points at), and an existing file may not have a second hard link (the other name can be anywhere on the disk).
 * `root` itself is not judged: the user chose it, and opening a project through an alias of its folder is not an escape.
 */
export function unsafeProjectPath(root: string, target: string): string | null {
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return `${target} is not inside the project folder`;
  const link = linkInPath(root, target);
  if (link) return `${link} is a symlink — refusing to go through it`;
  try {
    const st = lstatSync(target);
    if (st.isFile() && st.nlink > 1) return `${target} has a second hard link — refusing to read or write through it`;
  } catch {
    /* not there yet */
  }
  return null;
}

/** Throws unless `target` is safely inside the project (see unsafeProjectPath). */
export function assertProjectPath(root: string, target: string): void {
  const why = unsafeProjectPath(root, target);
  if (why) throw new Error(why);
}

/**
 * Writes one of Narrowbit's own files inside a project, never through a link. The path is checked, the file is opened
 * without following a link and without truncating, its link count is read from the open descriptor, and the path is
 * checked once more before anything is written — so a link or hard link put in place between the first check and the
 * open is caught too. What remains (disclosed): a folder swapped for a link in the instant between the second check
 * and the write; Node has no openat() to close that fully.
 */
export function writeProjectFile(root: string, file: string, data: string | Uint8Array, mode = 0o600): void {
  assertProjectPath(root, file);
  // Create exclusively first: if that works, this call made the file and is the only one entitled to remove it. If the name is
  // already taken, open the existing file without creating anything. What the path pointed to a moment ago says nothing about
  // which file the descriptor is.
  let created = true;
  let fd: number;
  try {
    fd = openPlain(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    created = false;
    fd = openPlain(file, constants.O_WRONLY, mode);
  }
  try {
    try {
      assertProjectPath(root, file);
      if (fstatSync(fd).ino !== lstatSync(file).ino) throw new Error(`${file} changed while it was being written — nothing was written`);
    } catch (e) {
      // A file this call just created, and still empty, is taken away again — the one we hold, not whatever the path leads to now.
      try {
        const st = fstatSync(fd);
        if (created && st.size === 0 && lstatSync(file).ino === st.ino) unlinkSync(file);
      } catch { /* nothing to undo */ }
      throw e;
    }
    ftruncateSync(fd, 0);
    writeSync(fd, data as any);
  } finally {
    closeSync(fd);
  }
}

/** Reads one of Narrowbit's own files inside a project, or null when it isn't there. Throws if it is reached through a
 * link or is also another file (a hard link): its contents would be whatever that other file holds. */
export function readProjectFile(root: string, file: string): string | null {
  assertProjectPath(root, file);
  try {
    return readPlain(file);
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

/** Deletes a file or folder of Narrowbit's own inside a project. `rm` doesn't follow a final link, but it does follow
 * one in a parent folder, so the whole path is checked first. */
export function removeProjectPath(root: string, target: string, opts: { recursive?: boolean } = {}): void {
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${target} is not inside the project folder`);
  const link = linkInPath(root, dirname(target));
  if (link) throw new Error(`${link} is a symlink — refusing to delete through it`);
  rmSync(target, { recursive: !!opts.recursive, force: true });
}

/** Like readProjectFile, but a file that is missing, linked or hard-linked simply counts as absent (used where a bad
 * state file should behave like no state file, e.g. settings a cloned repository shipped as a link). */
export function stateText(root: string, file: string): string | null {
  try {
    return readProjectFile(root, file);
  } catch {
    return null;
  }
}

/**
 * Reads a file of the project's own source (package.json, pyproject.toml, a tracked file…) as text, or null. Unlike
 * state files, source files may be hard-linked; what is refused is a symlink anywhere on the way, since following one
 * reads a file from outside the project (git itself stores such an entry as a link, not as that file's contents).
 */
export function sourceText(root: string, file: string, maxBytes = Infinity): string | null {
  const rel = relative(root, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || linkInPath(root, file)) return null;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * A file whose whole purpose is to hold credentials (.env, private keys, keystores…). The index already leaves these out;
 * this is the same list for reads, so a model that simply asks for the file by name doesn't get it either. A template
 * (.env.example, .env.sample…) is meant to be read and is allowed.
 */
export function isSecretFile(relPath: string): boolean {
  const base = relPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  // An environment file in any common spelling: .env, .env.local, prod.env, env.production, staging.env.json. A source file that
  // merely loads the environment (env.ts, env.d.ts) is code, and a template (.env.example) is not a secret.
  const segs = base.split(".");
  const last = segs[segs.length - 1];
  if (segs.includes("env") && !(segs.length > 1 && /^(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|md|txt)$/.test(last))) return !/^(example|sample|template|dist|defaults?)$/.test(last);
  return /\.(pem|key|p12|pfx|keystore)$/.test(base) || /^id_(rsa|ed25519|ecdsa|dsa)/.test(base) || /^credentials.*\.json$/.test(base) || /^secrets\..+/.test(base);
}

/**
 * A command that starts with `git` runs with the repository's own program hooks switched off, the way Narrowbit's own git calls
 * do (gitArgs): core.fsmonitor names a program git would run on a plain `git status`, and an external diff or text conversion
 * driver would run on `diff`, `log` and `show`. The command shown to the user is the one they typed; this is only what runs.
 */
export function hardenGitCommand(command: string): string {
  return command
    .replace(/^(\s*)git(\s+)/, (_m, lead, sp) => `${lead}git -c core.fsmonitor=false${sp}`)
    .replace(/^(\s*git -c core\.fsmonitor=false\s+(?:diff|log|show))(?=\s|$)/, "$1 --no-ext-diff --no-textconv");
}

/**
 * `npx vitest` in a project that does not have vitest makes npm download it from the registry and run it. A check run without
 * asking must not fetch code, so the test runners and linters Narrowbit knows are run from the project's own node_modules/.bin
 * (a missing one fails visibly with "No such file"; `npx --no` would exit 0 without running anything).
 */
export function hardenRunnerCommand(command: string): string {
  return command.replace(/^(\s*)(?:npx|bunx|pnpm\s+exec)\s+(?:(?:--no-install|--no|-y|--yes)\s+)*(vitest|jest|mocha|ava|tap|eslint|tsc)(?=\s|$)/, "$1./node_modules/.bin/$2");
}
