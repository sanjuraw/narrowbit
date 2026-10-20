import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * A read-only working copy of a public GitHub repository, so the planning chat can explore it with the provider's own file
 * tools (Read, Glob, Grep). It is a shallow clone with every program a repository can carry switched off (hooks, LFS filters,
 * submodules), then stripped: no .git folder, no symbolic links (a link could point at a file outside the copy), a size and
 * file-count cap. Copies live under ~/.narrowbit/drafts/repos and are reused for a day and deleted after three.
 */
const MAX_BYTES = 300_000_000;
const MAX_FILES = 50_000;
const CLONE_TIMEOUT_MS = 120_000;
const REUSE_MS = 24 * 3600_000;
const KEEP_MS = 3 * 24 * 3600_000;

export const reposRoot = (): string => join(homedir(), ".narrowbit", "drafts", "repos");

/** Removes symbolic links and measures what is left; returns an error text when the copy is too big. */
function strip(dir: string): string | null {
  let bytes = 0;
  let files = 0;
  const walk = (d: string): string | null => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isSymbolicLink()) { unlinkSync(f); continue; }
      if (e.isDirectory()) { const bad = walk(f); if (bad) return bad; continue; }
      if (!e.isFile()) { unlinkSync(f); continue; }
      files++;
      bytes += lstatSync(f).size;
      if (files > MAX_FILES || bytes > MAX_BYTES) return "the repository is too large to copy";
    }
    return null;
  };
  return walk(dir);
}

function removeOld(root: string): void {
  try {
    for (const name of readdirSync(root)) {
      const f = join(root, name);
      try { if (Date.now() - statSync(f).mtimeMs > KEEP_MS) rmSync(f, { recursive: true, force: true }); } catch { /* next */ }
    }
  } catch { /* no folder yet */ }
}

/** `url` is only for tests (a local repository); the app always clones from github.com. */
export async function copyRepo(owner: string, repo: string, opts: { url?: string; root?: string } = {}): Promise<{ dir: string } | { error: string }> {
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return { error: "not a repository name" };
  const root = opts.root ?? reposRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  removeOld(root);
  const dest = join(root, `${owner}__${repo}`);
  try { if (existsSync(dest) && Date.now() - statSync(dest).mtimeMs < REUSE_MS) return { dir: dest }; } catch { /* clone again */ }
  rmSync(dest, { recursive: true, force: true });
  const tmp = join(root, `.tmp-${randomUUID().slice(0, 8)}`);
  const url = opts.url ?? `https://github.com/${owner}/${repo}.git`;
  const args = [
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", `protocol.${opts.url ? "file" : "https"}.allow=always`,
    "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false",
    "clone", "--depth", "1", "--single-branch", "--no-tags", "--no-recurse-submodules", "--", url, tmp,
  ];
  const err = await new Promise<string | null>((resolve) => {
    const child = spawn("git", args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, CLONE_TIMEOUT_MS);
    child.on("error", () => { clearTimeout(timer); resolve("git could not be started"); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? null : /not found|Repository not found|could not read Username/i.test(stderr) ? "that repository was not found (or it is private)" : "the repository could not be copied"); });
  });
  if (err) { rmSync(tmp, { recursive: true, force: true }); return { error: err }; }
  try {
    rmSync(join(tmp, ".git"), { recursive: true, force: true });
    const bad = strip(tmp);
    if (bad) { rmSync(tmp, { recursive: true, force: true }); return { error: bad }; }
    renameSync(tmp, dest);
  } catch {
    rmSync(tmp, { recursive: true, force: true });
    return { error: "the repository could not be copied" };
  }
  return { dir: dest };
}
