import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Self-update from GitHub for a source install (a git clone that `npm link` points at): fetch, compare
 * with origin/main, and on request fast-forward, reinstall if dependencies changed, and rebuild.
 *
 * Deliberately conservative: it never touches a checkout with uncommitted edits or local commits
 * GitHub doesn't have (that's a development copy, and a pull could lose or tangle work), only ever
 * fast-forwards, and rolls back to the previous commit if the build fails so a bad release can't
 * leave the app broken. Uses whatever git credentials the machine already has, so a private repo
 * works for anyone with access.
 */
const INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRANCH = "main";

export interface UpdateInfo {
  supported: boolean;
  /** Why updating isn't possible or offered (not a git checkout, dirty tree, ahead of GitHub, offline...). */
  reason?: string;
  current?: string;
  latest?: string;
  behind: number;
  ahead: number;
  dirty: boolean;
  /** Subjects of the newest commits you don't have yet. */
  changes: string[];
  /** Update numbers (the count of changes so far), so people can say "update 187". Absent when git can't be read. */
  number?: number;
  currentNumber?: number;
  canApply: boolean;
  checkedAt: string;
}

function git(args: string[], timeoutMs = 20_000) {
  const r = spawnSync("git", ["-c", `safe.directory=${INSTALL_ROOT}`, ...args], { cwd: INSTALL_ROOT, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function unsupported(reason: string): UpdateInfo {
  return { supported: false, reason, behind: 0, ahead: 0, dirty: false, changes: [], canApply: false, checkedAt: new Date().toISOString() };
}

export interface VersionInfo {
  version: string;
  commit: string;
}

let versionCache: VersionInfo | null = null;
export function readVersion(): VersionInfo {
  if (versionCache) return versionCache;
  try {
    const v = JSON.parse(readFileSync(join(INSTALL_ROOT, "dist", "version.json"), "utf8"));
    versionCache = { version: String(v.version ?? ""), commit: String(v.commit ?? "") };
  } catch {
    versionCache = { version: "", commit: "" };
  }
  return versionCache;
}

function writable(): boolean {
  try {
    accessSync(INSTALL_ROOT, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

let cache: { at: number; value: UpdateInfo } | null = null;

export async function checkUpdate(force = false): Promise<UpdateInfo> {
  if (!force && cache && Date.now() - cache.at < 5 * 60_000) return cache.value;
  const value = await compute();
  cache = { at: Date.now(), value };
  return value;
}

async function compute(): Promise<UpdateInfo> {
  if (!existsSync(join(INSTALL_ROOT, ".git"))) return unsupported("This copy of Narrowbit isn't a git checkout, so it can't update itself.");
  const head = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.code !== 0) return unsupported("Can't read this copy's git state (it may belong to another user account).");
  const branch = head.out;
  if (branch !== BRANCH) return unsupported(`Updates follow ${BRANCH}; this copy is on "${branch}".`);
  if (!writable()) {
    // Can't write .git here (another account owns this install), so don't fetch: just ask GitHub
    // what the latest commit is and compare it with what's checked out.
    const remote = await exec("git", ["ls-remote", "origin", `refs/heads/${BRANCH}`], 30_000);
    const latest = remote.code === 0 ? remote.out.split(/\s+/)[0] : "";
    if (!latest) return unsupported("Couldn't check for updates from this account (offline?).");
    const local = git(["rev-parse", "HEAD"]).out;
    const behind = latest !== local ? 1 : 0;
    return {
      supported: true,
      current: local.slice(0, 7),
      latest: latest.slice(0, 7),
      behind,
      ahead: 0,
      dirty: false,
      changes: [],
      canApply: false,
      reason: behind ? "A newer version is available. This copy belongs to another user account — update it from that account." : undefined,
      checkedAt: new Date().toISOString(),
    };
  }
  // Async so a slow network never freezes the app's server while it waits.
  const fetched = await exec("git", ["fetch", "--quiet", "origin", BRANCH], 30_000);
  if (fetched.code !== 0) return unsupported(`Couldn't check for updates (${(fetched.out.split("\n")[0] || "no connection").slice(0, 120)}).`);
  const counts = git(["rev-list", "--left-right", "--count", `HEAD...origin/${BRANCH}`]).out.split(/\s+/).map(Number);
  const [ahead, behind] = [counts[0] || 0, counts[1] || 0];
  // package-lock.json is regenerated by npm and never hand-edited in an install, so it must not count as "your changes".
  const dirty = git(["status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude)package-lock.json"]).out.length > 0;
  const changes = behind ? git(["log", "--pretty=%s", "-n", "10", `HEAD..origin/${BRANCH}`]).out.split("\n").filter(Boolean) : [];
  const info: UpdateInfo = {
    supported: true,
    number: Number(git(["rev-list", "--count", `origin/${BRANCH}`]).out) || undefined,
    currentNumber: Number(git(["rev-list", "--count", "HEAD"]).out) || undefined,
    current: git(["rev-parse", "--short", "HEAD"]).out,
    latest: git(["rev-parse", "--short", `origin/${BRANCH}`]).out,
    behind,
    ahead,
    dirty,
    changes,
    canApply: behind > 0 && ahead === 0 && !dirty,
    checkedAt: new Date().toISOString(),
  };
  if (info.canApply && !writable()) {
    info.canApply = false;
    info.reason = "This copy belongs to another user account — update it from that account.";
  }
  if (behind > 0 && !info.canApply && !info.reason) info.reason = dirty ? "There are uncommitted changes in this copy, so it won't overwrite them." : "This copy has changes of its own that aren't in the release, so it won't pull over them.";
  return info;
}

function exec(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolveP) => {
    let out = "";
    const child = spawn(cmd, cmd === "git" ? ["-c", `safe.directory=${INSTALL_ROOT}`, ...args] : args, { cwd: INSTALL_ROOT, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolveP({ code: 1, out: String(e.message) }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code: code ?? 1, out: out.slice(-1500) });
    });
  });
}

/** Fast-forward to origin/main, reinstall if dependencies changed, rebuild. Throws (after rolling back) on failure. */
export interface UpdateNotes {
  number?: number;
  from: string;
  to: string;
  /** One entry per change: a short title and, when the change was described at length, the details. */
  notes: { title: string; details: string }[];
}

const NOTES_FILE = join(homedir(), ".narrowbit", "last-update.json");

function notesBetween(from: string, to: string): UpdateNotes["notes"] {
  const raw = git(["log", "--reverse", "--pretty=%x1e%s%x1f%b", `${from}..${to}`], 30_000).out;
  return raw
    .split("\x1e")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [title = "", body = ""] = c.split("\x1f");
      const details = body.split("\n").filter((l) => !/^(Co-Authored-By|Signed-off-by):/i.test(l.trim())).join("\n").trim();
      return { title: title.trim(), details };
    });
}

/** What the last update brought, kept until the person has seen it (the app restarts right after updating). */
export function pendingUpdateNotes(): UpdateNotes | null {
  try {
    return JSON.parse(readFileSync(NOTES_FILE, "utf8"));
  } catch {
    return null;
  }
}
export function acknowledgeUpdateNotes(): void {
  rmSync(NOTES_FILE, { force: true });
}

export async function applyUpdate(): Promise<UpdateNotes> {
  const info = await checkUpdate(true);
  if (!info.supported) throw new Error(info.reason ?? "updates aren't available for this copy");
  if (!info.canApply) throw new Error(info.behind === 0 ? "Already up to date." : (info.reason ?? "can't update this copy safely"));
  const oldHead = git(["rev-parse", "HEAD"]).out;
  git(["checkout", "--", "package-lock.json"]);
  const pulled = await exec("git", ["pull", "--ff-only", "--quiet", "origin", BRANCH], 60_000);
  if (pulled.code !== 0) throw new Error(`git pull failed: ${pulled.out.split("\n").slice(-2).join(" ").slice(0, 200)}`);
  const newHead = git(["rev-parse", "HEAD"]).out;
  const rollback = async (why: string): Promise<never> => {
    git(["reset", "--hard", oldHead]);
    await exec("npm", ["run", "build"], 180_000);
    throw new Error(`${why} — rolled back to the previous version.`);
  };
  const changedDeps = git(["diff", "--name-only", oldHead, newHead, "--", "package.json", "package-lock.json"]).out.length > 0;
  if (changedDeps || !existsSync(join(INSTALL_ROOT, "node_modules"))) {
    const inst = await exec("npm", ["install", "--no-audit", "--no-fund"], 300_000);
    if (inst.code !== 0) await rollback(`npm install failed: ${inst.out.split("\n").slice(-2).join(" ").slice(0, 200)}`);
  }
  const built = await exec("npm", ["run", "build"], 180_000);
  if (built.code !== 0) await rollback(`Build failed: ${built.out.split("\n").slice(-3).join(" ").slice(0, 240)}`);
  cache = null;
  const result: UpdateNotes = { number: Number(git(["rev-list", "--count", "HEAD"]).out) || undefined, from: oldHead.slice(0, 7), to: newHead.slice(0, 7), notes: notesBetween(oldHead, newHead) };
  try {
    mkdirSync(dirname(NOTES_FILE), { recursive: true });
    writeFileSync(NOTES_FILE, JSON.stringify(result));
  } catch {
    // The notes are a courtesy; an unwritable home folder must not undo a successful update.
  }
  return result;
}
