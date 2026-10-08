# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's **Report a vulnerability** button on the
repository's Security tab (a private security advisory), not in a public issue. Include what you found,
how to reproduce it, and the version shown in the app (sidebar footer, or Models & settings > About).
If you can't use GitHub, email hello@narrowbit.dev with "security" in the subject.

## What Narrowbit does and doesn't protect

- **Local-first.** No telemetry and no repository upload. The only network traffic is to the model
  provider you choose, to GitHub for update checks, and to any connector (MCP server) you add.
- **The agent edits real files and runs commands.** The app asks before every shell command, and the
  terminal does too unless you pass `--allow-commands`. File reads and edits are confined to the
  project folder, including through symlinks, and never reach inside `.git` (git executes some of those
  files, so an edit there would be a command that bypasses approval). Files the agent reads can contain
  instructions aimed at it (prompt injection): review the diff before committing, and don't point it at
  code you don't trust with `--allow-commands`.
- **Changed scripts are called out.** If the agent edits a file that defines what a command runs
  (`package.json`, `pyproject.toml`, `Makefile`, a script the command names…), the approval for that command
  says so and is asked again even if you allowed it earlier in the task. Check the diff before allowing it.
- **Git settings from the repository.** Narrowbit's own git calls switch off the settings git would otherwise
  execute from a repository's config (`core.fsmonitor`, external diff and textconv programs). A repository
  whose own config defines a custom clean/smudge filter program (git-lfs excepted) is only opened after you
  confirm you trust it; you're asked again if those programs change. Git hooks still run when you commit,
  exactly as they do in a terminal — only commit in repositories you trust.
- **A `.narrowbit/` folder that came with the code.** Narrowbit keeps its own state (task logs, skills, memory
  notes, settings) in `.narrowbit/`, which it keeps out of git. If a repository commits one, or a folder that isn't
  a git repository has one, it came from someone else: it is only used after you confirm, and you're asked again
  when its contents change.
- **Web reader.** The optional web connector refuses private and local addresses, including through
  redirects and requests made by the page's own scripts.
- **Secrets.** API keys are stored in `~/.narrowbit/keys.json` and connector environment variables in
  `~/.narrowbit/connectors.json`, both mode 0600, and never sent to the app page. Text the agent stores
  or re-reads is redacted for known secret formats. Redaction is pattern-based and can miss unusual formats.
- **Commit checkpoint.** The app scans what it is about to commit for credentials and pauses if it finds
  any. `narrowbit audit` runs the same scan (plus gitleaks over history if installed) on demand.
- **Updates.** The update button pulls `main` from GitHub and runs `npm install` and a build. Whoever can
  push to that repository controls what runs on every installed copy: keep the repo's owners on
  two-factor authentication.
- **Connectors** run commands you configure. Only add servers you trust.

## Known limitations

These are known and not yet closed. Each one needs something you would notice doing yourself.

- **An archive unpacked over an existing git project.** Files under `.narrowbit/` that git doesn't track look the
  same as Narrowbit's own, so a downloaded archive extracted on top of a project you already use can bring task
  logs, skills or memory notes that are used without asking. Unpack downloads into a new folder, or delete their
  `.narrowbit/` first.
- **Checks run the commands your project defines.** `verify` (and `nb_verify` over MCP) runs the typecheck, lint and
  test commands in the project's settings, and a benchmark spec runs the setup commands written in it. Run them only
  on code and spec files you trust, as you would `npm test`.
- **Configuration files in subfolders.** An edit to a test-runner, bundler, linter or make configuration file
  (`vitest.config.*`, `jest.config.*`, `.yarnrc*`, `*.mk` and similar) is called out when you approve a command
  again, and a command that rewrites one at the project root ends "allow until files change". A command that
  rewrites such a file in a subfolder (for example `packages/app/vitest.config.ts`) is not noticed. Review the diff.

Narrowbit is early software. `narrowbit audit` and the built-in "Security review" skill are aids, not a
substitute for a human review of anything that handles real money or sensitive data.
