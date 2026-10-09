import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findSecrets } from "./redact.js";
import { isSecretFile, sh, sourceText } from "./util.js";
import { INSTRUCTION_FILES, scanText } from "./guard.js";

/**
 * `narrowbit audit`: a deterministic security checkpoint that needs no model and sends nothing anywhere.
 * It looks for the mistakes that cause most real leaks in AI-written code: credentials committed or
 * about to be, secret files not ignored, and secrets given a browser-exposed env prefix. Also runs
 * gitleaks over history when it is installed. It is a floor, not a review — the built-in "Security
 * review" skill asks the agent for the judgement-based checks (auth, input handling, data flow).
 */
export interface Finding {
  severity: "high" | "medium" | "low";
  check: string;
  detail: string;
  file?: string;
}

const SECRET_FILE = /(^|\/)(\.env(\.(?!example|sample|template|dist)[\w.-]+)?|[\w.-]*\.pem|[\w.-]*\.p12|id_rsa|id_ed25519|credentials\.json|service-account[\w.-]*\.json)$/i;
const BROWSER_PREFIX = /\b(NEXT_PUBLIC_|REACT_APP_|VITE_|EXPO_PUBLIC_|NUXT_PUBLIC_|PUBLIC_)[A-Z0-9_]*(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|PASSWD|TOKEN)[A-Z0-9_]*/;
const MAX_BYTES = 1_000_000;

function textOf(root: string, file: string): string | null {
  try {
    // Not through a link: git stores a link as a link, so what it points at is not part of this repository.
    const text = sourceText(root, join(root, file), MAX_BYTES);
    return text === null || text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

/** `files` limits the scan (e.g. just what is about to be committed); default is every tracked file. */
export function auditRepo(root: string, opts: { files?: string[]; history?: boolean } = {}): Finding[] {
  const findings: Finding[] = [];
  const git = (args: string[]) => sh("git", args, root);
  const isRepo = git(["rev-parse", "--is-inside-work-tree"]).code === 0;
  const tracked = isRepo ? git(["ls-files", "-z"]).stdout.split("\0").filter(Boolean) : [];
  const files = (opts.files ?? tracked).filter((f) => !f.startsWith(".narrowbit/") && !f.startsWith("node_modules/"));

  for (const f of files) {
    if (SECRET_FILE.test(f) || isSecretFile(f)) findings.push({ severity: "high", check: "secret file", file: f, detail: `${f} looks like a credentials file and is ${opts.files ? "about to be committed" : "tracked by git"}. Remove it from git, add it to .gitignore, and rotate anything it held.` });
    const text = textOf(root, f);
    if (text === null) continue;
    const seen = new Set<string>();
    for (const s of findSecrets(text)) {
      const key = `${s.label}:${s.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ severity: s.certain ? "high" : "medium", check: "hardcoded secret", file: f, detail: `${s.certain ? "A " + s.label : "A " + s.label} on line ${s.line}. Move it to an environment variable and rotate it if it was ever pushed.` });
    }
    const exposed = text.split("\n").findIndex((l) => BROWSER_PREFIX.test(l) && !l.includes("narrowbit-audit-ignore"));
    if (exposed >= 0) findings.push({ severity: "high", check: "secret exposed to the browser", file: f, detail: `Line ${exposed + 1} gives a secret-looking variable a browser-exposed prefix (NEXT_PUBLIC_, REACT_APP_, VITE_…). Everything with that prefix is shipped to every visitor.` });
  }

  // Files an agent reads as instructions: anything in them that orders the AI around deserves a human look.
  for (const f of files.filter((x) => INSTRUCTION_FILES.includes(x) || /(^|\/)(SKILL|CLAUDE|AGENTS)\.md$/i.test(x) || /^\.(claude|codex|cursor)\/(skills|rules|commands|agents)\//.test(x))) {
    const text = textOf(root, f);
    if (text === null || text.includes("narrowbit-audit-ignore")) continue;
    for (const g of scanText(text)) findings.push({ severity: g.severity, check: `instructions aimed at an AI: ${g.check}`, file: `${f}:${g.line}`, detail: `${g.detail}. If this file is yours and the wording is deliberate, add "narrowbit-audit-ignore" to it; otherwise read it before letting an agent work here.` });
  }

  if (isRepo && !opts.files) {
    // Secret files present in the folder that git would happily commit next.
    for (const f of git(["ls-files", "--others", "--exclude-standard", "-z"]).stdout.split("\0").filter(Boolean)) {
      if (SECRET_FILE.test(f) && !f.startsWith("node_modules/")) findings.push({ severity: "high", check: "secret file not ignored", file: f, detail: `${f} is not in .gitignore, so the next "git add ." will commit it. Add it to .gitignore now.` });
    }
    if (existsSync(join(root, ".env")) && git(["check-ignore", "-q", ".env"]).code !== 0 && !findings.some((x) => x.file === ".env")) findings.push({ severity: "high", check: "secret file not ignored", file: ".env", detail: ".env exists but is not ignored by git. Add it to .gitignore." });
  }

  if (isRepo && opts.history !== false && !opts.files) {
    const g = sh("gitleaks", ["detect", "--source", ".", "--no-banner", "--redact", "--exit-code", "0", "--report-format", "json", "--report-path", "/dev/stdout"], root);
    if (g.code === 0) {
      try {
        const leaks = JSON.parse(g.stdout || "[]") as { File?: string; RuleID?: string; StartLine?: number }[];
        for (const l of leaks.slice(0, 20)) findings.push({ severity: "medium", check: "secret in git history (gitleaks)", file: l.File, detail: `${l.RuleID ?? "secret"} at line ${l.StartLine ?? "?"} in history. If it was ever pushed, rotate it; removing it from the latest commit does not remove it from history.` });
      } catch {
        // gitleaks output we can't read is not worth failing the audit over
      }
    }
  }
  return findings;
}

export function formatFindings(findings: Finding[]): string {
  if (!findings.length) return "✓ No secrets, secret files or browser-exposed secrets found.";
  const order = { high: 0, medium: 1, low: 2 };
  const rows = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  return [`${findings.filter((f) => f.severity === "high").length} high, ${findings.filter((f) => f.severity === "medium").length} medium`, ...rows.map((f) => `  [${f.severity}] ${f.check}${f.file ? ` — ${f.file}` : ""}\n        ${f.detail}`)].join("\n");
}
