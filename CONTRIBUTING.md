# Contributing

Thanks for helping. Requires Node ≥ 22.13.

```bash
npm install
npm test          # build + unit tests (no model calls)
npm run test:ui   # jsdom checks of the app page
node bin/narrowbit.js help
```

Rules of the project:

- **Measure, don't assume.** Any feature that automatically adds text to what a model sees (memory, hints, context) needs an A/B showing equal-or-better task success per token. Everything automatic must appear in the usage ledger.
- **Local-first.** No source upload, no telemetry. Anything written to disk or shown is redacted (`src/redact.ts`).
- **Security.** Run `node bin/narrowbit.js audit --changed` before committing. Never commit real keys; deliberate fake secrets in tests carry a `narrowbit-audit-ignore` marker. Report vulnerabilities per SECURITY.md.
- **UI code** lives in a template string in `src/ui-page.ts` that the compiler does not check — add a case to `test-ui/` for any UI change.
- Match the surrounding style; comments explain *why*, sparingly.
