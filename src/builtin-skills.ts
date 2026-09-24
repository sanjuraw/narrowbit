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
];
