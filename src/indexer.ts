import { readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { loadConfig, type Paths } from "./config.js";
import { CODE_EXT, fileKind, isProbablyBinary, isTestPath, listFiles } from "./files.js";
import { parseSource } from "./parser.js";
import { Resolver } from "./resolve.js";
import { Store } from "./store.js";
import { termFreq } from "./terms.js";
import { estimateTokens, sha1 } from "./util.js";

export interface IndexStats {
  files: number;
  parsed: number;
  unchanged: number;
  removed: number;
  symbols: number;
  imports: number;
  resolvedImports: number;
  testLinks: number;
  ms: number;
}

export function openStore(p: Paths): Store {
  // The folder that holds this project's state folder (not p.root: that is the isolated copy during an isolated run).
  return new Store(p.db, dirname(dirname(p.db)));
}

/** Incremental index: only files whose content hash changed are re-parsed. */
export function indexRepo(p: Paths, store: Store, opts: { force?: boolean; quiet?: boolean } = {}): IndexStats {
  const t0 = Date.now();
  const cfg = loadConfig(p);
  const files = listFiles(p);
  const existing = new Map(store.all<{ id: number; path: string; hash: string; size: number; mtime: number }>("SELECT id, path, hash, size, mtime FROM files").map((r) => [r.path, r]));
  const seen = new Set<string>();
  let parsed = 0;
  let unchanged = 0;

  const insFile = store.db.prepare("INSERT INTO files(path,hash,kind,size,lines,tokens,mtime,parsed) VALUES(?,?,?,?,?,?,?,?)");
  const insSym = store.db.prepare(
    "INSERT INTO symbols(file_id,name,qualified,kind,start_line,end_line,exported,signature,doc) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  const insRef = store.db.prepare("INSERT INTO symbol_refs(symbol_id,name) VALUES(?,?)");
  const insImp = store.db.prepare("INSERT INTO imports(file_id,spec,kind,type_only,bindings) VALUES(?,?,?,?,?)");
  const insTerm = store.db.prepare("INSERT INTO terms(file_id,term,tf) VALUES(?,?,?)");
  const delFile = store.db.prepare("DELETE FROM files WHERE id=?");

  store.tx(() => {
    for (const rel of files) {
      seen.add(rel);
      const prev = existing.get(rel);
      let st;
      try {
        st = statSync(join(p.root, rel));
      } catch {
        continue;
      }
      // Fast path: unchanged size + mtime means unchanged content; skip the read entirely.
      if (prev && !opts.force && prev.size === st.size && prev.mtime === st.mtimeMs) {
        unchanged++;
        continue;
      }
      let buf: Buffer;
      try {
        buf = readFileSync(join(p.root, rel));
      } catch {
        continue;
      }
      if (buf.length > cfg.maxFileBytes * 4 || isProbablyBinary(buf)) continue;
      const hash = sha1(buf);
      if (prev && prev.hash === hash && !opts.force) {
        store.run("UPDATE files SET mtime=?, size=? WHERE id=?", st.mtimeMs, st.size, prev.id);
        unchanged++;
        continue;
      }
      if (prev) delFile.run(prev.id);
      const text = buf.toString("utf8");
      const kind = fileKind(rel);
      const lines = text.split("\n").length;
      const tokens = estimateTokens(text);
      const canParse = CODE_EXT.test(rel) && buf.length <= cfg.maxFileBytes;
      const fid = Number(insFile.run(rel, hash, kind, buf.length, lines, tokens, st.mtimeMs, canParse ? 1 : 0).lastInsertRowid);
      parsed++;

      let tf: Map<string, number>;
      if (canParse) {
        const pf = parseSource(rel, text);
        for (const s of pf.symbols) {
          const sid = Number(insSym.run(fid, s.name, s.qualified, s.kind, s.startLine, s.endLine, s.exported ? 1 : 0, s.signature, s.doc).lastInsertRowid);
          for (const r of s.refs) insRef.run(sid, r);
        }
        for (const im of pf.imports) insImp.run(fid, im.spec, im.kind, im.typeOnly ? 1 : 0, JSON.stringify(im.bindings));
        tf = pf.terms;
      } else if (kind === "doc" || kind === "config") {
        tf = termFreq(text.slice(0, 200_000));
      } else {
        tf = new Map();
      }
      // Path segments are strong signals; weight them into the term vector.
      termFreq(rel.replace(/\.[^.]+$/, "").replace(/[/._-]+/g, " "), tf);
      for (const [term, n] of tf) insTerm.run(fid, term, n);
    }
    let removed = 0;
    for (const [path, row] of existing) {
      if (!seen.has(path)) {
        delFile.run(row.id);
        removed++;
      }
    }
    store.setMeta("removed_last", String(removed));
  });

  const { resolved, total } = resolveImports(p, store, files);
  const testLinks = mapTests(store);
  const counts = store.get<{ s: number }>("SELECT count(*) s FROM symbols")!;
  store.setMeta("indexed_at", new Date().toISOString());
  const nfiles = store.get<{ n: number }>("SELECT count(*) n FROM files")!.n;
  return {
    files: nfiles,
    parsed,
    unchanged,
    removed: Number(store.getMeta("removed_last") ?? 0),
    symbols: counts.s,
    imports: total,
    resolvedImports: resolved,
    testLinks,
    ms: Date.now() - t0,
  };
}

function resolveImports(p: Paths, store: Store, files: string[]): { resolved: number; total: number } {
  const resolver = new Resolver(p.root, files);
  const ids = new Map(store.all<{ id: number; path: string }>("SELECT id, path FROM files").map((r) => [r.path, r.id]));
  const rows = store.all<{ rowid: number; spec: string; path: string }>(
    "SELECT imports.rowid AS rowid, spec, files.path AS path FROM imports JOIN files ON files.id = imports.file_id",
  );
  const upd = store.db.prepare("UPDATE imports SET target_id=? WHERE rowid=?");
  let resolved = 0;
  store.tx(() => {
    for (const r of rows) {
      const target = resolver.resolve(r.path, r.spec);
      const tid = target ? ids.get(target) ?? null : null;
      if (tid) resolved++;
      upd.run(tid, r.rowid);
    }
  });
  return { resolved, total: rows.length };
}

/** Map test files → source files: direct imports (strong), naming convention (medium), 2-hop imports (weak). */
function mapTests(store: Store): number {
  const files = store.all<{ id: number; path: string; kind: string }>("SELECT id, path, kind FROM files WHERE kind IN ('code','test')");
  const byId = new Map(files.map((f) => [f.id, f]));
  const srcByStem = new Map<string, { id: number; path: string }[]>();
  for (const f of files) {
    if (f.kind !== "code") continue;
    const stem = posix.basename(f.path).replace(/\.[cm]?[jt]sx?$/, "");
    const list = srcByStem.get(stem) ?? [];
    list.push(f);
    srcByStem.set(stem, list);
  }
  const importsOf = new Map<number, number[]>();
  for (const r of store.all<{ file_id: number; target_id: number }>("SELECT file_id, target_id FROM imports WHERE target_id IS NOT NULL")) {
    const l = importsOf.get(r.file_id) ?? [];
    l.push(r.target_id);
    importsOf.set(r.file_id, l);
  }
  const ins = store.db.prepare("INSERT INTO tests_map(test_id,source_id,strength,reason) VALUES(?,?,?,?)");
  let n = 0;
  store.tx(() => {
    store.run("DELETE FROM tests_map");
    for (const t of files) {
      if (t.kind !== "test" && !isTestPath(t.path)) continue;
      const links = new Map<number, { s: number; reason: string }>();
      const add = (id: number, s: number, reason: string) => {
        const cur = links.get(id);
        if (!cur || cur.s < s) links.set(id, { s, reason });
      };
      for (const tid of importsOf.get(t.id) ?? []) {
        const tgt = byId.get(tid);
        if (tgt && tgt.kind === "code") add(tid, 1.0, "imports");
        for (const tid2 of importsOf.get(tid) ?? []) add(tid2, 0.35, "imports (2-hop)");
      }
      const stem = posix.basename(t.path).replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/, "").replace(/\.[cm]?[jt]sx?$/, "");
      for (const src of srcByStem.get(stem) ?? []) {
        if (src.id === t.id) continue;
        const sameDir = posix.dirname(src.path) === posix.dirname(t.path) || posix.dirname(t.path).endsWith("__tests__");
        add(src.id, sameDir ? 0.9 : 0.6, "name match");
      }
      for (const [sid, v] of links) {
        if (sid === t.id || byId.get(sid)?.kind !== "code") continue;
        ins.run(t.id, sid, v.s, v.reason);
        n++;
      }
    }
  });
  return n;
}
