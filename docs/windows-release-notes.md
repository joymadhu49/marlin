<p>Marlin for Windows, with packages for x64, ARM64 and x86 and updates inside the browser.</p>
<ul>
<li>Packages for x64, ARM64 and x86. Updates keep the architecture you installed.</li>
<li>Marlin checks for a new release after it opens. Install it from the About page or the sidebar.</li>
<li>Every update is verified against its published SHA256 before it replaces the app.</li>
<li>Profiles, extensions, settings and saved secrets stay in place across updates.</li>
</ul>

## Download

| Package | File | Use it for | Validation |
| --- | --- | --- | --- |
| x64 | [Marlin-{{VERSION}}-windows-x64.zip]({{DOWNLOAD}}/Marlin-{{VERSION}}-windows-x64.zip) | Most Intel and AMD PCs | Native x64 Windows runtime and browser |
| ARM64 | [Marlin-{{VERSION}}-windows-arm64.zip]({{DOWNLOAD}}/Marlin-{{VERSION}}-windows-arm64.zip) | Windows 11 ARM PCs | Native Windows 11 ARM runtime and browser |
| x86 | [Marlin-{{VERSION}}-windows-x86.zip]({{DOWNLOAD}}/Marlin-{{VERSION}}-windows-x86.zip) | A 32-bit runtime | Tested under WoW64 on x64 Windows; native 32-bit OS testing is not included |

Each ZIP has a matching `.sha256` file under Assets. Looking for macOS? Use the [latest macOS release](https://github.com/joymadhu49/marlin/releases/latest).

## Install

1. Download the ZIP for your PC and its `.sha256` file. Compare the checksum with `Get-FileHash <zip> -Algorithm SHA256`.
2. Extract the ZIP and open `marlin.cmd` inside `Marlin-win32-<architecture>`. Node and Chromium are included.
3. Optional: run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` from that folder for a per-user installation, a PATH entry and a desktop shortcut.
4. Run `marlin setup` to generate the MCP configuration for your agent.

## Updating

Marlin checks for releases after opening. Use **Install and restart** on the About page (`chrome://settings/help`) or **Install** in the sidebar. Updates select the installed architecture, verify the release checksum and GitHub asset digest, stage the new application, and reopen it. Profiles, extensions, settings and DPAPI-protected secrets remain in the external data directory. Close MCP clients before restarting so they release their bundled runtime.

Existing `0.3.0-windows.2` x64 users can install this release from inside Marlin. The original `.1` preview has no updater and needs one manual installation. To migrate a per-user installation, close Marlin and MCP clients, rename the existing `%LOCALAPPDATA%\Programs\Marlin` app folder to a backup, then run the new package's `install.ps1`. Leave `%LOCALAPPDATA%\Marlin` data in place. Keep a custom `MARLIN_HOME` outside the application folder.

## Good to know

- Windows packages are **unsigned**, so Windows may warn before the first run. Checksums protect integrity; they are not publisher signatures.
- Windows 10 or later on Intel and AMD, Windows 11 or later on ARM. Native package checks cover the hosted CI operating systems, not every older Windows 10 build. Windows 7 and 8 are unsupported.
- Windows shows the Chromium window branding.
- Live wallet transactions are not certified by the smoke suite.
- macOS has its own signed release and Sparkle update feed. No Android package is included.
