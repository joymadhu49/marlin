#!/bin/bash
# Shared dependency selection and preflight for the macOS source installer.

require_build_tools() {
  if [ "$(uname -s)" != Darwin ]; then
    echo "The Marlin.app source build requires macOS." >&2
    return 1
  fi
  local tool
  for tool in node rsvg-convert iconutil rsync swiftc xcrun codesign ditto xattr curl tar; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Missing build tool: $tool" >&2; return 1; }
  done
  if ! command -v pnpm >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1; then
    echo "Install pnpm or npm before building Marlin." >&2
    return 1
  fi
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' || {
    echo "Node 22.12+ is required by the browser dependencies." >&2
    return 1
  }
  xcrun --find swiftc >/dev/null 2>&1 || {
    echo "The Swift toolchain is unavailable. Configure Xcode Command Line Tools before building." >&2
    return 1
  }
}

install_dependencies() {
  local mode="${1:-development}"
  case "$mode" in development|production) ;; *) echo "Unknown dependency mode: $mode" >&2; return 1;; esac
  if command -v pnpm >/dev/null 2>&1; then
    if [ "$mode" = production ]; then
      pnpm install --prod --frozen-lockfile --silent --config.node-linker=hoisted
    else
      pnpm install --frozen-lockfile --silent
    fi
  elif command -v npm >/dev/null 2>&1; then
    # The repository ships a pnpm lockfile, so npm resolves from package.json.
    if [ "$mode" = production ]; then
      npm install --omit=dev --silent --package-lock=false
    else
      npm install --silent --package-lock=false
    fi
  else
    echo "Install pnpm or npm before building Marlin." >&2
    return 1
  fi
}
