import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";

export const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  mtime REAL NOT NULL DEFAULT 0,
  parsed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  qualified TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER NOT NULL,
  signature TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_lname ON symbols(lower(name));
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_id);
CREATE TABLE IF NOT EXISTS symbol_refs (
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS symbol_refs_name ON symbol_refs(name);
CREATE INDEX IF NOT EXISTS symbol_refs_sym ON symbol_refs(symbol_id);
CREATE TABLE IF NOT EXISTS imports (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  spec TEXT NOT NULL,
  kind TEXT NOT NULL,
  type_only INTEGER NOT NULL,
  bindings TEXT NOT NULL,
  target_id INTEGER
);
CREATE INDEX IF NOT EXISTS imports_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS imports_target ON imports(target_id);
CREATE TABLE IF NOT EXISTS terms (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  tf INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS terms_term ON terms(term);
CREATE INDEX IF NOT EXISTS terms_file ON terms(file_id);
CREATE TABLE IF NOT EXISTS tests_map (
  test_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  strength REAL NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tests_map_source ON tests_map(source_id);
CREATE INDEX IF NOT EXISTS tests_map_test ON tests_map(test_id);
`;

export interface FileRow {
  id: number;
  path: string;
  hash: string;
  kind: string;
  size: number;
  lines: number;
  tokens: number;
  mtime: number;
  parsed: number;
}

export interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  qualified: string;
  kind: string;
  start_line: number;
  end_line: number;
  exported: number;
  signature: string;
  doc: string;
  path?: string;
}

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    const fresh = !existsSync(path);
    this.db = new DatabaseSync(path);
    if (fresh) {
      try {
        chmodSync(path, 0o600);
      } catch {
        /* best effort */
      }
    }
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
    const v = this.tryMeta("schema_version");
    if (v && Number(v) !== SCHEMA_VERSION) {
      this.db.exec("DROP TABLE IF EXISTS tests_map; DROP TABLE IF EXISTS terms; DROP TABLE IF EXISTS imports; DROP TABLE IF EXISTS symbol_refs; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS files;");
    }
    this.db.exec(SCHEMA);
    this.setMeta("schema_version", String(SCHEMA_VERSION));
  }

  private tryMeta(key: string): string | undefined {
    try {
      return this.getMeta(key);
    } catch {
      return undefined;
    }
  }

  getMeta(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    return r?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  all<T = any>(sql: string, ...params: any[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T = any>(sql: string, ...params: any[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: any[]) {
    return this.db.prepare(sql).run(...params);
  }

  fileByPath(path: string): FileRow | undefined {
    return this.get<FileRow>("SELECT * FROM files WHERE path=?", path);
  }

  fileById(id: number): FileRow | undefined {
    return this.get<FileRow>("SELECT * FROM files WHERE id=?", id);
  }

  close() {
    this.db.close();
  }
}
