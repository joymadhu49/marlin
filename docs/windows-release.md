# Windows release procedure

Windows packages use `vX.Y.Z-windows.N` tags and a separate update channel. Keep the Windows release marked as a prerelease and `latest=false` so the macOS Sparkle URL at `releases/latest/download/appcast.xml` keeps working.

1. Bump `package.json`, add changelog entries, and update `docs/windows-release-notes.md`.
2. Open a PR. Both the platform regression matrix and the native Windows package workflow must pass for the same source commit. The latter builds the package and exercises the bundled browser. All `test/*.test.js` files are discovered automatically, including native updater tests.
3. Merge the reviewed change. Run the Windows package workflow on `main`; the platform matrix also runs on `main`. Record the exact source SHA and successful Windows workflow run ID.
4. Dispatch **Publish tested Windows release** on `main` with `run_id`, `source_sha`, and `tag`. The publisher checks the successful package and matrix runs, verifies the downloaded artifact checksum and bundled version, and uploads the original tested ZIP and checksum. It refuses to overwrite an existing release.
5. Verify both assets are uploaded, their digest agrees with the sidecar, and the previous macOS release remains GitHub's latest stable release.

## User experience

The packaged x64 runtime checks quietly after Marlin opens. The About page and sidebar show a new version and allow the user to install and restart. A restart is intentional, not silent: users can finish their work first. `marlin update` checks from the command line; `marlin update --install` uses the same installer.

The original Windows preview needs one installation of an updater-capable version. It cannot acquire an updater through a feature it does not contain. Later updates need no manual ZIP extraction.

Source checkouts, custom runtimes and other architectures are not automatically replaced. Data must live outside the application folder. MCP clients using the bundled Node runtime should be closed before installation to avoid Windows file locks. Windows ZIPs are currently unsigned; HTTPS and SHA256 verification are not a substitute for Authenticode or independently signed update metadata.
