// Writes dist/version.json at build time so the app can show which version is running even when it
// can't run git (e.g. an install owned by another macOS account).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let commit = "";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  // not a git checkout
}
mkdirSync("dist", { recursive: true });
writeFileSync("dist/version.json", JSON.stringify({ version: pkg.version, commit, builtAt: new Date().toISOString() }) + "\n");
