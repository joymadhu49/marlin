#!/bin/bash
# Shared dependency selection and preflight for the macOS source installer.

# Existing installations trust this key. Never generate or substitute a key at release time.
MARLIN_SPARKLE_PUBLIC_KEY="Vzdd6fx46YsZwt3iKavazKGu95aBqMUf3rwglxS/JtI="

macos_build_number() {
  node -e '
    const version = process.argv[1];
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
      console.error("The macOS Sparkle release requires a stable major.minor.patch version.");
      process.exit(1);
    }
    const [major, minor, patch] = version.split(".").map(Number);
    const build = major * 10000 + minor * 100 + patch;
    if (minor >= 100 || patch >= 100 || !Number.isSafeInteger(build)) {
      console.error("The macOS build number requires minor and patch below 100.");
      process.exit(1);
    }
    console.log(build);
  ' "$1"
}

require_macos_arm64() {
  [ "$(node -p process.arch)" = arm64 ] || {
    echo "This Marlin.app build supports Apple Silicon only; use an arm64 Node runtime." >&2
    return 1
  }
  local executable="$1" architectures
  architectures="$(/usr/bin/lipo -archs "$executable")" || return 1
  case " $architectures " in
    *' arm64 '*) ;;
    *) echo "Chromium must contain an arm64 executable for this Apple Silicon build." >&2; return 1 ;;
  esac
}

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
