import { readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import ts from "typescript";

const EXTS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

interface TsCfg {
  dir: string; // repo-relative, "" for root
  baseUrl?: string; // repo-relative
  paths?: Record<string, string[]>;
}

/**
 * Deterministic module resolver over the indexed file set: relative imports,
 * tsconfig `baseUrl`/`paths` (nearest tsconfig, `extends` honoured), and
 * workspace packages declared by package.json `name`.
 */
export class Resolver {
  private files: Set<string>;
  private tsconfigs: TsCfg[] = [];
  private packages: { name: string; dir: string; entry?: string }[] = [];

  constructor(root: string, allFiles: string[]) {
    this.files = new Set(allFiles);
    for (const f of allFiles) {
      if (/(?:^|\/)tsconfig\.json$/.test(f) || /(?:^|\/)jsconfig\.json$/.test(f)) this.loadTsconfig(root, f);
      if (/(?:^|\/)package\.json$/.test(f)) this.loadPackage(root, f);
    }
    this.tsconfigs.sort((a, b) => b.dir.length - a.dir.length);
    this.packages.sort((a, b) => b.name.length - a.name.length);
  }

  private loadTsconfig(root: string, rel: string) {
    try {
      const abs = join(root, rel);
      const read = ts.readConfigFile(abs, ts.sys.readFile);
      if (read.error) return;
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(abs), undefined, abs);
      const o = parsed.options;
      const cfgDir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
      const base = o.baseUrl ?? (o.paths ? (o as any).pathsBasePath ?? dirname(abs) : undefined);
      this.tsconfigs.push({
        dir: cfgDir,
        baseUrl: base ? relative(root, base).split("\\").join("/") : undefined,
        paths: o.paths,
      });
    } catch {
      /* malformed tsconfig: ignore */
    }
  }

  private loadPackage(root: string, rel: string) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, rel), "utf8"));
      if (!pkg.name) return;
      const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
      let entry: string | undefined;
      const exp = pkg.exports;
      const pick = (v: any): string | undefined =>
        typeof v === "string" ? v : v && typeof v === "object" ? pick(v["."] ?? v.types ?? v.import ?? v.default ?? v.require) : undefined;
      entry = pick(exp) ?? pkg.types ?? pkg.module ?? pkg.main;
      this.packages.push({ name: pkg.name, dir, entry });
    } catch {
      /* ignore */
    }
  }

  private tryPath(base: string): string | null {
    base = posix.normalize(base).replace(/^\.\//, "");
    if (base.startsWith("../")) return null;
    if (this.files.has(base)) return base;
    const ext = posix.extname(base);
    if (JS_TO_TS[ext]) {
      const stem = base.slice(0, -ext.length);
      for (const t of JS_TO_TS[ext]) if (this.files.has(stem + t)) return stem + t;
    }
    for (const e of EXTS) if (this.files.has(base + e)) return base + e;
    for (const e of EXTS) if (this.files.has(posix.join(base, "index" + e))) return posix.join(base, "index" + e);
    return null;
  }

  private tsconfigFor(from: string): TsCfg | undefined {
    return this.tsconfigs.find((c) => c.dir === "" || from.startsWith(c.dir + "/"));
  }

  resolve(from: string, spec: string): string | null {
    if (spec.startsWith(".") || spec.startsWith("/")) {
      return this.tryPath(spec.startsWith("/") ? spec.slice(1) : posix.join(posix.dirname(from), spec));
    }
    const cfg = this.tsconfigFor(from);
    if (cfg?.paths) {
      const base = cfg.baseUrl ?? cfg.dir;
      for (const [pattern, targets] of Object.entries(cfg.paths)) {
        const star = pattern.indexOf("*");
        let captured: string | null = null;
        if (star < 0) captured = pattern === spec ? "" : null;
        else {
          const pre = pattern.slice(0, star);
          const post = pattern.slice(star + 1);
          if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length)
            captured = spec.slice(pre.length, spec.length - post.length);
        }
        if (captured === null) continue;
        for (const t of targets) {
          const r = this.tryPath(posix.join(base, t.replace("*", captured)));
          if (r) return r;
        }
      }
    }
    if (cfg?.baseUrl !== undefined) {
      const r = this.tryPath(posix.join(cfg.baseUrl, spec));
      if (r) return r;
    }
    for (const p of this.packages) {
      if (spec !== p.name && !spec.startsWith(p.name + "/")) continue;
      const sub = spec.slice(p.name.length).replace(/^\//, "");
      if (sub) {
        return this.tryPath(posix.join(p.dir, sub)) ?? this.tryPath(posix.join(p.dir, "src", sub));
      }
      const cands = [p.entry, "src/index", "index"].filter(Boolean) as string[];
      for (const c of cands) {
        // Map built entries (dist/index.js) back to source when possible.
        const r = this.tryPath(posix.join(p.dir, c)) ?? this.tryPath(posix.join(p.dir, c.replace(/^(?:\.\/)?(?:dist|build|lib|out)\//, "src/")));
        if (r) return r;
      }
    }
    return null;
  }
}
