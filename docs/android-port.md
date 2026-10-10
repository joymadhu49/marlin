# Android port feasibility

Research date: 2026-10-10. Repository baseline: `origin/main` at `561d5c7`.

Android is feasible as a new product target, but the current desktop bundle cannot be repackaged as an APK. There is no Android implementation, APK, device test result, or release in this contribution. The recommendations below are engineering judgments based on the repository and the linked primary sources; they are not a delivery estimate or a guarantee of store approval.

The smallest useful first product is an Android companion for an explicitly paired desktop Marlin instance. If the requirement is a browser that runs the existing Chrome wallet extensions entirely on the phone, first prove an Android browser engine and extension runtime. That requirement is the main feasibility risk.

## What needs to move

| Current component | Desktop dependency | Android consequence |
| --- | --- | --- |
| [`src/browser.js`](../src/browser.js) | Puppeteer launches a Chromium executable with a debugging pipe; extension loading, popup actions and management use the CDP `Extensions` domain. | Requires a different browser host and automation adapter. An Android APK is not a desktop executable that this launcher can spawn. |
| [`extension/manifest.json`](../extension/manifest.json) | Manifest V3 worker, `sidePanel`, `management`, `tabs`, toolbar action and Chrome extension pages. | Rebuild the control/approval interface in Android and prove every required extension API. A working webpage alone does not prove this layer. |
| [`src/tools.js`](../src/tools.js), [`src/snapshot.js`](../src/snapshot.js) | Puppeteer pages, isolated-world DOM operations, screenshots, wallet popup tracking and guarded clicks. | Tool schemas and some DOM algorithms can be retained; page handles, isolated execution, input, screenshots and wallet navigation need adapters and device tests. |
| [`src/client.js`](../src/client.js), [`src/server.js`](../src/server.js), [`src/mcp.js`](../src/mcp.js) | Detached Node daemon, loopback HTTP/WebSocket server and desktop stdio MCP launch. | Android needs lifecycle-managed execution and an explicit inter-process or paired network transport. Existing desktop MCP clients cannot directly spawn an Android activity through this stdio configuration. |
| [`src/platform.js`](../src/platform.js), [`src/vault-backend.js`](../src/vault-backend.js) | Desktop Chromium downloads; macOS Keychain or Windows DPAPI. | Add Android app-private storage and Keystore integration. Copying Windows encrypted files does not migrate secrets. |

The current HTTP service binds to loopback and validates desktop Host/origin/token assumptions. A remote companion therefore needs a new authenticated gateway or tunnel; changing the bind address to `0.0.0.0` is not a sufficient design. Keep raw CDP private, pair devices explicitly, use encrypted transport and revocable credentials, and bind approval responses to the exact pending request and session.

## Practical product paths

| Path | What it delivers | Main tradeoff | Relative scope |
| --- | --- | --- | --- |
| Android companion + desktop browser | Mobile chat, task status, screenshots and human approvals; the existing wallet extensions continue running on the paired desktop. | Requires a reachable, running desktop. It must be described as remote control rather than local Android browsing. | Smallest engine risk; still substantial pairing, permissions, reconnect and approval work. |
| Native app + Android WebView + mobile wallet integration | On-device browsing and a defined subset of agent tools, with wallet requests handled by a compatible external wallet. | Chrome Web Store extensions, current popup automation and the desktop sidebar are not preserved. Arbitrary existing dapps may need integration work. | New Android application and automation backend. |
| Native app + GeckoView | On-device browser with a documented WebExtension embedding model. | Port the built-in extension and automation backend, and validate each wallet's Firefox/Android compatibility and distribution terms. Chrome CRX installation is not a drop-in path. | Significant engine/API migration. |
| Maintained Chromium Android fork | Potentially the closest fit for Chromium-specific behavior and local Chrome extension goals. | Own native builds, extension UI/API gaps, sandbox integration, upstream security updates and device compatibility. | Highest uncertainty and ongoing maintenance; gated research before a release plan. |

**WebView is not the existing extension runtime.** Its documented application model provides web content, navigation and app integration, not Marlin's Chrome extension installation/sidebar APIs. Wrapping `sidepanel.html` in a WebView would produce a UI shell without the browser backend. This conclusion follows from comparing the [Android WebView API model](https://developer.android.com/develop/ui/views/layout/webapps/webview) with Marlin's dependencies above.

**Android extension work does exist upstream.** Chromium's current [extension build flags](https://chromium.googlesource.com/chromium/src/+/HEAD/extensions/buildflags/buildflags.gni) disable the full stable extensions platform on Android and separately enable experimental desktop-Android extensions. The source explicitly describes that experiment as unstable. It is a research starting point, not evidence that production phone builds support all of Marlin's wallet/CDP APIs. A fork would follow Chromium's [Android build process](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/android_build_instructions.md), with its own pinned revision and security-update process.

**GeckoView is a credible alternative with a different contract.** Mozilla documents [embedded WebExtensions](https://mozilla.github.io/geckoview/javadoc/mozilla-central/org/mozilla/geckoview/WebExtension.html) and an [installation controller](https://mozilla.github.io/geckoview/javadoc/mozilla-central/org/mozilla/geckoview/WebExtensionController.html). Normal extension installation uses signed XPI packages. Prove the selected wallet and native messaging/action delegates before committing to this route; do not assume Chrome API or wallet parity.

For the WebView path, [Reown's Android AppKit](https://docs.reown.com/appkit/android/core/installation) is one candidate for an explicit mobile-wallet connection flow. Its existence does not automatically inject a compatible wallet provider into every arbitrary dapp or transfer desktop wallet automation to Android. Review the chosen SDK's license, infrastructure dependency and supported chains, and test the exact wallet/session/signature workflow.

## Runtime and Android lifecycle

Node.js 22's own [build documentation](https://github.com/nodejs/node/blob/v22.x/BUILDING.md#android) lists Android as unsupported, although NDK build instructions exist. Embedding a separately maintained Android Node build can preserve selected JavaScript modules, but does not solve the browser engine or detached-process assumptions. The alternatives are an Android-native service layer, or keeping Node on the paired desktop. Native runtime adoption needs an owner for ABI compatibility, upstream patches and dependency testing.

The desktop download/unpack/spawn model also conflicts with Android's [restriction on executing files from writable app home directories](https://developer.android.com/about/versions/10/behavior-changes-10#execute-permission). Package native code through the supported APK/native-library mechanism. Validate every bundled native dependency on [16 KB page-size devices](https://developer.android.com/guide/practices/page-sizes), including the engine and any embedded runtime.

An agent session cannot assume an indefinitely running background daemon. Android [restricts starting foreground services from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), and [some service types have time limits](https://developer.android.com/develop/background-work/services/fgs/timeout). Prefer an explicitly started, visible session with clear cancellation; choose a permitted service type only if the task qualifies. Persist resumable task metadata, cancel pending approvals on session loss, and revalidate state after process death. Rotation, screen locking, app switching, battery restrictions and network changes belong in the acceptance tests. Do not solve lifecycle failures by silently replaying signing actions.

## Wallet and browser security

Use [Android Keystore](https://developer.android.com/privacy-and-security/keystore) keys to protect locally stored credentials, optionally requiring user authentication for sensitive operations. Keystore protects cryptographic key material; a password supplied to a webpage still becomes plaintext in process memory. Hardware backing varies by device. Define backup, key invalidation, reinstall and device-migration behavior before storing user secrets.

Keep the trusted Marlin interface separate from arbitrary browsing content. Android documents serious risks from [native JavaScript bridges exposed to untrusted pages or frames](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges). No arbitrary page should acquire vault, signing, filesystem or remote-control authority through a bridge. Apply narrow message schemas, explicit origin/session checks and user consent to privileged operations.

For a mobile-wallet flow, the wallet should retain custody and display its own signing approval. Marlin should show the requesting origin, network and operation, reject stale or mismatched callbacks, and start with explicit human approval for all signing. Do not equate a deep-link return with a successful signature. Avoid automating another app's confirmation screen. Screenshots, logs, crash reports and model inputs also need secret handling; text replacement alone does not scrub images or prevent disclosure to a malicious page.

## Distribution and updates

A Google Play build must use Play's application update mechanism. Its [Device and Network Abuse policy](https://support.google.com/googleplay/android-developer/answer/16559646) prohibits self-replacement outside Play and downloading executable code such as native libraries from other sources. The policy contains an interpreter/browser-code exception, but that does not authorize replacing the APK or native engine through a desktop ZIP updater. Evaluate downloaded extension behavior against the full policy separately. The Android interface can offer [Play in-app updates](https://developer.android.com/guide/playcore/in-app-updates).

For a separately distributed APK, use Android's package installation flow and maintain the [signing identity and update lineage](https://developer.android.com/studio/publish/app-signing). Release signing keys, version ordering, protected user data and recovery from interrupted updates need explicit design. A GitHub checksum beside an unsigned download is not a replacement for an authenticated release/signing policy.

Select the distribution model and financial-feature scope early. Google's current [cryptocurrency wallet policy guidance](https://support.google.com/googleplay/android-developer/answer/16329703?hl=en-en) explicitly excludes non-custodial wallets from that particular policy, while other applicable policies and declarations still need evaluation. Do not assume a general browser, wallet connector and custodial wallet have identical obligations. Recheck policy, target-SDK and native-library requirements when preparing a release.

## Evidence needed before committing to a full port

1. Choose the product contract: remote companion, local browsing with external wallets, or local extension parity. Name the first supported devices, wallets and operations.
2. Prove one complete device workflow: navigate a local fixture, inspect elements, act, capture a safe screenshot, request approval, cancel it, restart the app and recover without replay. Use test accounts and test networks.
3. For extension parity, prove loading the built-in agent and a selected wallet, background-worker behavior, wallet tab/action UI, isolated execution and the required automation transport on an actual Android build. Failure here changes the architecture, not merely the packaging work.
4. Test origin isolation, pairing revocation, malicious page messages, expired approvals, secret storage, lost connectivity and Android process termination. Measure memory, startup, battery and thermal behavior on representative devices.
5. Demonstrate an authenticated update that preserves the profile and survives interruption, then establish repeatable signed Android builds and native device CI.

No defensible calendar or cost estimate follows from the current desktop tests. Estimate after the engine/wallet prototype identifies which components can be reused and which need replacement. Companion development has the lowest browser-engine uncertainty; a maintained Chromium fork carries the largest ongoing cost.
