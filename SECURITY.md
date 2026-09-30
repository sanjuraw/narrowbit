# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's **Report a vulnerability** button on the
repository's Security tab (a private security advisory), not in a public issue. Include what you found,
how to reproduce it, and the version shown in the app (sidebar footer, or Models & settings > About).

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

Narrowbit is early software. `narrowbit audit` and the built-in "Security review" skill are aids, not a
substitute for a human review of anything that handles real money or sensitive data.
