import { existsSync, lstatSync } from "node:fs";
import { detectVerify, ensureDirs, loadConfig, saveConfig, type Paths } from "./config.js";
import { indexRepo, openStore } from "./indexer.js";

/** `narrowbit init` minus the printing, shared by the CLI and the app. Never overwrites an existing config or ignore file. */
export function initProject(p: Paths, opts: { index?: boolean } = {}): { stats: ReturnType<typeof indexRepo> | null } {
  ensureDirs(p);
  if (!existsSync(p.config)) {
    const cfg = loadConfig(p);
    cfg.verify = detectVerify(p.root);
    saveConfig(p, cfg);
  }
  // The default exclusions are built in (loadIgnore), so no .narrowbitignore is written into the user's folder; one that
  // already exists is still read, but never through a link.
  try { if (lstatSync(p.ignore).isSymbolicLink()) throw new Error(`${p.ignore} is a symlink — Narrowbit won't read its ignore rules through a link`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (opts.index === false) return { stats: null };
  const store = openStore(p);
  const stats = indexRepo(p, store);
  store.close();
  return { stats };
}
