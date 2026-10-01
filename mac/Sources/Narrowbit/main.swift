import AppKit
import WebKit
import UserNotifications

/// Narrowbit.app: starts `narrowbit ui --app` in the background and shows it in a native window.
/// All behaviour lives in the TypeScript runtime; this file only adds what a browser tab can't:
/// a Dock icon, a native folder picker, a notification when a command needs approval, and
/// stopping the server when the app quits.
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var window: NSWindow!
    private var web: WKWebView!
    private var server: Process?
    private var serverInput: Pipe?
    private var stderrText = ""
    private var loaded = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        // Asked once; macOS remembers the answer. Without it we fall back to a single Dock bounce.
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "narrowbit")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Narrowbit"
        window.minSize = NSSize(width: 720, height: 520)
        window.contentView = web
        window.setFrameAutosaveName("NarrowbitMain")
        if !window.setFrameUsingName("NarrowbitMain") { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        showMessage("Starting Narrowbit…", detail: nil)
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        // Closing stdin makes `narrowbit ui --app` exit on its own; terminate() is the backstop.
        try? serverInput?.fileHandleForWriting.close()
        server?.terminate()
    }

    // MARK: server

    private func startServer() {
        let p = Process()
        // A login shell, so the app sees the same PATH (node, narrowbit, claude) as Terminal does.
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        let bin = ProcessInfo.processInfo.environment["NARROWBIT_BIN"] ?? "narrowbit"
        p.arguments = ["-lc", "exec \(bin) ui --app"]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        // Tells the server this window relaunches it on exit code 75, so a self-update can restart it.
        // Older windows lack this, and the server then asks the user to reopen the app instead.
        env["NARROWBIT_SHELL_RESTART"] = "1"
        p.environment = env
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser

        let input = Pipe(), out = Pipe(), err = Pipe()
        p.standardInput = input
        p.standardOutput = out
        p.standardError = err
        var buffer = ""
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            guard let chunk = String(data: h.availableData, encoding: .utf8), !chunk.isEmpty else { return }
            buffer += chunk
            while let nl = buffer.firstIndex(of: "\n") {
                let line = String(buffer[..<nl])
                buffer = String(buffer[buffer.index(after: nl)...])
                if line.hasPrefix("narrowbit ui: "), let url = URL(string: String(line.dropFirst("narrowbit ui: ".count))) {
                    DispatchQueue.main.async {
                        self?.loaded = true
                        self?.web.load(URLRequest(url: url))
                    }
                }
            }
        }
        err.fileHandleForReading.readabilityHandler = { [weak self] h in
            guard let chunk = String(data: h.availableData, encoding: .utf8), !chunk.isEmpty else { return }
            DispatchQueue.main.async { self?.stderrText = String(((self?.stderrText ?? "") + chunk).suffix(4000)) }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self else { return }
                // Exit code 75 = "updated, please restart me": relaunch the server and reload the window.
                if proc.terminationStatus == 75 {
                    self.loaded = false
                    self.showMessage("Narrowbit was updated", detail: "Restarting…")
                    self.startServer()
                    return
                }
                let why = self.stderrText.isEmpty ? "exit code \(proc.terminationStatus)" : self.stderrText
                self.showMessage(
                    "Narrowbit's engine stopped",
                    detail: "\(why)\n\nQuit Narrowbit (⌘Q) and reopen it. If it keeps stopping, run `narrowbit doctor` in Terminal — the app runs the `narrowbit` command, so it must be installed (`npm link` in the Narrowbit folder, or set NARROWBIT_BIN).")
            }
        }
        do {
            try p.run()
            server = p
            serverInput = input
        } catch {
            showMessage("Couldn't start Narrowbit", detail: error.localizedDescription)
        }
    }

    private func showMessage(_ title: String, detail: String?) {
        func esc(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        }
        let html = """
        <html><head><meta name="color-scheme" content="light dark"><style>
        body{font:14px -apple-system,system-ui;display:grid;place-items:center;height:100vh;margin:0;background:Canvas;color:CanvasText}
        div{max-width:560px;padding:24px}pre{white-space:pre-wrap;font:12px ui-monospace,Menlo;opacity:.8}</style></head>
        <body><div><h2>\(esc(title))</h2>\(detail.map { "<pre>\(esc($0))</pre>" } ?? "")</div></body></html>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    // MARK: page → app

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "pickFolder":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.prompt = "Open"
            panel.message = "Choose a repository for Narrowbit to work in"
            panel.beginSheetModal(for: window) { [weak self] resp in
                guard resp == .OK, let path = panel.url?.path,
                      let data = try? JSONEncoder().encode(path), let arg = String(data: data, encoding: .utf8) else { return }
                self?.web.evaluateJavaScript("window.narrowbitFolderPicked(\(arg))")
            }
        case "openUrl":
            // Sign-in pages for connectors open in the user's own browser, never inside this window.
            if let raw = body["url"] as? String, let url = URL(string: raw), url.scheme == "https" || url.scheme == "http" {
                NSWorkspace.shared.open(url)
            }
        case "copy":
            if let text = body["text"] as? String {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
        case "attention", "finished":
            // A command or question is waiting for you, or a run ended. In the background this is a notification
            // (like the Claude app's), not a bouncing Dock icon; clicking it brings the window forward.
            if NSApp.isActive { break }
            let text = (body["text"] as? String) ?? ""
            let center = UNUserNotificationCenter.current()
            center.getNotificationSettings { settings in
                guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
                    DispatchQueue.main.async { NSApp.requestUserAttention(.informationalRequest) } // one bounce at most
                    return
                }
                let content = UNMutableNotificationContent()
                content.title = type == "attention" ? "Narrowbit needs your OK" : "Narrowbit finished"
                content.body = String(text.prefix(200))
                content.sound = type == "attention" ? .default : nil
                center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
            }
        default:
            break
        }
    }

    /// Only the local server is shown in the window; any other link opens in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, let host = url.host, host != "127.0.0.1", host != "localhost" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // MARK: menu

    private func buildMenu() {
        let main = NSMenu()
        func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        let app = NSMenu()
        // Version, update status and diagnostics live in the app's own About section; open that.
        app.addItem(item("About Narrowbit", #selector(showAbout), ""))
        app.addItem(item("Check for Updates…", #selector(checkForUpdates), ""))
        app.addItem(.separator())
        app.addItem(item("Hide Narrowbit", #selector(NSApplication.hide(_:)), "h"))
        app.addItem(item("Quit Narrowbit", #selector(NSApplication.terminate(_:)), "q"))
        // Without an Edit menu, ⌘C/⌘V/⌘A don't reach the text fields in a WKWebView.
        let edit = NSMenu(title: "Edit")
        edit.addItem(item("Undo", Selector(("undo:")), "z"))
        edit.addItem(item("Redo", Selector(("redo:")), "z", [.command, .shift]))
        edit.addItem(.separator())
        edit.addItem(item("Cut", #selector(NSText.cut(_:)), "x"))
        edit.addItem(item("Copy", #selector(NSText.copy(_:)), "c"))
        edit.addItem(item("Paste", #selector(NSText.paste(_:)), "v"))
        edit.addItem(item("Select All", #selector(NSText.selectAll(_:)), "a"))
        let view = NSMenu(title: "View")
        view.addItem(item("Reload", #selector(reload), "r"))
        let win = NSMenu(title: "Window")
        win.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        win.addItem(item("Close", #selector(NSWindow.performClose(_:)), "w"))
        for (title, menu) in [("Narrowbit", app), ("Edit", edit), ("View", view), ("Window", win)] {
            let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            top.submenu = menu
            main.addItem(top)
        }
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }

    @objc private func showAbout() {
        if loaded { web.evaluateJavaScript("window.narrowbitShowAbout && window.narrowbitShowAbout(false)") }
    }

    @objc private func checkForUpdates() {
        if loaded { web.evaluateJavaScript("window.narrowbitShowAbout && window.narrowbitShowAbout(true)") }
    }

    @objc private func reload() {
        if loaded { web.reload() }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
