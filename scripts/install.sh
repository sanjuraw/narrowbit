#!/usr/bin/env bash
# Installs Narrowbit on a Mac: checks the prerequisites, offers to install what's missing, clones the
# repo, builds it, puts `narrowbit` on your PATH and builds the native app. Safe to re-run.
#
#   scripts/install.sh [--check] [--yes] [--dir <folder>] [--skip-link] [--skip-app]
#
#   --check       only report what's installed and what's missing; change nothing
#   --yes         answer "yes" to every install question (still can't do sign-ins or admin passwords for you)
#   --dir         where to keep Narrowbit (default: ~/Narrowbit)
#   --skip-link   don't run `npm link` (leaves the global `narrowbit` command alone)
#   --skip-app    don't build the macOS app
set -euo pipefail

REPO_URL="${NARROWBIT_REPO:-https://github.com/sanjuraw/narrowbit.git}"
DIR="$HOME/Narrowbit"
CHECK=0 YES=0 LINK=1 APP=1
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --yes) YES=1 ;;
    --dir) DIR="$2"; shift ;;
    --skip-link) LINK=0 ;;
    --skip-app) APP=0 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
ask() { # ask "question" -> returns 0 for yes
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  printf '  %s [y/N] ' "$1"; read -r a; [ "$a" = y ] || [ "$a" = Y ]
}
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
}

[ "$(uname -s)" = Darwin ] || { echo "Narrowbit's app is macOS-only (the CLI needs Node 22.13+ on any OS)." >&2; }

say "Checking prerequisites"
MISSING=()
if xcode-select -p >/dev/null 2>&1; then ok "Xcode Command Line Tools (git, Swift)"; else bad "Xcode Command Line Tools"; MISSING+=(clt); fi
if node_ok; then ok "Node $(node -v) (needs 22.13+)"; else bad "Node 22.13 or newer"; MISSING+=(node); fi
if command -v git >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1; then ok "git"; else bad "git (comes with the Command Line Tools)"; fi
command -v claude >/dev/null 2>&1 && ok "Claude Code CLI" || echo "  - Claude Code CLI not found (optional: Codex, a local model or a free API key also work)"
command -v codex >/dev/null 2>&1 && ok "Codex CLI" || echo "  - Codex CLI not found (optional)"
command -v brew >/dev/null 2>&1 && ok "Homebrew" || echo "  - Homebrew not found (only needed to install Node)"

if [ "$CHECK" = 1 ]; then
  [ "${#MISSING[@]}" -eq 0 ] && say "Ready to install." || say "Missing: ${MISSING[*]}"
  exit 0
fi

if printf '%s\n' "${MISSING[@]:-}" | grep -qx clt; then
  say "Xcode Command Line Tools"
  echo "  macOS will open an install dialog. Click Install, wait for it to finish, then re-run this script."
  xcode-select --install || true
  exit 1
fi

if ! node_ok; then
  say "Node 22.13+"
  if ! command -v brew >/dev/null 2>&1; then
    if ask "Install Homebrew (needs your password and takes a few minutes)?"; then
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
      [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
    else
      echo "  Install Node 22.13+ yourself (https://nodejs.org), then re-run." >&2; exit 1
    fi
  fi
  if ask "Install Node with Homebrew (brew install node)?"; then brew install node; else echo "  Node is required." >&2; exit 1; fi
  node_ok || { echo "  Node is still older than 22.13 — run: brew upgrade node" >&2; exit 1; }
fi

say "Getting Narrowbit into $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only || { echo "  Couldn't update the existing copy (local changes?). Fix or move $DIR and re-run." >&2; exit 1; }
else
  if ! GIT_TERMINAL_PROMPT=0 git clone "$REPO_URL" "$DIR"; then
    cat >&2 <<EOF

  Couldn't clone $REPO_URL.
  If the repository is private, ask its owner to add your GitHub account, then sign in with:
      brew install gh && gh auth login
  and re-run this script.
EOF
    exit 1
  fi
fi

cd "$DIR"
say "Installing and building"
npm install --no-audit --no-fund
npm run build

if [ "$LINK" = 1 ]; then
  say "Putting the narrowbit command on your PATH"
  npm link || { echo "  npm link needs write access to npm's global folder. Set an npm prefix in your home folder instead (npm config set prefix ~/.npm-global, then put ~/.npm-global/bin on your PATH). Avoid sudo: npm link runs this project's build scripts as root" >&2; exit 1; }
fi

if [ "$APP" = 1 ]; then
  say "Building the macOS app"
  scripts/build-mac-app.sh --install
fi

say "Done. What's ready to use:"
node bin/narrowbit.js doctor || true
echo
echo "  Open the app: open ~/Applications/Narrowbit.app   (or run: narrowbit ui)"
echo "  Nothing above ready? Sign in to Claude with:  claude auth login   — the app's setup card will guide you too."
echo "  Updates: the app shows an 'Update available' banner when GitHub has something new."
