#!/usr/bin/env node
// node:sqlite is stable enough for our use but still prints an ExperimentalWarning; keep CLI/MCP/hook output clean.
const emit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const msg = typeof warning === "string" ? warning : warning?.message ?? "";
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  if ((type === "ExperimentalWarning" || warning?.name === "ExperimentalWarning") && /SQLite/i.test(msg)) return;
  return emit.call(process, warning, ...rest);
};

// Output piped into `head` etc.: a closed stdout is not an error.
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const { main } = await import("../dist/cli.js");
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (err) => {
    process.stderr.write(`narrowbit: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  },
);
