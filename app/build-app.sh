#!/bin/bash
# Assembles Marlin.app: the Chromium bundle rebranded, plus the agent daemon,
# its node_modules, a Node runtime and the Sparkle updater helper.
#   bash app/build-app.sh             ad hoc signed dev build in dist/
#   bash app/build-app.sh --install   same, then copy to /Applications
# Release signing, notarization and the DMG live in scripts/release.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_APP="$ROOT/chromium/chrome-mac/Chromium.app"
OUT="$ROOT/dist/Marlin.app"
SPARKLE="$ROOT/vendor/sparkle"
FEED_URL="https://github.com/joymadhu49/marlin/releases/latest/download/appcast.xml"
SU_PUBLIC_KEY="Vzdd6fx46YsZwt3iKavazKGu95aBqMUf3rwglxS/JtI="
[ -d "$SRC_APP" ] || { echo "Run: node src/cli.js fetch-chromium"; exit 1; }
[ -d "$SPARKLE/Sparkle.framework" ] || bash "$ROOT/scripts/fetch-sparkle.sh"

VERSION="$(node -p "require('$ROOT/package.json').version")"
# Sparkle compares CFBundleVersion: 0.2.0 -> 200, 1.4.12 -> 10412.
BUILD="$(node -p "'$VERSION'.split('.').reduce((n, x, i) => n + Number(x) * [10000, 100, 1][i], 0)")"

rm -rf "$OUT" "$ROOT/dist/build" && mkdir -p "$ROOT/dist/build"
cp -R "$SRC_APP" "$OUT"
C="$OUT/Contents"
PB=/usr/libexec/PlistBuddy
plist() { $PB -c "Set :$1 $3" "$C/Info.plist" 2>/dev/null || $PB -c "Add :$1 $2 $3" "$C/Info.plist"; }

# Identity and branding. CFBundleShortVersionString stays Chromium's: its
# "relaunch to update" check compares against it.
plist CFBundleName string Marlin
plist CFBundleDisplayName string Marlin
plist CFBundleExecutable string Marlin
plist CFBundleIdentifier string xyz.marlin.browser
plist CFBundleVersion string "$BUILD"
plist MarlinVersion string "$VERSION"
plist SUFeedURL string "$FEED_URL"
plist SUPublicEDKey string "$SU_PUBLIC_KEY"
plist SUEnableAutomaticChecks bool false
$PB -c "Delete :CFBundleIconName" "$C/Info.plist" 2>/dev/null || true
plist CFBundleIconFile string app.icns
rm -f "$C/Resources/Assets.car"

ICONSET="$ROOT/dist/build/marlin.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  rsvg-convert -w $s -h $s "$ROOT/app/icon.svg" -o "$ICONSET/icon_${s}x${s}.png"
  rsvg-convert -w $((s*2)) -h $((s*2)) "$ROOT/app/icon.svg" -o "$ICONSET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$C/Resources/app.icns"

# Agent daemon + runtime (production dependencies only).
mkdir -p "$C/Resources/app" "$C/Resources/node/bin"
rsync -a --exclude /chromium --exclude /dist --exclude /test --exclude /.keys --exclude /.git \
  --exclude /vendor --exclude /updater --exclude /node_modules "$ROOT/" "$C/Resources/app/"
(cd "$C/Resources/app" && pnpm install --prod --frozen-lockfile --silent --config.node-linker=hoisted >/dev/null)
cp "$(node -p 'process.execPath')" "$C/Resources/node/bin/node"

# Sparkle updater helper.
H="$C/Helpers/Marlin Updater.app/Contents"
mkdir -p "$H/MacOS" "$H/Frameworks"
swiftc -O -target arm64-apple-macos13 -F "$SPARKLE" -framework Sparkle \
  -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  "$ROOT/updater/main.swift" -o "$H/MacOS/Marlin Updater"
cp -R "$SPARKLE/Sparkle.framework" "$H/Frameworks/"
cat > "$H/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Marlin Updater</string>
  <key>CFBundleIdentifier</key><string>xyz.marlin.updater</string>
  <key>CFBundleName</key><string>Marlin Updater</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PL

cat > "$C/MacOS/Marlin" <<'SH'
#!/bin/bash
# Marlin launcher: start the agent daemon, which launches Chromium from this bundle.
C="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$C/Resources/node/bin/node"
CLI="$C/Resources/app/src/cli.js"
mkdir -p "$HOME/Library/Application Support/Marlin"
LOG="$HOME/Library/Application Support/Marlin/marlin.log"
if "$NODE" "$CLI" status 2>/dev/null | grep -q '^Running'; then
  exec "$NODE" "$CLI" open
fi
exec "$NODE" "$CLI" start >> "$LOG" 2>&1
SH
chmod +x "$C/MacOS/Marlin"

if [ "${MARLIN_SIGN:-adhoc}" = "adhoc" ]; then
  codesign --force --deep --sign - "$OUT" 2>/dev/null
fi
xattr -dr com.apple.quarantine "$OUT" 2>/dev/null || true
echo "Built $OUT v$VERSION ($BUILD), $(du -sh "$OUT" | cut -f1)"

if [ "${1:-}" = "--install" ]; then
  "$C/Resources/node/bin/node" "$C/Resources/app/src/cli.js" stop >/dev/null 2>&1 || true
  rm -rf /Applications/Marlin.app
  ditto "$OUT" /Applications/Marlin.app
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Marlin.app
  echo "Installed /Applications/Marlin.app"
fi
