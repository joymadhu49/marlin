Marlin for Windows now provides **x64, ARM64 and x86** packages, with updates inside the browser.

| Package | Use it for | Validation |
| --- | --- | --- |
| x64 | Most Intel/AMD Windows PCs | Native x64 Windows runtime and browser |
| ARM64 | Windows 11 ARM PCs | Native Windows 11 ARM runtime and browser |
| x86 | A 32-bit runtime | Tested under WoW64 on x64 Windows; native 32-bit OS testing is not included |

Choose the ZIP and matching `.sha256` for your architecture. Compare the SHA256 with `Get-FileHash`, extract, and open `marlin.cmd` inside `Marlin-win32-<architecture>`. Node and Chromium are included. Optionally run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` for per-user installation and a shortcut.

Marlin checks for releases after opening. Use **Install and restart** on the About page (`chrome://settings/help`) or **Install** in the sidebar. Updates select the installed architecture, verify the release checksum and GitHub asset digest, stage the new application, and reopen it. Profiles, extensions, settings and DPAPI-protected secrets remain in the external data directory. Close MCP clients before restarting so they release their bundled runtime.

Existing `0.3.0-windows.2` x64 users can install this release from inside Marlin. The original `.1` preview has no updater and needs one manual installation. To migrate a per-user installation, close Marlin/MCP clients, rename the existing `%LOCALAPPDATA%\Programs\Marlin` app folder to a backup, then run the new package's `install.ps1`. Leave `%LOCALAPPDATA%\Marlin` data in place. Keep custom `MARLIN_HOME` outside the application folder.

The upstream browser baseline is Windows 10+ on Intel and Windows 11+ on ARM. Native package checks cover the hosted CI operating systems, not every older Windows 10 build. Windows 7/8 are unsupported.

Windows packages remain **unsigned prereleases** with Chromium window branding. Checksums protect integrity; they are not publisher signatures. Live wallet transactions are not certified by the smoke suite. macOS remains on its separate signed release and Sparkle update feed. No Android package is included.
