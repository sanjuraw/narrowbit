import type { NarrowbitConfig, Paths } from "./config.js";
import { outline, readLines, snippet } from "./package.js";
import { rank, relatedTests } from "./ranker.js";
import type { Store, SymbolRow } from "./store.js";
import { parseTask } from "./taskparse.js";
import type { TaskRecord } from "./tasks.js";
import { estimateTokens } from "./util.js";

/** Deterministic lookups served to agents (CLI + MCP). Each returns compact text. */

export function findSymbols(store: Store, name: string, limit = 10): SymbolRow[] {
  const q = name.trim();
  const byQualified = store.all<SymbolRow>(
    "SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.qualified = ? AND s.kind NOT IN ('test','suite') LIMIT ?",
    q,
    limit,
  );
  if (byQualified.length) return byQualified;
  const leaf = q.split(".").pop()!;
  const exact = store.all<SymbolRow>(
    "SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ? AND s.kind NOT IN ('test','suite') ORDER BY s.exported DESC, f.kind = 'code' DESC LIMIT ?",
    leaf,
    limit,
  );
  if (exact.length) return exact;
  return store.all<SymbolRow>(
    "SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE lower(s.name) = lower(?) OR s.name LIKE ? ESCAPE '\\' ORDER BY length(s.name) LIMIT ?",
    leaf,
    `%${leaf.replace(/[%_\\]/g, "\\$&")}%`,
    limit,
  );
}

export function symbolText(p: Paths, store: Store, name: string, opts: { maxLines?: number } = {}): string {
  const hits = findSymbols(store, name, 8);
  if (!hits.length) return `no symbol matching "${name}"`;
  const [first, ...rest] = hits;
  const out = [snippet(p.root, first.path!, first.start_line, first.end_line, opts.maxLines ?? 160)];
  if (rest.length) out.push(`other matches:\n${rest.map((s) => `  ${s.path}:${s.start_line} ${s.kind} ${s.qualified} — ${s.signature}`).join("\n")}`);
  return out.join("\n\n");
}

export function refsText(store: Store, name: string, limit = 40): string {
  const defs = findSymbols(store, name, 5);
  const leaf = name.split(".").pop()!;
  const defFiles = new Set(defs.map((d) => d.file_id));
  const importers = new Set<number>(defFiles);
  if (defFiles.size) {
    const ph = [...defFiles].map(() => "?").join(",");
    for (const r of store.all<{ file_id: number }>(`SELECT DISTINCT file_id FROM imports WHERE target_id IN (${ph})`, ...defFiles)) importers.add(r.file_id);
  }
  const rows = store.all<SymbolRow & { path: string }>(
    `SELECT s.*, f.path FROM symbol_refs r JOIN symbols s ON s.id = r.symbol_id JOIN files f ON f.id = s.file_id
     WHERE r.name = ? ORDER BY f.kind = 'test', f.path, s.start_line`,
    leaf,
  );
  // Drop enclosing classes when a method in the same class already references it; drop suites when a test does.
  const filtered = rows.filter(
    (r) =>
      // Large containers (classes, types) say nothing precise; their methods are listed individually.
      !(["class", "type", "interface"].includes(r.kind) && r.end_line - r.start_line > 60) &&
      !(r.kind === "class" && rows.some((x) => x.kind === "method" && x.file_id === r.file_id && x.qualified.startsWith(r.name + "."))) &&
      !(r.kind === "suite" && rows.some((x) => x.kind === "test" && x.file_id === r.file_id && x.start_line >= r.start_line && x.end_line <= r.end_line)),
  );
  const strong = defFiles.size ? filtered.filter((r) => importers.has(r.file_id)) : filtered;
  const weak = filtered.length - strong.length;
  const lines = [
    defs.length ? `defined: ${defs.map((d) => `${d.path}:${d.start_line} ${d.qualified}`).join(", ")}` : `no definition indexed for ${name}`,
    `used by (${strong.length}${weak ? `; ${weak} same-name refs in files not importing it omitted` : ""}):`,
    ...strong.slice(0, limit).map((r) => `  ${r.path}:${r.start_line}-${r.end_line} ${r.kind} ${r.qualified}`),
  ];
  if (strong.length > limit) lines.push(`  … ${strong.length - limit} more`);
  return lines.join("\n");
}

export function outlineText(store: Store, path: string): string {
  const f = store.fileByPath(path) ?? store.get<any>("SELECT * FROM files WHERE path LIKE ? ORDER BY length(path) LIMIT 1", `%${path}`);
  if (!f) return `file not indexed: ${path}`;
  const imports = store.all<{ spec: string; target: string | null }>(
    "SELECT i.spec, t.path AS target FROM imports i LEFT JOIN files t ON t.id = i.target_id WHERE i.file_id = ?",
    f.id,
  );
  const importedBy = store.all<{ path: string }>("SELECT DISTINCT f.path FROM imports i JOIN files f ON f.id = i.file_id WHERE i.target_id = ?", f.id);
  const tests = relatedTests(store, [f.id], 5);
  return [
    `${f.path} (${f.lines} lines, ~${f.tokens} tokens)`,
    ...outline(store, f.id, [], 40),
    imports.length ? `imports: ${imports.map((i) => i.target ?? i.spec).join(", ")}` : "",
    importedBy.length ? `imported by: ${importedBy.slice(0, 15).map((x) => x.path).join(", ")}${importedBy.length > 15 ? ` (+${importedBy.length - 15})` : ""}` : "",
    tests.length ? `tests: ${tests.map((t) => t.path).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function searchText(p: Paths, store: Store, query: string, limit = 10): string {
  const r = rank(store, p.root, parseTask(query), { noGit: true });
  if (!r.files.length) return `no matches for "${query}"`;
  return r.files
    .slice(0, limit)
    .map((f) => {
      const syms = f.symbols.slice(0, 3).map((s) => `\n    L${s.start}-${s.end} ${s.signature}`).join("");
      return `${f.path} [${f.score.toFixed(1)}] ${f.reasons.slice(0, 2).join("; ")}${syms}`;
    })
    .join("\n");
}

export function testsText(store: Store, path: string): string {
  const f = store.fileByPath(path);
  if (!f) return `file not indexed: ${path}`;
  const t = relatedTests(store, [f.id], 10);
  return t.length ? t.map((x) => `${x.path} (${x.reason}, strength ${x.strength})`).join("\n") : `no tests mapped to ${path}`;
}

export function fileRangeText(p: Paths, path: string, start: number, end: number): string {
  return `// ${path}:${start}-${end}\n${readLines(p.root, path, start, end)}`;
}

/**
 * Progressive expansion for the current task: the next most relevant items not yet delivered.
 * Level ladder: symbol snippets of next files → complete files → neighbours/tests.
 */
export function expandTask(p: Paths, cfg: NarrowbitConfig, store: Store, task: TaskRecord, budget = 4000): { text: string; given: string[] } {
  const r = rank(store, p.root, parseTask(task.text), { noGit: false });
  const given = new Set(task.given);
  const parts: string[] = [];
  const newly: string[] = [];
  const used = () => estimateTokens(parts.join("\n\n"));
  for (const f of r.files.slice(0, 25)) {
    if (used() >= budget) break;
    const fileKey = `file:${f.path}`;
    const outlineKey = `outline:${f.path}`;
    if (given.has(fileKey) || f.kind === "doc" || f.kind === "other") continue;
    const fresh = f.symbols.filter((s) => !given.has(`sym:${f.path}#${s.qualified}`) && s.kind !== "suite");
    if (fresh.length) {
      for (const s of fresh.slice(0, 3)) {
        const sn = snippet(p.root, f.path, s.start, s.end, 100);
        if (used() + estimateTokens(sn) > budget) break;
        parts.push(sn);
        newly.push(`sym:${f.path}#${s.qualified}`);
        given.add(`sym:${f.path}#${s.qualified}`);
      }
    } else if (f.tokens <= cfg.maxInlineFileTokens * 1.5 && used() + f.tokens <= budget) {
      parts.push(`// ${f.path} (full file)\n${readLines(p.root, f.path, 1, f.lines)}`);
      newly.push(fileKey);
      given.add(fileKey);
    } else if (!given.has(outlineKey)) {
      const ol = `// ${f.path} outline\n${outline(store, f.id, [], 15).join("\n")}`;
      if (used() + estimateTokens(ol) <= budget) {
        parts.push(ol);
        newly.push(outlineKey);
        given.add(outlineKey);
      }
    }
  }
  if (!parts.length) return { text: "no further relevant context found; use nb_search with a more specific query", given: [] };
  return { text: parts.join("\n\n"), given: newly };
}
