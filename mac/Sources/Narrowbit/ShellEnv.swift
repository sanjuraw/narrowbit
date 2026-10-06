import Foundation

/// The environment the user's own shell sets up, read once at launch, the way VS Code does it.
///
/// An app opened from the Dock or Finder gets launchd's bare environment. A login shell (`zsh -l`) adds what
/// `~/.zprofile` sets, but not `~/.zshrc`, which is where nvm, bun, pyenv, Python.org installers and most people
/// put their PATH changes, API keys and proxies. So the app could miss `bun` or pick a different `python3` than
/// Terminal does. Here the user's shell runs once as interactive + login, prints its environment between two
/// markers, and exits; stdin is closed so nothing in a startup file can wait for input, and a slow or broken
/// startup file only costs the timeout before falling back.
enum ShellEnv {
    /// Variables that describe the throwaway shell itself rather than the user's setup.
    static let skipped: Set<String> = ["PWD", "OLDPWD", "SHLVL", "_", "NARROWBIT_RESOLVING_SHELL_ENV"]

    static func resolve(timeout: TimeInterval = 5) -> [String: String]? {
        let current = ProcessInfo.processInfo.environment
        let fm = FileManager.default
        let shell = current["SHELL"].flatMap { fm.isExecutableFile(atPath: $0) ? $0 : nil } ?? "/bin/zsh"
        let mark = "__NARROWBIT_ENV_\(UUID().uuidString)__"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-ilc", "printf '%s' '\(mark)'; /usr/bin/env -0; printf '%s' '\(mark)'"]
        var env = current
        // Lets a startup file skip slow or interactive parts when it is only being asked for the environment.
        env["NARROWBIT_RESOLVING_SHELL_ENV"] = "1"
        p.environment = env
        p.currentDirectoryURL = fm.homeDirectoryForCurrentUser
        p.standardInput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        let out = Pipe()
        p.standardOutput = out
        do { try p.run() } catch { return nil }

        var data = Data()
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            data = out.fileHandleForReading.readDataToEndOfFile()
            done.signal()
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            p.terminate()
            return nil
        }
        p.waitUntilExit()
        return parse(data, mark: mark)
    }

    /// The `KEY=value` pairs between the two markers; anything a startup file printed around them is ignored.
    static func parse(_ data: Data, mark: String) -> [String: String]? {
        guard let text = String(data: data, encoding: .utf8),
              let start = text.range(of: mark),
              let end = text.range(of: mark, range: start.upperBound..<text.endIndex) else { return nil }
        var env: [String: String] = [:]
        for pair in text[start.upperBound..<end.lowerBound].split(separator: "\0") {
            guard let eq = pair.firstIndex(of: "="), eq != pair.startIndex else { continue }
            let key = String(pair[..<eq])
            if skipped.contains(key) { continue }
            env[key] = String(pair[pair.index(after: eq)...])
        }
        return env["PATH"] == nil ? nil : env
    }
}
