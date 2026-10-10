Marlin for Windows x64 now supports updates inside the browser.

- Marlin checks for releases after opening. Use **Install and restart** on the About page (`chrome://settings/help`) or **Install** in the sidebar.
- Downloads show progress and are verified against the release checksum and GitHub asset digest before installation.
- The updater stages the new package, closes Marlin, replaces the application, and reopens it. Replacement failures restore the previous application.
- Profiles, extensions, settings and DPAPI-protected secrets stay in the external data directory.

## Install

Download the ZIP and `.sha256` sidecar, compare the SHA256 with `Get-FileHash`, extract, and open `marlin.cmd`. Node and Chromium are included. Optionally run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` for per-user installation and a shortcut.

The original `0.3.0-windows.1` preview has no updater: install this version once to gain in-browser updates. Subsequent Windows releases use the browser controls. Close MCP clients before restarting so they release the bundled Node runtime. Keep `MARLIN_HOME` outside the application folder.

For an existing per-user installation, close Marlin and MCP clients, rename `%LOCALAPPDATA%\Programs\Marlin` to a backup folder, then run the new package's `install.ps1`. This recreates the same application path for your shortcuts and MCP configuration. Leave the separate `%LOCALAPPDATA%\Marlin` data folder in place. Portable users can extract and launch the new ZIP, then update shortcuts and run `marlin setup` if their application path changed.

## Release status

Windows x64 remains unsigned, uses Chromium window branding, and is distributed on its own prerelease channel. The checksum protects integrity; it is not a publisher signature. Native regression, updater and packaged browser checks are required before publication. Live wallet transactions are not certified by these tests. Windows ARM64 and Android packages are not included. The signed macOS release and Sparkle feed remain available separately.
