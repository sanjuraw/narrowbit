import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

/**
 * Scheduled tasks: a task you wrote, run on a schedule in one project ("run the tests every night and fix what broke").
 * A scheduled run is always unattended and always careful: it works in a separate copy of the project (so your folder is not
 * touched until you press Apply), may run only the project's own checks and read-only commands, and does nothing in a project
 * that hasn't been trusted. `narrowbit schedule run-due` is what something else calls on a timer (launchd, see plistText).
 */
export type Every = "hour" | "day" | "weekday" | "week";
export interface Schedule {
  id: string;
  name: string;
  root: string;
  task: string;
  every: Every;
  /** "HH:MM" for day, weekday and week; "MM" (minute past the hour) for hour. */
  at: string;
  /** 0 (Sunday) to 6, for "week". */
  day?: number;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastTaskId?: string;
  lastOutcome?: string;
}

const home = () => join(homedir(), ".narrowbit");
export const schedulesFile = () => join(home(), "schedules.json");
export const scheduleLogDir = () => join(home(), "schedule-logs");
const lockFile = () => join(home(), "schedules.lock");

export function loadSchedules(): Schedule[] {
  try {
    const raw = JSON.parse(readFileSync(schedulesFile(), "utf8"));
    return Array.isArray(raw?.schedules) ? raw.schedules.filter((s: any) => s && typeof s.id === "string" && typeof s.root === "string" && typeof s.task === "string") : [];
  } catch {
    return [];
  }
}

export function saveSchedules(list: Schedule[]): void {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  const tmp = `${schedulesFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ schedules: list }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, schedulesFile());
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const parseDay = (v: string): number | null => {
  const i = DAYS.indexOf(v.trim().toLowerCase().slice(0, 3));
  return i >= 0 ? i : /^[0-6]$/.test(v.trim()) ? Number(v) : null;
};

export function addSchedule(a: { name: string; root: string; task: string; every: string; at?: string; day?: string }, now = new Date()): Schedule {
  const name = a.name.trim();
  if (!name || name.length > 60) throw new Error("give the schedule a short name");
  const task = a.task.trim();
  if (!task || task.length > 2000) throw new Error("a schedule needs a task (up to 2000 characters)");
  if (!["hour", "day", "weekday", "week"].includes(a.every)) throw new Error("--every must be hour, day, weekday or week");
  const every = a.every as Every;
  let at = (a.at ?? (every === "hour" ? "00" : "02:00")).trim();
  if (every === "hour" ? !/^[0-5]?\d$/.test(at) : !/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error(every === "hour" ? "--at is the minute past the hour, like 30" : "--at is a time like 02:00");
  at = every === "hour" ? at.padStart(2, "0") : at.padStart(5, "0");
  let day: number | undefined;
  if (every === "week") {
    day = parseDay(a.day ?? "mon") ?? undefined;
    if (day === undefined) throw new Error("--day is a weekday name like mon");
  }
  if (!existsSync(join(a.root, ".narrowbit", "config.json"))) throw new Error(`${a.root} isn't set up for Narrowbit (run narrowbit init there first)`);
  const list = loadSchedules();
  if (list.some((s) => s.name === name)) throw new Error(`there is already a schedule named "${name}"`);
  // A new schedule waits for its next occurrence: with no run yet, "due" is measured from when it was created, so it does not run at once for a time that already passed today.
  const s: Schedule = { id: `sc-${randomBytes(3).toString("hex")}`, name, root: a.root, task, every, at, ...(day !== undefined ? { day } : {}), enabled: true, createdAt: now.toISOString() };
  list.push(s);
  saveSchedules(list);
  return s;
}

/** The most recent time this schedule was meant to run, at or before `now` (local time). */
export function lastOccurrence(s: Pick<Schedule, "every" | "at" | "day">, now: Date): Date {
  const d = new Date(now);
  if (s.every === "hour") {
    d.setMinutes(Number(s.at), 0, 0);
    if (d > now) d.setHours(d.getHours() - 1);
    return d;
  }
  const [h, m] = s.at.split(":").map(Number);
  d.setHours(h, m, 0, 0);
  if (d > now) d.setDate(d.getDate() - 1);
  if (s.every === "weekday") while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  if (s.every === "week") while (d.getDay() !== (s.day ?? 1)) d.setDate(d.getDate() - 1);
  return d;
}

export const isDue = (s: Schedule, now: Date): boolean => s.enabled && new Date(s.lastRunAt ?? s.createdAt) < lastOccurrence(s, now);

export function describe(s: Schedule): string {
  const when = s.every === "hour" ? `every hour at :${s.at}` : s.every === "day" ? `every day at ${s.at}` : s.every === "weekday" ? `weekdays at ${s.at}` : `every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][s.day ?? 1]} at ${s.at}`;
  return `${s.name} — ${when}${s.enabled ? "" : " (off)"}`;
}

/** One run-due at a time: a second one that starts while the first is still going leaves at once. */
function takeLock(): boolean {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  try {
    if (existsSync(lockFile()) && Date.now() - statSync(lockFile()).mtimeMs > 2 * 60 * 60_000) unlinkSync(lockFile()); // a crashed run's lock
    closeSync(openSync(lockFile(), "wx", 0o600));
    return true;
  } catch {
    return false;
  }
}
const dropLock = () => { try { unlinkSync(lockFile()); } catch { /* already gone */ } };

export interface RunOutcome { outcome: string; taskId?: string }

/** Starts the agent for one schedule: separate copy, checks and read-only commands only, a half-hour limit, everything logged. */
export function runSchedule(s: Schedule): Promise<RunOutcome> {
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "narrowbit.js");
  mkdirSync(scheduleLogDir(), { recursive: true, mode: 0o700 });
  const log = join(scheduleLogDir(), `${s.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const fd = openSync(log, "w", 0o600);
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of ["CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_EAGER_FLUSH"]) delete env[k];
    const child = spawn(process.execPath, [bin, "agent", s.task, "--isolate", "--allow-checks", "--max-steps", "25"], { cwd: s.root, env, stdio: ["ignore", fd, fd] });
    const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60_000);
    child.on("error", () => { clearTimeout(timer); closeSync(fd); resolve({ outcome: "could not start" }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      closeSync(fd);
      let text = "";
      try { text = readFileSync(log, "utf8"); } catch { /* unreadable log */ }
      const taskId = /^task: (rt-[\w-]+)/m.exec(text)?.[1];
      const outcome = /^(DONE|BLOCKED|ERROR|STOPPED|UNFINISHED)\b/m.exec(text)?.[1]?.toLowerCase() ?? (code === 0 ? "finished" : `exit ${code}`);
      resolve({ outcome, taskId });
    });
  });
}

/** Runs every schedule that is due, one after another. `run` is injectable for tests; `notify` is a best-effort desktop notice. */
export async function runDue(now = new Date(), run: (s: Schedule) => Promise<RunOutcome> = runSchedule, notify: (title: string, body: string) => void = () => {}): Promise<{ ran: string[]; skipped: string[] }> {
  const ran: string[] = [], skipped: string[] = [];
  if (!takeLock()) return { ran, skipped: ["another run-due is already working"] };
  try {
    for (const due of loadSchedules().filter((x) => isDue(x, now))) {
      // Marked as run before it starts, so a second timer tick (or a crash) can't run the same occurrence twice.
      const list = loadSchedules();
      const s = list.find((x) => x.id === due.id);
      if (!s) continue;
      s.lastRunAt = now.toISOString();
      saveSchedules(list);
      const result = await run(s);
      const after = loadSchedules();
      const t = after.find((x) => x.id === s.id);
      if (t) {
        t.lastOutcome = result.outcome;
        if (result.taskId) t.lastTaskId = result.taskId;
        saveSchedules(after);
      }
      ran.push(s.name);
      notify(`Narrowbit: ${s.name}`, `finished (${result.outcome}). Look at it in the app${result.taskId ? "; bring the changes over with Apply" : ""}.`);
    }
  } finally {
    dropLock();
  }
  return { ran, skipped };
}

/** The launchd job that calls `schedule run-due` every ten minutes. */
export function plistText(nodePath: string, binPath: string, logPath: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.narrowbit.schedule</string>
  <key>ProgramArguments</key><array><string>${esc(nodePath)}</string><string>${esc(binPath)}</string><string>schedule</string><string>run-due</string></array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${esc(logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logPath)}</string>
</dict></plist>
`;
}
