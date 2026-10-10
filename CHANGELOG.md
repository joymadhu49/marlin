# Changelog

## 0.3.0-windows.1

- First Windows x64 portable preview with bundled Node and Chromium, per-user installation, MCP configuration generation and manual updates.
- Windows DPAPI CurrentUser protects stored secrets; macOS continues to use Keychain.
- Native Windows package smoke checks and a Linux/macOS/Windows regression matrix.
- Windows-aware password selection shortcuts and extension source paths.

## 0.2.2

- Updates happen inside the browser: Marlin checks quietly after you open it, the sidebar shows when a new version is out, and the About page shows release notes, an Install and restart button and download progress. Sparkle still downloads, verifies the signature and installs.
- marlin update checks from the terminal and marlin update --install installs, with progress shown in the browser too.

## 0.2.1

- chrome://settings/help now opens Marlin's About page with the Marlin and Chromium versions and a working Check for updates button. Chromium's built in updater had no service behind it and always showed "error code 0".
- Check for updates in the sidebar Settings.

## 0.2.0

- First public release: signed and notarized DMG with automatic updates through Sparkle.
- Lower memory: leaner Chromium flags, Memory Saver for background tabs, wallet tabs are reused instead of piling up.
- New enable_extension tool turns a wallet off when unused (saves 200 to 600 MB and stops wallets competing for window.ethereum).
- Smart signing policy: agents sign logins and plain messages alone; transactions, permits and typed data wait for a human. Tested on MetaMask and Rabby.
- Rabby support: connect alerts, two step Sign then Confirm, cancel menu.
- marlin setup and marlin update commands; one line installer for agents.

## 0.1.0

- Chromium browser for AI agents with MCP, CLI and HTTP access, extension installs from the Chrome Web Store, wallet unlock from the Keychain, and a built in sidebar.
