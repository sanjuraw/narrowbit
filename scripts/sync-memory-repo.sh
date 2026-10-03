#!/usr/bin/env bash
# Mirrors packages/memory to the narrowbit-memory repo (the harness repo stays the source of truth).
set -euo pipefail
cd "$(dirname "$0")/.."
git subtree split --prefix=packages/memory -b memory-split >/dev/null
git push --force-with-lease https://github.com/sanjuraw/narrowbit-memory.git memory-split:main
git branch -D memory-split >/dev/null
