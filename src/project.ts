import { existsSync, writeFileSync } from "node:fs";
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
  if (!existsSync(p.ignore)) writeFileSync(p.ignore, DEFAULT_IGNORE);
  if (opts.index === false) return { stats: null };
  const store = openStore(p);
  const stats = indexRepo(p, store);
  store.close();
  return { stats };
}
