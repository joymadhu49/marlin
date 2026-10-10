#!/bin/bash
# Developer ID signs Marlin.app inside out with the hardened runtime.
#   bash scripts/sign.sh dist/Marlin.app
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$(cd "$1" && pwd)"
ID="${MARLIN_SIGN_ID:-Developer ID Application: Joy Madhu (CJZMYQN8V6)}"
ENT="$ROOT/app/entitlements"
sign() { codesign --force --timestamp --options runtime --sign "$ID" "$@"; }

# 1. Every loose Mach-O file. V8 hosts (node) get the JIT entitlements.
while IFS= read -r f; do
  if file -b "$f" | grep -q 'Mach-O'; then
    case "$f" in
      # Preserve these before signing the containing XPC bundle below. Once
      # removed from its executable, bundle signing cannot recover them.
      *Sparkle.framework/Versions/B/XPCServices/Downloader.xpc/Contents/MacOS/*) sign --preserve-metadata=entitlements "$f" ;;
      */Resources/node/bin/node) sign --entitlements "$ENT/jit.plist" "$f" ;;
      */Contents/MacOS/Chromium) sign --entitlements "$ENT/browser.plist" "$f" ;;
      *) sign "$f" ;;
    esac
  fi
done < <(find "$APP" -type f \( -perm -u+x -o -name '*.dylib' -o -name '*.so' -o -name '*.node' \) | awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2-)

# 2. Nested bundles, deepest first.
while IFS= read -r b; do
  case "$b" in
    *Sparkle.framework/Versions/B/XPCServices/Downloader.xpc) sign --preserve-metadata=entitlements "$b" ;;
    *"Helper (Renderer).app"|*"Helper (GPU).app"|*"Helper (Plugin).app"|*"Helper (Aperitif"*|*"Chromium Helper.app") sign --entitlements "$ENT/jit.plist" "$b" ;;
    *) sign "$b" ;;
  esac
done < <(find "$APP/Contents" -depth -type d \( -name '*.app' -o -name '*.framework' -o -name '*.xpc' \) | awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2-)

# 3. The outer app (its main executable is the launcher script).
sign --entitlements "$ENT/browser.plist" "$APP"
codesign --verify --deep --strict --verbose=1 "$APP" 2>&1 | tail -2
