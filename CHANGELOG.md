# Changelog

## 0.2.0

- First public release: signed and notarized DMG with automatic updates through Sparkle.
- Lower memory: leaner Chromium flags, Memory Saver for background tabs, wallet tabs are reused instead of piling up.
- New enable_extension tool turns a wallet off when unused (saves 200 to 600 MB and stops wallets competing for window.ethereum).
- Smart signing policy: agents sign logins and plain messages alone; transactions, permits and typed data wait for a human. Tested on MetaMask and Rabby.
- Rabby support: connect alerts, two step Sign then Confirm, cancel menu.
- marlin setup and marlin update commands; one line installer for agents.

## 0.1.0

- Chromium browser for AI agents with MCP, CLI and HTTP access, extension installs from the Chrome Web Store, wallet unlock from the Keychain, and a built in sidebar.
