import { spawnSync } from "node:child_process";

/**
 * Finding skills on GitHub: a link to a file (blob or raw), a folder, or a whole repository. Anything
 * fetched is someone else's instructions that will later be given to the agent, so this only downloads
 * and parses — nothing is saved until the user has read it and confirms (the app shows the text in the
 * skill form; the CLI prints it). Only GitHub hosts are contacted; sizes are capped.
 */
export interface Candidate {
  /** Path in the repo, for display. */
  path: string;
  name: string;
  description: string;
  body: string;
}

const API = () => process.env.NARROWBIT_GITHUB_API ?? "https://api.github.com";
const RAW = () => process.env.NARROWBIT_GITHUB_RAW ?? "https://raw.githubusercontent.com";
const MAX_BYTES = 60_000;
const MAX_CANDIDATES = 12;

interface Ref {
  owner: string;
  repo: string;
  ref: string | null;
  path: string;
}

export function parseGithubUrl(input: string): Ref {
  let u: URL;
  try {
    u = new URL(input.trim().replace(/^github\.com\//, "https://github.com/"));
  } catch {
    throw new Error("That isn't a link. Paste a GitHub URL, for example https://github.com/owner/repo/tree/main/skills");
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (u.hostname === "raw.githubusercontent.com") {
    if (parts.length < 4) throw new Error("That raw link is missing the file path.");
    return { owner: parts[0], repo: parts[1], ref: parts[2], path: parts.slice(3).join("/") };
  }
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") throw new Error("Only github.com links are supported.");
  if (parts.length < 2) throw new Error("Paste a link to a repository, a folder or a file on GitHub.");
  const [owner, repo0, kind, ref, ...rest] = parts;
  const repo = repo0.replace(/\.git$/, "");
  if ((kind === "blob" || kind === "tree") && ref) return { owner, repo, ref, path: rest.join("/") };
  return { owner, repo, ref: null, path: "" };
}

async function getText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { accept: "application/vnd.github+json, text/plain", "user-agent": "narrowbit" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${new URL(url).pathname}`);
  const t = await r.text();
  if (t.length > MAX_BYTES * 4) throw new Error("That file is too large to be a skill.");
  return t;
}

/** A private repository: fall back to the GitHub CLI, which uses the account the user already signed in with. */
function ghApi(path: string, raw: boolean): string | null {
  const r = spawnSync("gh", ["api", ...(raw ? ["-H", "Accept: application/vnd.github.raw"] : []), path], { encoding: "utf8", timeout: 20_000 });
  return r.status === 0 ? r.stdout : null;
}

async function listDir(ref: Ref, path: string): Promise<{ name: string; type: string; path: string }[]> {
  const api = `/repos/${ref.owner}/${ref.repo}/contents/${path}${ref.ref ? `?ref=${encodeURIComponent(ref.ref)}` : ""}`;
  let text: string | null = null;
  try {
    text = await getText(API() + api);
  } catch (e) {
    text = ghApi(api, false);
    if (text === null) throw e;
  }
  const j = JSON.parse(text);
  return (Array.isArray(j) ? j : [j]).map((x: any) => ({ name: String(x.name), type: String(x.type), path: String(x.path) }));
}

async function readFile(ref: Ref, path: string): Promise<string> {
  const ref2 = ref.ref ?? "HEAD";
  try {
    return await getText(`${RAW()}/${ref.owner}/${ref.repo}/${ref2}/${path}`);
  } catch (e) {
    const t = ghApi(`/repos/${ref.owner}/${ref.repo}/contents/${path}${ref.ref ? `?ref=${encodeURIComponent(ref.ref)}` : ""}`, true);
    if (t === null) throw e;
    return t;
  }
}

export function parseSkillFile(raw: string, path: string): Candidate | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  let name = "";
  let description = "";
  let body = raw;
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const v = kv[2].trim().replace(/^["'](.*)["']$/, "$1");
      if (kv[1] === "name") name = v;
      else if (kv[1] === "description") description = v;
    }
  }
  body = body.trim().slice(0, MAX_BYTES);
  if (!body) return null;
  const fallback = path.split("/").slice(-2).join("/").replace(/(^|\/)SKILL\.md$/i, "").replace(/\.md$/i, "") || path;
  const pretty = (name || fallback.split("/").pop() || "skill").replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  return { path, name: pretty, description, body };
}

/** Everything that looks like a skill at that link. */
export async function findSkills(url: string): Promise<Candidate[]> {
  const ref = parseGithubUrl(url);
  const out: Candidate[] = [];
  const add = (c: Candidate | null) => { if (c && out.length < MAX_CANDIDATES) out.push(c); };
  if (/\.md$/i.test(ref.path)) {
    add(parseSkillFile(await readFile(ref, ref.path), ref.path));
    return out;
  }
  // A folder or repository: look here, then one level down, for SKILL.md files or a skills/ folder of them.
  const roots = ref.path ? [ref.path] : ["", "skills", ".claude/skills"];
  for (const root of roots) {
    let entries: { name: string; type: string; path: string }[];
    try {
      entries = await listDir(ref, root);
    } catch (e) {
      if (roots.length === 1) throw e;
      continue;
    }
    for (const f of entries) {
      if (f.type === "file" && /^SKILL\.md$/i.test(f.name)) add(parseSkillFile(await readFile(ref, f.path), f.path));
    }
    for (const d of entries.filter((x) => x.type === "dir" && !/^(\.git|node_modules)$/.test(x.name))) {
      if (out.length >= MAX_CANDIDATES) break;
      try {
        const inner = await listDir(ref, d.path);
        const skill = inner.find((x) => x.type === "file" && /^SKILL\.md$/i.test(x.name));
        if (skill) add(parseSkillFile(await readFile(ref, skill.path), skill.path));
        else if (/^(skills|\.claude)$/.test(d.name)) {
          for (const f of inner.filter((x) => x.type === "file" && /\.md$/i.test(x.name))) add(parseSkillFile(await readFile(ref, f.path), f.path));
        }
      } catch {
        /* unreadable folder: skip */
      }
    }
    if (out.length) break;
  }
  if (!out.length) throw new Error("No skills found there. A skill is a SKILL.md file (or a Markdown file inside a skills/ folder).");
  return out;
}
