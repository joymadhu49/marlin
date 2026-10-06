#!/bin/bash
# One command setup for Marlin on a Mac. Safe to rerun.
#   bash install.sh            build + install the app, wire up every agent found
#   bash install.sh --agents   only (re)wire agents to an already installed app
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP=/Applications/Marlin.app
NODE="$APP/Contents/Resources/node/bin/node"
CLI="$APP/Contents/Resources/app/src/cli.js"
SKILL_SRC="$APP/Contents/Resources/app/skills/marlin-browser"
say() { printf '\033[1m%s\033[0m\n' "$*"; }

if [ "${1:-}" != "--agents" ]; then
  command -v node >/dev/null || { echo "Node 20+ is required (brew install node)"; exit 1; }
  say "Installing dependencies"
  cd "$ROOT"
  if command -v pnpm >/dev/null; then pnpm install --silent; else npm install --silent; fi
  if [ ! -x "$ROOT/chromium/chrome-mac/Chromium.app/Contents/MacOS/Chromium" ]; then
    say "Downloading Chromium"
    node src/cli.js fetch-chromium
  fi
  say "Building $APP"
  "$NODE" "$CLI" stop >/dev/null 2>&1 || true
  bash app/build-app.sh --install
fi

[ -x "$NODE" ] || { echo "$APP is not installed. Run without --agents first."; exit 1; }

say "Adding the marlin command"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/marlin" <<SH
#!/bin/bash
exec "$NODE" "$CLI" "\$@"
SH
chmod +x "$HOME/.local/bin/marlin"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "  note: add ~/.local/bin to PATH";; esac

link_skill() {
  mkdir -p "$1"
  rm -rf "$1/marlin-browser"
  ln -s "$SKILL_SRC" "$1/marlin-browser"
  echo "  skill linked in $1"
}

if command -v claude >/dev/null; then
  say "Claude Code"
  claude mcp remove marlin -s user >/dev/null 2>&1 || true
  claude mcp add marlin -s user -- "$NODE" "$CLI" mcp >/dev/null && echo "  MCP server added (user scope)"
  link_skill "$HOME/.claude/skills"
fi

if command -v codex >/dev/null; then
  say "Codex"
  codex mcp remove marlin >/dev/null 2>&1 || true
  codex mcp add marlin -- "$NODE" "$CLI" mcp >/dev/null && echo "  MCP server added"
  link_skill "$HOME/.codex/skills"
fi

if command -v hermes >/dev/null; then
  say "Hermes"
  if grep -q "^  marlin:" "$HOME/.hermes/config.yaml" 2>/dev/null; then
    echo "  MCP server already configured"
  else
    yes Y | hermes mcp add marlin --connect-timeout 30 --command "$NODE" --args "$CLI" mcp >/dev/null && echo "  MCP server added"
  fi
  link_skill "$HOME/.hermes/skills/web3"
  echo "  restart the Hermes gateway so Telegram sessions see the new tools"
fi

say "Done. Open Marlin from Applications, or let any agent start it on first use."
echo "Store a wallet password for agents with: marlin secret set metamask"
