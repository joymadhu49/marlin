#!/bin/bash
# Installs or updates Marlin from the latest GitHub release, then wires it into
# Claude Code, Codex and Hermes. Never opens Finder windows.
#   curl -fsSL https://raw.githubusercontent.com/joymadhu49/marlin/main/scripts/get-marlin.sh | bash
set -euo pipefail
REPO="joymadhu49/marlin"
[ "$(uname)" = "Darwin" ] || { echo "Marlin currently runs on macOS only."; exit 1; }
URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
[ -n "$URL" ] || { echo "No release found for $REPO"; exit 1; }
TMP="$(mktemp -d)"
echo "Downloading $URL"
curl -fL --progress-bar "$URL" -o "$TMP/Marlin.dmg"
MNT="$(hdiutil attach -nobrowse -noautoopen -readonly "$TMP/Marlin.dmg" | grep -o '/Volumes/.*' | head -1)"
APP=/Applications/Marlin.app
if [ -x "$APP/Contents/Resources/node/bin/node" ]; then "$APP/Contents/Resources/node/bin/node" "$APP/Contents/Resources/app/src/cli.js" stop >/dev/null 2>&1 || true; fi
rm -rf "$APP"
ditto "$MNT/Marlin.app" "$APP"
hdiutil detach "$MNT" -quiet || true
rm -rf "$TMP"
echo "Installed $APP"
bash "$APP/Contents/Resources/app/install.sh" --agents
