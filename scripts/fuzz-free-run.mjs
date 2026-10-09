// Differential + behavioural fuzz of the free-run filter ("ask, except checks"), run after any change to src/approvals.ts.
// For random commands the filter admits, it (a) compares the words the filter saw with the words the real sh produces, and
// (b) runs the command, hardened as the app runs it, in a throwaway project next to a "secret" and an "outside" folder and reports
// any write, any read outside the project and any read of a secret file. Findings of kind WROTE that only touch tool caches
// (.pytest_cache, ~/.npm, corepack) are housekeeping. Usage: npm run build && node scripts/fuzz-free-run.mjs [samples] [seed]
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readdirSync, readFileSync, lstatSync, realpathSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
const R = new URL("../dist/", import.meta.url).pathname;
const { allowedAsCheck, shellWords } = await import(R + "approvals.js");
const { hardenGitCommand, hardenRunnerCommand } = await import(R + "util.js");
const N = Number(process.argv[2] ?? 20000);
let seed = Number(process.argv[3] ?? 1);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const base = realpathSync(mkdtempSync(join(tmpdir(), "fz-")));
const root = join(base, "proj"), outside = join(base, "outside");
mkdirSync(root); mkdirSync(outside); mkdirSync(join(root, "sub"));
writeFileSync(join(outside, "secret.txt"), "OUTCANARY\n");
writeFileSync(join(outside, "patterns"), "a\n");
writeFileSync(join(root, "a.txt"), "alpha\nbeta\nhello\n");
writeFileSync(join(root, "sub", "b.txt"), "gamma\n");
writeFileSync(join(root, ".env"), "SECRET_THING=ENVCANARY\n");
writeFileSync(join(root, "package.json"), '{"scripts":{"test":"echo ran-test","lint":"echo ran-lint","typecheck":"echo ran-tc"}}\n');
symlinkSync(outside, join(root, "alias"));
symlinkSync(join(outside, "secret.txt"), join(root, "alias2"));
writeFileSync(join(root, "alias space"), "x");
symlinkSync(outside, join(root, "alias folder"));
const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, stdio: "ignore" });
// A hostile repository config: programs git would run by itself. Any of them running is a finding (a marker file appears).
const monitor = join(base, "monitor.sh"), driver = join(base, "driver.sh");
writeFileSync(monitor, `#!/bin/sh\ntouch ${join(outside, "fsmonitor-ran")}\nprintf '\\0'\n`, { mode: 0o755 });
writeFileSync(driver, `#!/bin/sh\ntouch ${join(outside, "diff-driver-ran")}\n`, { mode: 0o755 });
git("init", "-q", "-b", "main");
git("config", "core.fsmonitor", monitor); git("config", "diff.external", driver); git("add", "-A"); git("add", "-f", ".env"); git("commit", "-qm", "init");
writeFileSync(join(root, "a.txt"), "alpha\nbeta\nhello\nmore\n");

const PROG = {
  pwd: [[], ""], ls: [["-a", "-l", "-la", "-h", "-t", "-1", "-F", "-R", "-L"], ""], wc: [["-l", "-w", "-c", "-m"], ""], cat: [["-n", "-b", "-s", "-A", "-v"], ""],
  head: [["-n", "-c", "-5", "-q", "-f"], ""], tail: [["-n", "-c", "-5", "-q", "-f", "-F"], ""], file: [["-b", "-i", "-f", "-L", "-z"], ""],
  grep: [["-i", "-n", "-v", "-E", "-F", "-c", "-r", "-R", "-f", "-e", "-l", "-H", "-q", "-o"], ""], sort: [["-n", "-r", "-u", "-o", "-T", "-f"], ""], uniq: [["-c", "-d", "-u"], ""],
  git: [["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "blame", "--stat", "-p", "--oneline", "-n", "--output=x", "--ext-diff", "--textconv", "-a", "-D", "--name-only", "--cached", "--no-index", "-L", "--follow", "-c", "--exec-path", "-C", "--git-dir=x"], ""],
  npm: [["test", "run", "lint", "typecheck", "--silent", "-s", "--prefix", "--", "--watch", "install", "exec", "-w"], ""], pnpm: [["test", "run", "exec", "vitest", "--silent"], ""], yarn: [["test", "run", "lint"], ""],
  npx: [["vitest", "jest", "tsc", "eslint", "mocha", "--noEmit", "run", "--fix", "-p", "--root", "-t"], ""], tsc: [["--noEmit", "-p", "--outDir", "--strict", "--build", "-b"], ""],
  eslint: [["--max-warnings=0", "--quiet", "--fix", "-f", "json", "--output-file"], ""], pytest: [["-q", "-x", "-k", "-s", "--tb=short", "--rootdir=x", "-c", "-p", "--co"], ""], python3: [["-m", "pytest", "mypy", "unittest", "-c", "-q"], ""],
  ruff: [["check", "--fix", "--no-fix", "format"], ""], go: [["test", "vet", "build", "-v", "-run", "-race"], ""], cargo: [["test", "check", "clippy", "build", "--workspace", "--", "run"], ""],
  find: [["-exec", "-delete", "-name"], ""], rg: [["--hidden", "-f", "--pre", "-L"], ""], echo: [[], ""], touch: [[], ""], sed: [["-i", "-n"], ""], awk: [[], ""], xargs: [[], ""], env: [[], ""], tee: [[], ""], cp: [[], ""],
};
const OPS = ["a.txt", "sub/b.txt", "sub", ".", "..", "../outside", ".env", ".e'nv'", '.e"nv"', "./.env", "sub/../.env", "alias", "alias/secret.txt", "alias2", "'alias space'", "'alias folder/secret.txt'", '"alias folder/secret.txt"', "/etc/hosts", "~/x", "~", "HEAD", "HEAD~1", "HEAD:.env", "HEAD:a.txt", ":.env", "--", "-", "a.txt:1", "'a b'", "''", '""', "nofile", "*", "*.txt", "$HOME", "$(true)", "`true`", "x\\ y", "{a,b}", "a.txt#c", "!x", "'x", '"x', "a.txt b", "a.txt b", "a.txt\tb", "a.txt\rb", "a.txt\fb", "a.txt\vb", "a.txt\u0085b", "a.txt​b", "%1", "=x", "FOO=bar", "a=b", "(x)", "[x]", "./sub/", "sub//b.txt", "SUB/b.txt", ".ENV", "alias/../a.txt", "alias/patterns"];
const SEPS = [" ", "  ", "\t", " "];
const gen = () => {
  const names = [...Object.keys(PROG), "git", "git", "git", "git", "npx", "npx", "pnpm"];   // git and npx are where spelling matters most
  const one = () => {
    const prog = pick(names); const [flags] = PROG[prog];
    const parts = [prog]; const nf = Math.floor(rnd() * 4), no = Math.floor(rnd() * 3);
    for (let i = 0; i < nf; i++) parts.push(pick(flags));
    for (let i = 0; i < no; i++) parts.push(pick(OPS));
    for (let i = parts.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); if (rnd() < 0.3) [parts[i], parts[j]] = [parts[j], parts[i]]; }
    if (rnd() < 0.1) parts[0] = `${rnd() < 0.5 ? "'" : '"'}${parts[0]}${rnd() < 0.5 ? "'" : '"'}`;
    if (rnd() < 0.12 && typeof parts[1] === "string") { const q = pick(["'", '"']); parts[1] = q + parts[1] + q; }   // a quoted subcommand or tool name
    if (rnd() < 0.06 && typeof parts[1] === "string" && parts[1]) parts[1] = parts[1].slice(0, 1) + '""' + parts[1].slice(1);   // adjacent empty quotes inside it
    if (rnd() < 0.05) parts.splice(1, 0, pick(["''", '""', "\\", " ", "#"]));
    return parts.join(rnd() < 0.9 ? " " : pick(SEPS));
  };
  let c = one();
  if (rnd() < 0.25) c += " | " + one();
  if (rnd() < 0.05) c += " | " + one();
  if (rnd() < 0.1) c += pick([" 2>&1", " 2>&1 | tail -5", " >out", " &", " ;", " && ls", " ||ls", " <a.txt", " # c", "\n"]);
  return c;
};

const snap = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === ".git") continue; const f = join(d, e.name); const st = lstatSync(f); if (st.isSymbolicLink()) { out[f] = "L"; continue; } if (e.isDirectory()) { out[f] = "D"; walk(f); } else out[f] = createHash("sha1").update(readFileSync(f)).digest("hex"); } };
  walk(dir); return out;
};
const diff = (a, b) => { const ch = []; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) ch.push(k.replace(base, "")); return ch; };

const findings = new Map(); let admitted = 0, ran = 0;
const note = (kind, cmd, extra = "") => { const key = kind + "|" + cmd; if (!findings.has(key)) findings.set(key, { kind, cmd, extra }); };
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const cmd = gen();
  let ok = false;
  try { ok = allowedAsCheck(cmd, ["npm test"], undefined, root); } catch (e) { note("PREDICATE-THROWS", cmd, String(e).slice(0, 80)); continue; }
  if (!ok) continue;
  admitted++;
  // (a) parser differential: what does sh pass as words, versus what the table check saw
  for (const part of cmd.replace(/\s+2>&1(?=\s|$)/g, "").split("|").map((s) => s.trim())) {
    const mine = shellWords(part);
    const r = spawnSync("sh", ["-c", "printf '%s\\0' " + part], { cwd: root, encoding: "utf8", timeout: 5000 });
    const real = r.stdout.split("\0"); real.pop();
    if (JSON.stringify(mine) !== JSON.stringify(real)) note("WORD-MISMATCH", cmd, `mine=${JSON.stringify(mine)} sh=${JSON.stringify(real)}`);
  }
  // (b) behaviour: run it for real in the fixture
  const before = snap(base);
  const r = spawnSync("sh", ["-c", hardenRunnerCommand(hardenGitCommand(cmd))], { cwd: root, encoding: "utf8", timeout: 8000, env: { PATH: process.env.PATH, HOME: join(base, "home"), GIT_TERMINAL_PROMPT: "0", npm_config_registry: "http://127.0.0.1:9", npm_config_fetch_retries: "0" } });
  ran++;
  const text = (r.stdout ?? "") + (r.stderr ?? "");
  const changed = diff(before, snap(base));
  if (changed.length) note("WROTE", cmd, changed.join(","));
  if (text.includes("OUTCANARY")) note("READ-OUTSIDE", cmd);
  if (text.includes("ENVCANARY")) note(/^git\b|\| *git\b/.test(cmd) ? "SECRET-VIA-GIT-HISTORY" : "READ-SECRET-FILE", cmd);
}
console.log(`samples=${N} admitted=${admitted} executed=${ran} seconds=${Math.round((Date.now() - t0) / 1000)}`);
const byKind = {};
for (const f of findings.values()) (byKind[f.kind] ??= []).push(f);
for (const [k, list] of Object.entries(byKind)) { console.log(`\n== ${k}: ${list.length}`); for (const f of list.slice(0, 12)) console.log("  ", JSON.stringify(f.cmd), f.extra); }
rmSync(base, { recursive: true, force: true });
