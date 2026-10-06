# Marlin

A Chromium browser built for AI agents. Claude Code, Codex, Hermes, Cursor or any script drive the same real browser window, and extensions are first class: agents install them from the Chrome Web Store, open their popups, unlock wallets and handle dapp approvals.

## Install

**Humans:** download the DMG from [Releases](https://github.com/joymadhu49/marlin/releases/latest), open it and drag Marlin to Applications. It is signed and notarized, and updates itself through [Sparkle](https://sparkle-project.org).

**Agents, or a one liner:**

```
curl -fsSL https://raw.githubusercontent.com/joymadhu49/marlin/main/scripts/get-marlin.sh | bash
```

This installs `/Applications/Marlin.app`, adds the `marlin` command, registers the MCP server with Claude Code, Codex and Hermes, and links the `marlin-browser` skill into each of them.

**As a skill or plugin:**

```
npx skills add joymadhu49/marlin                 # skills.sh: the marlin-browser skill
/plugin marketplace add joymadhu49/marlin         # Claude Code: skill + MCP server
/plugin install marlin@marlin
```

The skill teaches an agent to install Marlin itself if it is missing.

## Why it exists

Normal agent browsers break on extensions. Branded Chrome no longer loads unpacked extensions from the command line, and Playwright and Puppeteer cannot see extension popups. `chrome-extension://` pages are blocked when a web page navigates to them, and MetaMask's LavaMoat lockdown breaks injected scripts. Marlin solves each of these:

| Problem | Marlin |
|---|---|
| Installing store extensions | Downloads the CRX, verifies it, unpacks it with its public key so it keeps the real store ID, loads it over CDP `Extensions.loadUnpacked` |
| Opening the toolbar popup | `Extensions.triggerAction` opens the real popup. When a wallet closes its popup and reopens as a tab, Marlin follows it |
| Driving wallet UIs | Helper scripts run in an isolated world, so LavaMoat scuttling (MetaMask) does not break them |
| Wallet requests in existing windows | Watches extension route changes (`/connect`, `/confirm-transaction`) and surfaces them as events and as the active tab |
| Passwords | macOS Keychain. Agents can type a secret into a field but no tool returns its value, and all output is scrubbed |
| Signing | Wallet Confirm/Sign/Send/Approve clicks pause for a human (sidebar card or approval tab plus a notification) with a screenshot. `marlin config signPolicy allow` turns this off |

## Pieces

- **Chromium**: the latest open source snapshot (`marlin fetch-chromium`), rebranded as Marlin.app.
- **Daemon** (`src/server.js`): launches Chromium with a pipe (for the Extensions CDP domain) and a loopback debugging port, then serves the tools.
- **Tools** (`src/tools.js`): 26 tools shared by every front door: tabs, navigate, snapshot with element refs, screenshot (optionally annotated), click/type/press/scroll, extensions, open_extension, wait_for_tab, secrets, fill_secret, unlock_extension, and more.
- **MCP** (`marlin mcp`): stdio server. Listing tools never starts the browser; the first tool call does.
- **CLI**: `marlin tool <name> '<json>'` for agents without MCP.
- **HTTP**: `POST 127.0.0.1:47615/tools/<name>` with the bearer token from `state.json`.
- **CDP**: `http://127.0.0.1:47616` for Playwright `connectOverCDP`, browser use and similar.
- **Sidebar** (`extension/`): built into the browser, not installed by the user. A chat agent on any OpenRouter model (optional), a live feed of what external agents are doing, approval cards, secrets, extensions and the MCP command. An "Add to Marlin" button on Web Store pages.
- **Skill** (`skills/marlin-browser/SKILL.md`): the operating manual agents load.

## Commands

```
marlin start [--headless]      run in the foreground
marlin open [url]              start if needed, open a tab
marlin stop | status | version
marlin update                  check for a new release
marlin setup                   reconnect Claude Code, Codex and Hermes
marlin install <id|url|path>   install an extension
marlin secret set <name>       store a wallet password in the Keychain
marlin config signPolicy smart|ask|allow
marlin tools | tool <name> '<json>'
```

Data: `~/Library/Application Support/Marlin` (profile, extensions, screenshots, config, log).

## Memory

Low memory mode is on by default (`marlin config lowMemory false` turns it off):

- No spare pre-started renderer. Optimization guide, translate, cast and other background services are off, and renderer processes are capped at 8. Site isolation stays on.
- Memory Saver discards idle background tabs. Tools wake a discarded tab before using it.
- `open_extension` and `unlock_extension` reuse an existing wallet tab instead of opening another.
- `enable_extension` turns off a wallet you are not using. Each wallet keeps a 500 to 650 MB process alive.

Measured with `node test/memory-bench.js` (3 sites plus MetaMask and Rabby, macOS physical footprint):

| Setup | Footprint |
|---|---|
| Stock Chromium flags | 2,086 MB |
| Low memory mode | 1,923 MB |
| Low memory, Rabby turned off | 1,739 MB |

Before tab reuse, the same workload left 8 tabs and 28 processes open, against 6 tabs and 13 processes now.

## Releasing an update

1. Bump `version` in `package.json` and add a `## x.y.z` section to `CHANGELOG.md`.
2. `bash scripts/release.sh`, or `bash scripts/release.sh --chromium` to pull the newest Chromium first.

The script builds the app, Developer ID signs it with the hardened runtime, notarizes and staples it, wraps it in a DMG (also signed and notarized), signs the update with the Sparkle EdDSA key from the Keychain (account `marlin`), writes `appcast.xml` and publishes both to a GitHub release. Installed copies read `releases/latest/download/appcast.xml`. They check quietly whenever the human opens Marlin, or on `marlin update`.

Dev builds: `bash app/build-app.sh --install` (ad hoc signed, no updater feed changes).

## Tests

```
node test/e2e.js        # 15 checks on a throwaway profile, headless
node test/mcp-smoke.js  # spawns the MCP server like a client would
```

Also verified by hand through the tools: MetaMask onboarding with a Keychain password, lock and unlock after restart, dapp `eth_requestAccounts` approval, and `personal_sign` through the approval guard, which returned a valid signature. Codex and Claude Code sessions each installed and drove Rabby over MCP.

## Limits

- macOS 13+ on Apple Silicon only for now (Keychain, app bundle). The core would port to Linux and Windows.
- This is the official Chromium binary plus a control layer, not a source fork. Building Chromium from source needs roughly 100 GB free and several hours. Nothing so far has needed a patched browser.
- Side panels and toolbar popups close when they lose focus. `open_extension` with `mode: "tab"` is steadier for long flows.
- The approval guard matches button labels. It is a seatbelt, not a sandbox. Use dedicated agent wallets.
