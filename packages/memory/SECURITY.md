# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's **Report a vulnerability** button on this
repository's Security tab (a private security advisory), not in a public issue. Include what you found and
how to reproduce it. If you can't use GitHub, email hello@narrowbit.dev with "security" in the subject.

## What this package does and doesn't protect

narrowbit-memory is a local library and MCP server: it makes no model calls and sends nothing anywhere.

- Notes are plain Markdown under `<project>/.narrowbit/memory/`. Everything written passes through a
  pattern-based secret scrubber first. It is best effort: it catches known token shapes and labelled
  credentials, but an unlabelled opaque string cannot be recognised.
- The project's own notes folder is never read or written through symbolic or hard links (extra note folders you list yourself may use links).
- The MCP server reads and writes only that notes folder. Anything an agent saves is stored as given
  (after scrubbing) and shown back to agents later, so treat notes as untrusted text, not instructions.

The full threat model, known limitations and the audit history of the shared code live in the main
repository: [sanjuraw/narrowbit](https://github.com/sanjuraw/narrowbit/blob/main/SECURITY.md).
