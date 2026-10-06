// Marlin Updater: a tiny Sparkle host that lives at
// Marlin.app/Contents/Helpers/Marlin Updater.app and updates the outer Marlin.app.
// Marlin's own executable is a launcher script, so Sparkle cannot run inside it.
//
//   (no args)      quiet check when the human opens Marlin; exits if nothing new
//   --check-now    user initiated check ("marlin update"), always shows a result
import AppKit
import Sparkle

let marlinApp = Bundle.main.bundleURL
    .deletingLastPathComponent()   // Helpers
    .deletingLastPathComponent()   // Contents
    .deletingLastPathComponent()   // Marlin.app
let userInitiated = CommandLine.arguments.contains("--check-now")

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
    req.setValue("127.0.0.1:\(port)", forHTTPHeaderField: "Host")
    req.timeoutInterval = 5
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { _, _, _ in done.signal() }.resume()
    _ = done.wait(timeout: .now() + 6)
    // Wait for Chromium inside this bundle to exit.
    let chromium = marlinApp.appendingPathComponent("Contents/MacOS/Chromium").path
    for _ in 0..<40 {
        let running = NSWorkspace.shared.runningApplications.contains { $0.executableURL?.path == chromium }
        if !running { return }
        Thread.sleep(forTimeInterval: 0.25)
    }
}

final class Delegate: NSObject, SPUUpdaterDelegate {
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                 untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        DispatchQueue.global().async {
            stopMarlin()
            DispatchQueue.main.async { installHandler() }
        }
        return true
    }

    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        // Nothing to install (or the human dismissed it): get out of the way.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
    }
}

guard let host = Bundle(url: marlinApp) else { exit(1) }
let app = NSApplication.shared
app.setActivationPolicy(userInitiated ? .regular : .accessory)
let delegate = Delegate()
let driver = SPUStandardUserDriver(hostBundle: host, delegate: nil)
let updater = SPUUpdater(hostBundle: host, applicationBundle: host, userDriver: driver, delegate: delegate)
do { try updater.start() } catch { FileHandle.standardError.write("Sparkle: \(error)\n".data(using: .utf8)!); exit(1) }
if userInitiated {
    app.activate(ignoringOtherApps: true)
    updater.checkForUpdates()
} else {
    updater.checkForUpdatesInBackground()
}
app.run()
