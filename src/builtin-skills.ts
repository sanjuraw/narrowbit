import type { Skill } from "./skills.js";

/**
 * Skills every project starts with. Each is a standing "how" that gets prepended to the specific request
 * (the app drops it into the message box; `narrowbit agent --skill "<name>" "<task>"` applies it). Written
 * around how Narrowbit's agent works: it reads before it edits, checks its own work with `verify`, and
 * can't call something done until it has. A same-named skill saved in a project overrides the built-in.
 */
export const BUILTIN_SKILLS: Skill[] = [
  {
    name: "Bug fix",
    description: "Find the root cause, reproduce it, make the smallest fix, and prove it with the tests",
    builtin: true,
    body: `Fix the bug described below.

1. Understand before touching anything. Read the failing test, error message or report and the code path it runs through. Find the actual cause (the line or assumption that is wrong), not just where the symptom shows up.
2. Reproduce it. Run the failing test or command and confirm it fails the way described. If there is no test, write the smallest one that fails for the right reason.
3. Fix the cause with the smallest change that does it. Don't refactor nearby code, rename things or fix unrelated issues you notice; list those at the end instead.
4. If the task says tests currently fail and must pass, the fix belongs in the implementation, never in the tests.
5. Verify: run the reproduction again, then the wider test suite and type check. If something else broke, fix that or undo your change and say why.

Finish with: the root cause in a sentence or two, what you changed and why, how you verified it, and anything you noticed but left alone.`,
  },
  {
    name: "Code review",
    description: "Review a change for bugs, security, missing tests and maintainability, without changing anything",
    builtin: true,
    body: `Review the change described below. If none is named, review the uncommitted changes (run git status and git diff). Read the code around the change, not just the changed lines, and grep for callers of anything whose behaviour changed. Change nothing.

Look for, in this order:
1. Correctness: wrong logic, off-by-one errors, unhandled empty, null or error cases, races, callers that the change breaks.
2. Security: secrets, injection, missing authorisation checks, unsafe handling of user input.
3. Behaviour changes nobody mentioned, and missing or weak tests for the change.
4. Maintainability, but only what will really cause trouble (misleading names, duplicated logic, dead code). Skip style preferences.

Report a one-line verdict (ship / ship after fixes / needs rework), then findings grouped as must fix, should fix and nit. Give each a file and line, why it matters and a concrete suggestion. Say what you checked and found fine. Don't invent problems to have something to say; if the change is good, say so.`,
  },
  {
    name: "Write tests",
    description: "Add tests in the project's own style, covering the normal path, edge cases and errors",
    builtin: true,
    body: `Write tests for the code named below.

1. Read the code and any existing tests first. Use the project's test framework, file layout, naming and style, and find the command that runs them.
2. Test behaviour, not implementation: call the public function or endpoint with real inputs and check the outputs. Cover the normal path, the edge cases (empty, zero, boundaries, very large) and the error paths.
3. One behaviour per test, named for it, independent of the others. Don't depend on real network, the current time or randomness; fix or fake those.
4. Run them, and make sure they pass. For the important ones, confirm the test can actually fail: break the code briefly (or reason exactly why it would fail), then restore it, so nothing passes vacuously.
5. Don't change the code under test to make a test pass. If you find a bug, report it, or add a clearly marked failing test, instead of quietly fixing it.

Finish with what is covered, what is not, and the command to run the tests.`,
  },
  {
    name: "Refactor",
    description: "Restructure code without changing what it does, one small verified step at a time",
    builtin: true,
    body: `Refactor the code named below without changing what it does.

1. Pin the behaviour first. Run the existing tests. If this area has none, write tests that capture how it behaves today before changing anything.
2. Work in small steps (rename, extract, move, simplify) and run the tests after each one.
3. Don't mix in behaviour changes, new features or unrelated cleanup.
4. Update every caller (grep for usages) and remove code that becomes dead.

Finish with the tests and type check passing, and a short summary of what moved and why the result is clearer.`,
  },
  {
    name: "Explain this code",
    description: "Read-only walkthrough of how a part of the project works, with file and line references",
    builtin: true,
    body: `Explain how the part of the project named below works. This is read-only: read the files, change nothing, and don't run experiments. Reading is enough, so stop reading as soon as you can explain it (usually a handful of files, not the whole project).

Your final message IS the explanation, so write all of it there. Start with what the code is for and where it sits in the project, then trace the main path step by step (entry point, what calls what, where data is read and written). Refer to files and line numbers so I can follow along. Point out the non-obvious parts: hidden assumptions, surprising behaviour, and anything that looks fragile or wrong. Say plainly what you did not read or are unsure about instead of guessing.`,
  },
  {
    name: "Plan a project",
    description: "Turn an idea into a short plan: who it is for, the riskiest assumptions, phases, and a cheap test for each risk",
    builtin: true,
    body: `Help plan the idea described below. Talk it through; change no files.

1. Pin down what you can't assume. Ask at most three questions, only the ones that would change the plan: who it is for, what they would pay or do, and the person's budget, time and skills. If the message already answers them, don't ask.
2. Say what you are assuming, in two or three lines, so the person can correct you.
3. List the five biggest risks for this idea (not generic ones), and for each one a cheap way to test it in days, not months. Put the test that could kill the idea first.
4. Give a phased plan: what to build first, what to leave out, and how the person will know each phase worked.
5. Use what you can reach. If a link was pasted or a search tool is available, check the facts that matter (prices, competitors, rules) and say where each came from. Mark anything from memory as such.

Finish with the plan in under a page, the three decisions the person has to make next, and, when something was clearly settled, a "NOTE (decision): ..." line for it.`,
  },
  {
    name: "Research a repository",
    description: "Read a repository properly and report what it is and how it works, naming the files read and what could not be read",
    builtin: true,
    body: `Research the repository named below and report what it is and how it works. Read only; change nothing.

1. Start from the README and the manifest (package.json, pyproject.toml or similar), then the folder listing. Say what the project is for in a sentence.
2. Find the entry points (main files, the command line, the server start) and follow one real path through the code from entry to result.
3. Read the files that answer the question asked, not just their names. Open the tests and the docs folder when they exist; they say what the authors consider important.
4. Don't guess. If a file was too large to read fully, was cut off, or can't be opened, say so, and say what that leaves unknown.

Finish with: what it is, how the main path works (with file names), the parts that matter for the question asked, and a plain list of the files you read and the ones you did not.`,
  },
  {
    name: "Add a feature",
    description: "Add a feature by copying how the project already does something similar, with tests, then run the checks",
    builtin: true,
    body: `Add the feature described below.

1. Find the nearest thing the project already does (a similar command, page, endpoint or option) and read it end to end: where it is declared, where it is handled, how it is tested. Copy its pattern and naming rather than inventing a new one.
2. If the request is unclear in a way that changes what you build, ask one short question first; otherwise state your assumption and go on.
3. Make the smallest change that delivers the feature. Don't add settings, layers or options nobody asked for, and don't touch unrelated code.
4. Write the tests in the project's own style: the main use, one edge case, and one failure. Confirm a new test fails without your change.
5. Run the project's tests and type check, and fix what you broke. Update the README or docs if the feature is something people will use.

Finish with: what you added and where, the pattern you followed, how you checked it, and anything you chose not to do.`,
  },
  {
    name: "Fix a failing CI run",
    description: "Read the failing CI log, reproduce the failure locally, fix the real cause, and say what could not be reproduced",
    builtin: true,
    body: `Fix the failing automated check (CI) described below. If no run is named, look at the most recent failed run on this branch (for GitHub: gh run list, then gh run view --log-failed); if you can't reach it, ask for the log.

1. Read the failing step's log and find the first real error, not the noise after it. Note the operating system, the tool versions and any environment difference from this machine.
2. Reproduce it here. Run the same command the CI runs. If it passes here, the difference is the environment (another operating system, missing tool, timing, a file that is only on your machine): find that difference instead of guessing.
3. Fix the cause. Don't skip, loosen or delete the failing check, and don't add a retry unless the failure is truly flaky, and then say so.
4. Run the project's checks again, and then say what remains unproven (for example: it can only be confirmed by the next CI run).

Finish with: the first error line, the cause in a sentence, what you changed, what you ran to check it, and whether it needs a CI run to be sure.`,
  },
  {
    name: "Write a pull request",
    description: "Write a clear pull request title and description (and commit message) from the actual change",
    builtin: true,
    body: `Write the pull request text for the change described below. If none is named, use the uncommitted changes or the commits since the base branch (git diff, git log). Don't commit or push anything.

1. Read the whole diff first, including the tests, so you describe what changed and not what the branch is called.
2. Title: one line, in plain words, saying what a user or developer will notice. No ticket-speak.
3. Description, short: why the change is needed, what it does, how it was checked (the commands you ran and their result), and anything the reviewer should look at closely or that was left out on purpose.
4. Call out user-visible changes and anything risky (migrations, config, changed defaults) on their own lines.
5. Also give the commit message in the same plain style, if it hasn't been committed yet.

Finish with the title and description, ready to paste. Don't claim a test passed unless you ran it.`,
  },
  {
    name: "Update dependencies",
    description: "Update packages one at a time, run the checks after each, and keep only the updates that pass",
    builtin: true,
    body: `Update the project's dependencies as described below. If no package is named, find what is outdated (npm outdated, pip list --outdated or the project's equivalent) and work through it.

1. Run the tests and type check first so you know the starting state. If they already fail, say so and stop here.
2. Update one package at a time (group only packages that must move together). Read its changelog for breaking changes before a major version.
3. After each update, run the install, the type check and the tests. If something breaks, fix the code if the fix is small and obvious; otherwise undo that update and note why.
4. Never update everything at once, never edit a lockfile by hand, and don't add new packages.
5. Check the security warnings (npm audit or the equivalent) before and after, and report the difference.

Finish with: what was updated (old to new version), what was left and why, the check results, and any breaking change a person should know about.`,
  },
  {
    name: "Write documentation",
    description: "Write or fix a README or doc from the code itself, and say what could not be verified",
    builtin: true,
    body: `Write or fix the documentation described below. If none is named, check whether the README matches the code.

1. Read the code and the current docs side by side. The code is the truth: find places where the docs are wrong, out of date or missing something people need first (what it is, how to install it, how to run it, one real example).
2. Run what you document: the install steps, the commands and the examples. If a step fails or can't be run here, don't write it as if it works; mark it or ask.
3. Write for someone who has never seen the project: plain words, short sentences, the most useful thing first, an example before a reference table. Keep the existing tone and structure unless it is the problem.
4. Don't invent features, options or numbers. Every claim should be something you saw in the code or ran.
5. Make only the changes the request needs; don't rewrite sections that are fine.

Finish with: what you changed, what you checked by running it, and what you could not verify.`,
  },
];
