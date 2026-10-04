/**
 * What "Allow for this task" remembers, shared by the terminal and the app so they cannot disagree.
 *
 * A remembered allowance covers the exact command, but a command runs code the agent can change: after you allow `npm test`,
 * an edited test or source file is what `npm test` would run next. So by default an allowance ends the moment the agent
 * has edited a file; the next run is asked about again, and the prompt lists the files that changed since you allowed it.
 * "For the whole task" is the explicit opt-out, for someone who trusts the agent with the task. A change to a file that
 * defines what a command does (package.json, a Makefile, …) always asks, whatever was chosen (runtime.ts scriptWarning).
 * A connector call is keyed to the exact call and arguments, so edits to files don't change what it will do.
 */
export interface Grant {
  /** The whole-task choice: keeps covering the command after edits. */
  always: boolean;
  /** How many edits the agent had made when this was allowed. */
  editLen: number;
}

export function covered(grant: Grant | undefined, warning: string | undefined, key: string | undefined, edits: readonly string[]): boolean {
  if (!grant || warning) return false;
  if (key) return true;
  return grant.always || edits.length === grant.editLen;
}

/** The files edited after the grant was made, each once, in the order they were first edited since. */
export function editsSince(grant: Grant, edits: readonly string[]): string[] {
  return [...new Set(edits.slice(grant.editLen))];
}
