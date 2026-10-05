/**
 * narrowbit-memory's public surface — everything an agent loop or another tool is meant to use: notes (save, recall,
 * staleness), the per-task event log and its hand-over summary, secret scrubbing, and an MCP server (see server.ts).
 *
 * Boundary, enforced by a test: this package imports nothing outside itself except node: modules, so it can be used,
 * published and benchmarked on its own.
 */
export * from "./paths.js";
export * from "./safefs.js";
export * from "./util.js";
export * from "./redact.js";
export * from "./terms.js";
export * from "./notes.js";
export * from "./suggest.js";
export * from "./events.js";
export * from "./evidence.js";
export * from "./fork.js";
export * from "./context.js";
export * from "./lifecycle.js";
export * from "./handoff.js";
export * from "./server.js";
