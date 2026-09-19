import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DEFAULT_IGNORE, type Paths } from "./config.js";
import { sh } from "./util.js";

export const CODE_EXT = /\.(?:[cm]?[jt]sx?|d\.ts)$/;
export const DOC_EXT = /\.(?:md|mdx)$/i;
export const CONFIG_NAMES = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|[^/]*\.config\.[cm]?[jt]s|\.eslintrc[^/]*|Dockerfile|docker-compose[^/]*\.ya?ml)$/;

export function isTestPath(p: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) || /(?:^|\/)(?:__tests__|__test__|tests?|e2e)\//.test(p);
}

export function isGeneratedPath(p: string): boolean {
  return /(?:^|\/)(?:generated|__generated__|gen)\//.test(p) || /\.(?:generated|gen)\.[jt]sx?$/.test(p) || /\.d\.ts$/.test(p);
}

/** Minimal gitignore-style matcher: supports `*`, `**`, `?`, leading `/`, trailing `/`, `!` negation. */
export class IgnoreMatcher {
  private rules: { re: RegExp; neg: boolean; dirOnly: boolean }[] = [];

  constructor(text: string) {
    for (let line of text.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      let neg = false;
      if (line.startsWith("!")) {
        neg = true;
        line = line.slice(1);
      }
      let dirOnly = false;
      if (line.endsWith("/")) {
        dirOnly = true;
        line = line.slice(0, -1);
      }
      const anchored = line.startsWith("/") || line.slice(0, -1).includes("/");
      if (line.startsWith("/")) line = line.slice(1);
      let re = "";
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "*") {
          if (line[i + 1] === "*") {
            re += ".*";
            i++;
            if (line[i + 1] === "/") i++;
          } else re += "[^/]*";
        } else if (c === "?") re += "[^/]";
        else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
      const prefix = anchored ? "^" : "(?:^|/)";
      // Pattern matches the path itself or any ancestor directory of it.
      this.rules.push({ re: new RegExp(`${prefix}${re}(?:/|$)`), neg, dirOnly });
    }
  }

  ignores(relPath: string): boolean {
    let ignored = false;
    for (const r of this.rules) {
      const m = r.re.exec(relPath);
      if (!m) continue;
      // dirOnly patterns must match a directory component, i.e. be followed by "/".
      if (r.dirOnly && !relPath.slice(m.index).includes("/")) continue;
      ignored = !r.neg;
    }
    return ignored;
  }
}

export function loadIgnore(p: Paths): IgnoreMatcher {
  const user = existsSync(p.ignore) ? readFileSync(p.ignore, "utf8") : "";
  return new IgnoreMatcher(DEFAULT_IGNORE + "\n.narrowbit/\n.git/\n" + user);
}

/** List candidate files: git-tracked + untracked-not-ignored, minus .narrowbitignore. Falls back to a directory walk. */
export function listFiles(p: Paths): string[] {
  const ig = loadIgnore(p);
  let files: string[];
  const g = sh("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], p.root);
  if (g.code === 0) {
    files = g.stdout.split("\0").filter(Boolean);
  } else {
    files = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, ent.name);
        const rel = relative(p.root, abs).split(sep).join("/");
        if (ig.ignores(ent.isDirectory() ? rel + "/" : rel)) continue;
        if (ent.isDirectory()) walk(abs);
        else if (ent.isFile()) files.push(rel);
      }
    };
    walk(p.root);
  }
  return [...new Set(files)]
    .filter((f) => !ig.ignores(f) && existsSync(join(p.root, f)))
    .filter((f) => {
      try {
        return statSync(join(p.root, f)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

export type FileKind = "code" | "test" | "doc" | "config" | "other";

export function fileKind(p: string): FileKind {
  if (CODE_EXT.test(p)) return isTestPath(p) ? "test" : "code";
  if (DOC_EXT.test(p)) return "doc";
  if (CONFIG_NAMES.test(p) || /\.(?:json|ya?ml|toml)$/.test(p)) return "config";
  return "other";
}

export function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
