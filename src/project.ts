import { existsSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { writeProjectFile } from "./util.js";
import { DEFAULT_IGNORE, detectVerify, ensureDirs, loadConfig, saveConfig, type Paths } from "./config.js";
import { indexRepo, openStore } from "./indexer.js";

/** `narrowbit init` minus the printing, shared by the CLI and the app. Never overwrites an existing config or ignore file. */
export function initProject(p: Paths, opts: { index?: boolean } = {}): { stats: ReturnType<typeof indexRepo> | null } {
  ensureDirs(p);
  if (!existsSync(p.config)) {
    const cfg = loadConfig(p);
    cfg.verify = detectVerify(p.root);
    saveConfig(p, cfg);
  }
  // lstat, not existsSync: a dangling link named .narrowbitignore "doesn't exist", and writing it would create its target.
  let hasIgnore = true;
  try { lstatSync(p.ignore); } catch { hasIgnore = false; }
  if (!hasIgnore) writeProjectFile(dirname(p.ignore), p.ignore, DEFAULT_IGNORE, 0o644);
  else if (lstatSync(p.ignore).isSymbolicLink()) throw new Error(`${p.ignore} is a symlink — Narrowbit won't read its ignore rules through a link`);
  if (opts.index === false) return { stats: null };
  const store = openStore(p);
  const stats = indexRepo(p, store);
  store.close();
  return { stats };
}
