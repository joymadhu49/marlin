First Windows x64 portable preview of Marlin. The ZIP includes Node 22.22.3, Chromium snapshot 1716310, production dependencies and the launcher.

## Install

1. Download the ZIP and its SHA256 sidecar. Compare `Get-FileHash <zip> -Algorithm SHA256` with the sidecar.
2. Extract the ZIP and open `marlin.cmd` inside `Marlin-win32-x64`.
3. Optionally run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` from that folder for a per-user installation, PATH entry and desktop shortcut.
4. Run `marlin setup` to generate MCP configuration for manual import into your client.

Data is stored under `%LOCALAPPDATA%\Marlin`, or `MARLIN_HOME` when set. Secrets are encrypted with Windows DPAPI CurrentUser. They remain tied to that Windows account/context.

## Improvements

- Windows data paths, native archive extraction, staged Chromium downloads and per-user installation.
- DPAPI-protected passwords, Windows password-field shortcuts and local extension path support.
- Daemon crash containment and startup cleanup; browser navigation, stale references and keyboard modifier fixes.
- Safer local extension reinstall and malformed CRX header validation.
- Agent cancellation, updater failure reporting and macOS source-build corrections.

## Validation and limits

The integrated regression suite runs on Linux, macOS and Windows. Windows executes native DPAPI roundtrip, restart, Unicode/newline, redaction and corrupt-ciphertext checks. The packaged acceptance suite checks the bundled CLI/runtime, launcher and installer paths, MCP discovery, real headless Chromium, HTTP/CDP, local navigation, screenshots and a local Lockbox extension.

This is an **unsigned preview**, with Chromium window branding and **manual updates**. Windows ARM64 is not supported. Live wallet onboarding, signing and transactions have not been certified by this smoke suite. Native approval notifications remain macOS-only; Windows uses the sidebar and approval tab. No automatic update is installed over the existing stable macOS release.

Source and consolidated review: https://github.com/joymadhu49/marlin/pull/40

Build source: `dce7aef7bb07505b4a91e5d7dab6d5f2e49aebdd`.

Verified build: https://github.com/joymadhu49/marlin/actions/runs/38051567154

Regression matrix: https://github.com/joymadhu49/marlin/actions/runs/38051567225

Results: 120 regression cases; 113 passed and 7 platform-specific skips on Windows, 118 passed and 2 skips on each of Linux/macOS; zero failures. All 8 packaged Windows smoke checks passed.
