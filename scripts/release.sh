#!/bin/bash
# Builds, signs, notarizes and publishes a Marlin release with a Sparkle appcast.
#   1. bump "version" in package.json and add a section to CHANGELOG.md
#   2. bash scripts/release.sh            (add --chromium to pull the newest Chromium first)
# Use --prepare-only to produce verified artifacts without publishing to GitHub.
# Needs: Developer ID cert, a notarytool keychain profile (MARLIN_NOTARY_PROFILE,
# default sirocco-notary), the Sparkle key in the Keychain (account "marlin"), gh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/build-common.sh"
PREPARE_ONLY=false
FETCH_CHROMIUM=false
for argument in "$@"; do
  case "$argument" in
    --prepare-only) PREPARE_ONLY=true ;;
    --chromium) FETCH_CHROMIUM=true ;;
    *) echo "Unknown option: $argument. Supported: --prepare-only --chromium" >&2; exit 1 ;;
  esac
done
REPO="joymadhu49/marlin"
PROFILE="${MARLIN_NOTARY_PROFILE:-sirocco-notary}"
VERSION="$(node -p "require('./package.json').version")"
BUILD="$(macos_build_number "$VERSION")"
DMG="dist/Marlin-$VERSION.dmg"
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
SOURCE="$(git rev-parse --verify HEAD)"
verify_source() {
  [ "$(git rev-parse --verify HEAD)" = "$SOURCE" ] && [ -z "$(git status --porcelain --untracked-files=all)" ] || {
    echo "Release source must be a clean checkout and remain at $SOURCE throughout the build." >&2
    exit 1
  }
}
verify_unused_tag() {
  local existing
  # --target does not override an existing tag. Refuse one rather than publishing
  # artifacts built from a different commit under an unrelated source tag.
  existing="$(git ls-remote --tags "https://github.com/$REPO.git" "refs/tags/v$VERSION" "refs/tags/v$VERSION^{}")"
  [ -z "$existing" ] || { echo "Tag v$VERSION already exists; choose a new release version." >&2; exit 1; }
}
verify_source

if ! "$PREPARE_ONLY"; then
  gh release view "v$VERSION" -R "$REPO" >/dev/null 2>&1 && { echo "v$VERSION is already released. Bump package.json first."; exit 1; }
  verify_unused_tag
fi
awk -v version="$VERSION" '$1 == "##" && $2 == version { found = 1 } END { exit !found }' CHANGELOG.md || { echo "Add a '## $VERSION' section to CHANGELOG.md"; exit 1; }
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null || { echo "Cannot access notarytool profile '$PROFILE'; unlock the keychain and verify the profile." >&2; exit 1; }
IDENTITY="${MARLIN_SIGN_ID:-Developer ID Application: Joy Madhu (CJZMYQN8V6)}"
security find-identity -v -p codesigning | grep -Fq "$IDENTITY" || { echo "No valid signing identity available: $IDENTITY. Unlock the keychain or restore the identity and private key." >&2; exit 1; }
[ -x vendor/sparkle/bin/generate_keys ] || bash scripts/fetch-sparkle.sh
PUBLIC_KEY="$(vendor/sparkle/bin/generate_keys --account marlin -p)" || { echo "Cannot access the existing Sparkle signing key for account marlin." >&2; exit 1; }
[ "$PUBLIC_KEY" = "$MARLIN_SPARKLE_PUBLIC_KEY" ] || { echo "Sparkle signing key does not match existing Marlin installations. Restore the original key before releasing." >&2; exit 1; }

if "$FETCH_CHROMIUM"; then step "Updating Chromium"; node src/cli.js fetch-chromium; fi

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
codesign --verify --deep --strict dist/Marlin.app
xcrun stapler validate dist/Marlin.app
spctl --assess --type execute dist/Marlin.app

step "Building the DMG"
STAGE="dist/build/dmg"; rm -rf "$STAGE" "$DMG"; mkdir -p "$STAGE"
ditto dist/Marlin.app "$STAGE/Marlin.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Marlin $VERSION" -srcfolder "$STAGE" -ov -format UDZO -imagekey zlib-level=9 "$DMG" >/dev/null
codesign --force --timestamp --sign "${MARLIN_SIGN_ID:-Developer ID Application: Joy Madhu (CJZMYQN8V6)}" "$DMG"

step "Notarizing the DMG"
notarize "$DMG"
codesign --verify --strict "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature "$DMG"

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

step "Preparing release notes and checksums"
awk -v v="## $VERSION" '$0 ~ "^## " { p = ($0 == v || index($0, v" ") == 1); next } p' CHANGELOG.md > dist/build/notes.md
printf '\n\nmacOS 13 or later, Apple Silicon (arm64). Chromium %s. Signed and notarized; updates install through Sparkle.\n\nInstall for humans: open the DMG and drag Marlin to Applications.\nInstall for agents: `curl -fsSL https://raw.githubusercontent.com/%s/main/scripts/get-marlin.sh | bash`\n' "$CHROMIUM" "$REPO" >> dist/build/notes.md
printf '\nSource commit: `%s`\n' "$SOURCE" >> dist/build/notes.md
(cd dist && shasum -a 256 "Marlin-$VERSION.dmg" appcast.xml > SHA256SUMS-macos.txt)
verify_source
if "$PREPARE_ONLY"; then
  echo "Prepared: $ROOT/$DMG, $ROOT/dist/appcast.xml, $ROOT/dist/SHA256SUMS-macos.txt"
  echo "Release notes: $ROOT/dist/build/notes.md. No GitHub release was published."
  exit 0
fi
step "Publishing v$VERSION"
verify_unused_tag
gh release create "v$VERSION" "$DMG" dist/appcast.xml dist/SHA256SUMS-macos.txt -R "$REPO" --target "$SOURCE" --latest --title "Marlin $VERSION" --notes-file dist/build/notes.md
echo "Released: https://github.com/$REPO/releases/tag/v$VERSION"
