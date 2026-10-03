/**
 * The memory system's public surface — everything the agent loop (or another tool) is meant to use.
 *
 * Boundary, enforced by a test: nothing in src/memory/ imports the agent loop, the app, providers or the CLI. It may
 * use only the small shared utilities (util, redact, terms) and the settings file (config). That keeps it extractable
 * into its own package, and usable by something other than Narrowbit's own runtime (e.g. over MCP), without untangling.
 */
export * from "./notes.js";
export * from "./suggest.js";
export * from "./events.js";
export * from "./evidence.js";
export * from "./context.js";
export * from "./lifecycle.js";
export * from "./handoff.js";
