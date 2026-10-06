// Marlin Updater: a tiny Sparkle host that lives at
// Marlin.app/Contents/Helpers/Marlin Updater.app and updates the outer Marlin.app.
// Marlin's own executable is a launcher script, so Sparkle cannot run inside it.
//
// The browser shows updates in its own UI (About page and sidebar), so the
// daemon drives this helper and reads one JSON object per line from stdout:
//   --json-check     {"event":"available",...} | {"event":"none"} | {"event":"error",...}
//   --json-install   download progress, then Marlin closes, updates and reopens
//   --check-now      fallback: Sparkle's standard window ("marlin update" outside the browser)
import AppKit
import Sparkle

signal(SIGPIPE, SIG_IGN) // the daemon stops reading once it shuts Marlin down for the install

let marlinApp = Bundle.main.bundleURL
    .deletingLastPathComponent()   // Helpers
    .deletingLastPathComponent()   // Contents
    .deletingLastPathComponent()   // Marlin.app
let args = CommandLine.arguments
let mode = args.contains("--json-install") ? "install" : args.contains("--json-check") ? "check" : "window"

func emit(_ event: String, _ fields: [String: Any] = [:]) {
    var obj = fields
    obj["event"] = event
    if let data = try? JSONSerialization.data(withJSONObject: obj), var line = String(data: data, encoding: .utf8) {
        line += "\n"
        FileHandle.standardOutput.write(line.data(using: .utf8)!)
    }
}

func describe(_ item: SUAppcastItem) -> [String: Any] {
    [
        "version": item.displayVersionString,
        "build": item.versionString,
        "notes": item.itemDescription ?? "",
        "size": item.contentLength,
    ]
}

/// Asks the Marlin daemon to close Chromium so Sparkle can replace the bundle.
func stopMarlin() {
    let state = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Marlin/state.json")
    guard let data = try? Data(contentsOf: state),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let port = json["port"] as? Int, let token = json["token"] as? String,
          let url = URL(string: "http://127.0.0.1:\(port)/shutdown") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.timeoutInterval = 5
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { _, _, _ in done.signal() }.resume()
    _ = done.wait(timeout: .now() + 6)
    let chromium = marlinApp.appendingPathComponent("Contents/MacOS/Chromium").path
    for _ in 0..<60 {
        let running = NSWorkspace.shared.runningApplications.contains { $0.executableURL?.path == chromium }
        if !running { return }
        Thread.sleep(forTimeInterval: 0.25)
    }
}

/// Headless user driver: the browser UI renders everything, Sparkle does the work.
final class JSONDriver: NSObject, SPUUserDriver {
    private var expected: UInt64 = 0
    private var received: UInt64 = 0

    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: false, sendSystemProfile: false))
    }
    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) { emit("checking") }
    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        emit("available", describe(appcastItem))
        reply(mode == "install" ? .install : .dismiss)
    }
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        emit("none")
        acknowledgement()
    }
    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        emit("error", ["message": error.localizedDescription])
        acknowledgement()
    }
    func showDownloadInitiated(cancellation: @escaping () -> Void) { emit("downloading") }
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) { expected = expectedContentLength }
    func showDownloadDidReceiveData(ofLength length: UInt64) {
        let before = expected > 0 ? Int(received * 100 / expected) : 0
        received += length
        let now = expected > 0 ? Int(received * 100 / expected) : 0
        if now != before { emit("progress", ["percent": now, "received": received, "total": expected]) }
    }
    func showDownloadDidStartExtractingUpdate() { emit("extracting") }
    func showExtractionReceivedProgress(_ progress: Double) {}
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        emit("installing")
        reply(.install)
    }
    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {}
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
        emit("installed")
        acknowledgement()
    }
    func showUpdateInFocus() {}
    func dismissUpdateInstallation() {}
}

final class Delegate: NSObject, SPUUpdaterDelegate {
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                 untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        emit("restarting")
        DispatchQueue.global().async {
            stopMarlin()
            DispatchQueue.main.async { installHandler() }
        }
        return true
    }

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        if mode == "check" { emit("available", describe(item)) }
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: Error) {
        if mode == "check" { emit("none") }
    }

    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        if let error, mode == "check" {
            let code = (error as NSError).code
            if code != Int(SUError.noUpdateError.rawValue) { emit("error", ["message": error.localizedDescription]) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
    }
}

guard let host = Bundle(url: marlinApp) else { exit(1) }
let app = NSApplication.shared
app.setActivationPolicy(mode == "window" ? .regular : .prohibited)
let delegate = Delegate()
let driver: SPUUserDriver = mode == "window"
    ? SPUStandardUserDriver(hostBundle: host, delegate: nil)
    : JSONDriver()
let updater = SPUUpdater(hostBundle: host, applicationBundle: host, userDriver: driver, delegate: delegate)
do { try updater.start() } catch { emit("error", ["message": "\(error)"]); exit(1) }
switch mode {
case "check": updater.checkForUpdateInformation()
case "install": updater.checkForUpdates()
default:
    app.activate(ignoringOtherApps: true)
    updater.checkForUpdates()
}
app.run()
