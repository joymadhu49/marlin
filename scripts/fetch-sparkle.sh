#!/bin/bash
# Downloads the latest Sparkle 2 release into vendor/sparkle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG=$(curl -fsSL https://api.github.com/repos/sparkle-project/Sparkle/releases/latest | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tag_name))')
mkdir -p "$ROOT/vendor/sparkle"
curl -fsSL "https://github.com/sparkle-project/Sparkle/releases/download/$TAG/Sparkle-$TAG.tar.xz" | tar -xJ -C "$ROOT/vendor/sparkle"
rm -rf "$ROOT/vendor/sparkle/Sparkle Test App.app" "$ROOT/vendor/sparkle/Symbols"
echo "$TAG" > "$ROOT/vendor/sparkle/VERSION"
echo "Sparkle $TAG"
