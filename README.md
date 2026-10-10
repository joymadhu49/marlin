# Marlin

A Chromium browser built for AI agents. Claude Code, Codex, Hermes, Cursor or any script drive the same real browser window, and extensions are first class: agents install them from the Chrome Web Store, open their popups, unlock wallets and handle dapp approvals.

## Install

**macOS (Apple Silicon, macOS 13+):** download the DMG from [Releases](https://github.com/joymadhu49/marlin/releases/latest), open it and drag Marlin to Applications. It is signed and notarized, and updates itself through [Sparkle](https://sparkle-project.org).

**Windows (x64, ARM64 and x86):** download the ZIP and `.sha256` sidecar from the [Windows release](https://github.com/joymadhu49/marlin/releases/tag/v0.3.0-windows.3). Compare `Get-FileHash <zip> -Algorithm SHA256` with the sidecar, extract the ZIP, and double-click `marlin.cmd` inside the extracted `Marlin-win32-<architecture>` folder. Node and Chromium are included. This release is unsigned and uses the Chromium window branding. Marlin checks for updates after opening; use **Install and restart** on its About page or **Install** in the sidebar to update without downloading another ZIP. Users of the original `0.3.0-windows.1` preview must install this version once to gain the updater.

Optional Windows installation (PowerShell, from the extracted folder):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

This installs for the current user under `%LOCALAPPDATA%\Programs\Marlin`, adds the command to the user PATH and creates a desktop shortcut. Open a new terminal afterward. The installer refuses to overwrite an existing installation; stop Marlin and use a new directory when upgrading. Browser data lives separately under `%LOCALAPPDATA%\Marlin`. `MARLIN_HOME` overrides the data directory on either OS.

Run `marlin setup` on Windows to generate `mcp-config.json` in the data directory. Copy its `marlin` entry into your MCP client's configuration and restart the client. The Windows launcher uses the bundled runtime; no global Node installation is needed. Passwords use Windows DPAPI CurrentUser and can only be decrypted in the same Windows user context. Moving the encrypted files to another account or computer is not a secret-backup strategy.

**macOS agents, or a one liner:**

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
| Installing store extensions | Downloads the CRX, validates its structure, unpacks it with its public key so it keeps the real store ID, loads it over CDP `Extensions.loadUnpacked` |
| Opening the toolbar popup | `Extensions.triggerAction` opens the real popup. When a wallet closes its popup and reopens as a tab, Marlin follows it |
| Driving wallet UIs | Helper scripts run in an isolated world, so LavaMoat scuttling (MetaMask) does not break them |
| Wallet requests in existing windows | Watches extension route changes (`/connect`, `/confirm-transaction`) and surfaces them as events and as the active tab |
| Passwords | macOS Keychain or Windows DPAPI CurrentUser. Agents can type a secret into a field but no tool returns its value, and text output is scrubbed |
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
marlin secret set <name>       store a wallet password in the OS-protected store
marlin config signPolicy smart|ask|allow
marlin tools | tool <name> '<json>'
```

Data: `~/Library/Application Support/Marlin` on macOS; `%LOCALAPPDATA%\Marlin` on Windows (profile, extensions, screenshots, config, log). Windows approval cards and tabs are supported; native desktop approval notifications are currently macOS-only.

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

Windows uses a separate GitHub release channel (`vX.Y.Z-windows.N`) and the bundled runtime. Choose x64 for most PCs, ARM64 for Windows 11 ARM PCs, or x86 for a 32-bit runtime. Updates retain the installed architecture. Its updater verifies the ZIP against its SHA256 sidecar and GitHub asset digest before replacing the app. This provides transport and integrity checks, not publisher code signing. The profile and DPAPI secrets remain in the data directory. Keep `MARLIN_HOME` outside the installation folder and close MCP clients before restarting to release their bundled Node runtime. The installer retains the prior app if replacement fails. See [Windows release procedure](docs/windows-release.md).

Android requires a separate app and browser-engine integration; see [Android port assessment](docs/android-port.md). There is no Android package yet.

## Tests

The server regression tests run without Chromium or Keychain access and were verified on Node 22.22.3. The script enables Node's experimental module mocking support.

```
npm run test:server
```

Run all browser-independent regressions:

```
npm run test:unit       # browser-independent regressions; Node 22.22.3
```

GitHub Actions runs the unit suite on Linux, macOS and Windows. Native Windows DPAPI checks run only on Windows. Linux CI coverage does not imply a supported Linux browser distribution.

The Windows package workflow builds with pinned Node and Chromium versions and then runs `node test/windows-smoke.js` against the bundled runtime and browser. It covers CLI/setup, launcher and installer paths, MCP discovery, local HTTP navigation, element refs, screenshots, CDP and a local extension. It does not certify live wallet onboarding, signing, or transactions on Windows.

To build a Windows package from source on Windows x64:

```powershell
npm install --global pnpm@10.28.2
pnpm install --frozen-lockfile
node src/cli.js fetch-chromium
$env:MARLIN_WINDOWS_VERSION = '0.3.0-windows.3'
npm run build:windows -- -Architecture x64
$env:MARLIN_APP_ROOT = Join-Path $PWD 'dist\Marlin-win32-x64'
node test/windows-smoke.js
```

The following older end-to-end checks require Chromium and the macOS Keychain:

```
node test/e2e.js        # 15 checks on a throwaway profile, headless
node test/mcp-smoke.js  # spawns the MCP server like a client would
```

Previously verified by hand on macOS through the tools: MetaMask onboarding with a Keychain password, lock and unlock after restart, dapp `eth_requestAccounts` approval, and `personal_sign` through the approval guard, which returned a valid signature. Codex and Claude Code sessions each installed and drove Rabby over MCP.

## Limits

- Stable signed builds target macOS 13+ on Apple Silicon. Windows packages are unsigned portable releases with in-browser updates. x64 and ARM64 packages receive native checks; x86 is checked under WoW64, not on a native 32-bit OS. Windows 7/8 and Linux packages are not supported. Intel macOS packages are not provided.
- This is the official Chromium binary plus a control layer, not a source fork. Building Chromium from source needs roughly 100 GB free and several hours. Nothing so far has needed a patched browser.
- Side panels and toolbar popups close when they lose focus. `open_extension` with `mode: "tab"` is steadier for long flows.
- The approval guard matches button labels. It is a seatbelt, not a sandbox. Use dedicated agent wallets.
