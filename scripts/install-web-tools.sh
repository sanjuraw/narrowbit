#!/usr/bin/env bash
# Sets up two optional connectors for Narrowbit: a web page reader (Crawl4AI) and a browser (Playwright MCP).
# Nothing here runs unless you run it. It downloads Python packages and a Chromium browser (~300 MB) into
# ~/.narrowbit/tools/web, and registers the connectors (each call still asks for your approval in the app).
set -euo pipefail
DIR="$HOME/.narrowbit/tools/web"
mkdir -p "$DIR" "$HOME/.narrowbit/tools/browser-out"
python3 -m venv "$DIR/.venv"
"$DIR/.venv/bin/python" -m pip install -q -U pip crawl4ai
"$DIR/.venv/bin/crawl4ai-setup"
HERE="$(cd "$(dirname "$0")" && pwd)"
node "$HERE/../bin/narrowbit.js" connectors add web -- "$DIR/.venv/bin/python" "$HERE/crawl4ai_mcp.py"
node "$HERE/../bin/narrowbit.js" connectors add browser -- npx -y @playwright/mcp@latest --headless --isolated --output-dir "$HOME/.narrowbit/tools/browser-out"
echo "Done. In the app: Models & settings → Connectors → Test. The agent can now call web.read_page and the browser_* tools."
