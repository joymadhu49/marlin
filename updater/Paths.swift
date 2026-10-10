import Foundation

func marlinStateURL(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
    workingDirectory: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
) -> URL {
    if let override = environment["MARLIN_HOME"], !override.isEmpty {
        return URL(fileURLWithPath: override, isDirectory: true, relativeTo: workingDirectory)
            .appendingPathComponent("state.json").standardizedFileURL
    }
    return homeDirectory.appendingPathComponent("Library/Application Support/Marlin/state.json")
}
