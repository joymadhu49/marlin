#!/bin/bash
# Builds, signs, notarizes and publishes a Marlin release with a Sparkle appcast.
#   1. bump "version" in package.json and add a section to CHANGELOG.md
#   2. bash scripts/release.sh            (add --chromium to pull the newest Chromium first)
# Needs: Developer ID cert, a notarytool keychain profile (MARLIN_NOTARY_PROFILE,
# default sirocco-notary), the Sparkle key in the Keychain (account "marlin"), gh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REPO="joymadhu49/marlin"
PROFILE="${MARLIN_NOTARY_PROFILE:-sirocco-notary}"
VERSION="$(node -p "require('./package.json').version")"
BUILD="$(node -p "'$VERSION'.split('.').reduce((n, x, i) => n + Number(x) * [10000, 100, 1][i], 0)")"
DMG="dist/Marlin-$VERSION.dmg"
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

gh release view "v$VERSION" -R "$REPO" >/dev/null 2>&1 && { echo "v$VERSION is already released. Bump package.json first."; exit 1; }
grep -q "^## $VERSION" CHANGELOG.md || { echo "Add a '## $VERSION' section to CHANGELOG.md"; exit 1; }
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 || { echo "notarytool profile '$PROFILE' missing"; exit 1; }

if [ "${1:-}" = "--chromium" ]; then step "Updating Chromium"; node src/cli.js fetch-chromium; fi

step "Building Marlin $VERSION ($BUILD)"
MARLIN_SIGN=none bash app/build-app.sh

step "Signing"
bash scripts/sign.sh dist/Marlin.app

notarize() {
  local target="$1" submit="$1"
  if [ -d "$target" ]; then submit="dist/build/notarize.zip"; rm -f "$submit"; ditto -c -k --keepParent "$target" "$submit"; fi
  xcrun notarytool submit "$submit" --keychain-profile "$PROFILE" --wait | tee dist/build/notary.log
  grep -q "status: Accepted" dist/build/notary.log || { echo "Notarization failed"; exit 1; }
  xcrun stapler staple "$target"
}
step "Notarizing the app"
notarize dist/Marlin.app

step "Building the DMG"
STAGE="dist/build/dmg"; rm -rf "$STAGE" "$DMG"; mkdir -p "$STAGE"
ditto dist/Marlin.app "$STAGE/Marlin.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Marlin $VERSION" -srcfolder "$STAGE" -ov -format UDZO -imagekey zlib-level=9 "$DMG" >/dev/null
codesign --force --timestamp --sign "${MARLIN_SIGN_ID:-Developer ID Application: Joy Madhu (CJZMYQN8V6)}" "$DMG"

step "Notarizing the DMG"
notarize "$DMG"
xcrun stapler validate "$DMG"

step "Signing the update feed"
SIG="$(vendor/sparkle/bin/sign_update --account marlin "$DMG")"
NOTES="$(awk -v v="## $VERSION" '$0 ~ "^## " { p = ($0 == v || index($0, v" ") == 1) ; next } p' CHANGELOG.md | sed 's/^- /<li>/; s/$/<\/li>/' | grep '<li>' || true)"
CHROMIUM="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' dist/Marlin.app/Contents/Info.plist)"
cat > dist/appcast.xml <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Marlin</title>
    <link>https://github.com/$REPO</link>
    <item>
      <title>Marlin $VERSION</title>
      <pubDate>$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>
      <sparkle:version>$BUILD</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <description><![CDATA[<h2>Marlin $VERSION</h2><p>Chromium $CHROMIUM</p><ul>$NOTES</ul>]]></description>
      <enclosure url="https://github.com/$REPO/releases/download/v$VERSION/Marlin-$VERSION.dmg" $SIG type="application/octet-stream"/>
    </item>
  </channel>
</rss>
XML

step "Publishing v$VERSION"
awk -v v="## $VERSION" '$0 ~ "^## " { p = ($0 == v || index($0, v" ") == 1); next } p' CHANGELOG.md > dist/build/notes.md
printf '\n\nChromium %s. Signed and notarized; updates install through Sparkle.\n\nInstall for humans: open the DMG and drag Marlin to Applications.\nInstall for agents: `curl -fsSL https://raw.githubusercontent.com/%s/main/scripts/get-marlin.sh | bash`\n' "$CHROMIUM" "$REPO" >> dist/build/notes.md
gh release create "v$VERSION" "$DMG" dist/appcast.xml -R "$REPO" --title "Marlin $VERSION" --notes-file dist/build/notes.md
echo "Released: https://github.com/$REPO/releases/tag/v$VERSION"
