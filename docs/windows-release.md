# Windows release procedure

Windows packages use `vX.Y.Z-windows.N` tags and a separate update channel. Keep the Windows release marked as a prerelease and `latest=false` so the macOS Sparkle URL at `releases/latest/download/appcast.xml` keeps working.

1. Bump the shared stable base version in `package.json`, set the matching `MARLIN_WINDOWS_VERSION` (`X.Y.Z-windows.N`) in the Windows workflow, add changelog entries, and update `docs/windows-release-notes.md`. The Windows builder writes its channel version into each packaged `package.json`.
2. Open a PR. Both the platform regression matrix and all three Windows package jobs must pass for the same source commit. The latter builds the package and exercises the bundled browser. All `test/*.test.js` files are discovered automatically, including native updater tests.
3. Merge the reviewed change. If the merged tree is identical to the tested source, promote those exact artifacts. Otherwise run the Windows package workflow on the merged source and wait for its platform matrix. Record the exact tested source SHA and successful Windows workflow run ID.
4. Dispatch **Publish tested Windows release** on `main` with `run_id`, `source_sha`, and `tag`. The publisher checks the successful package and matrix runs, verifies the downloaded artifact checksum and bundled version, and uploads all three original tested ZIPs and checksums. It refuses to overwrite an existing release.
5. Verify both assets are uploaded, their digest agrees with the sidecar, and the previous macOS release remains GitHub's latest stable release.

## User experience

The packaged Windows runtime checks quietly after Marlin opens. The About page and sidebar show a new version and allow the user to install and restart. A restart is intentional, not silent: users can finish their work first. `marlin update` checks from the command line; `marlin update --install` uses the same installer.

The original Windows preview needs one installation of an updater-capable version. It cannot acquire an updater through a feature it does not contain. Later updates need no manual ZIP extraction.

For that initial migration, close Marlin and MCP clients. If installed per-user, rename the existing `%LOCALAPPDATA%\Programs\Marlin` app folder to a backup and run the new package's `install.ps1`; it deliberately refuses to overwrite an existing directory. Keep `%LOCALAPPDATA%\Marlin` (the profile and secrets) in place. Reusing the original application path preserves shortcuts and MCP paths. A portable installation at a new path needs updated shortcuts and MCP configuration.

Source checkouts, custom runtimes and unsupported architectures are not automatically replaced. Data must live outside the application folder. MCP clients using the bundled Node runtime should be closed before installation to avoid Windows file locks. Windows ZIPs are currently unsigned; HTTPS and SHA256 verification are not a substitute for Authenticode or independently signed update metadata.

## Architecture coverage

- x64: native x64 Windows package, Chromium and Node.
- ARM64: native Windows 11 ARM runner, Chromium and Node.
- x86: 32-bit Node and Chromium exercised under WoW64 on x64 Windows; a native 32-bit OS is not part of CI.

The upstream browser baseline is Windows 10+ on Intel and Windows 11+ on ARM. These requirements do not certify every Windows 10 build; the package jobs validate the hosted runner operating systems. Windows 7/8 are unsupported. The builder checks PE headers and runtime architecture, and the publisher requires matching package metadata for every ZIP.
