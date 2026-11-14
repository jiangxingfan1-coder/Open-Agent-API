import Cocoa
import UserNotifications
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate,
    WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate, UNUserNotificationCenterDelegate
{
    var window: NSWindow!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var serverProcess: Process?
    var startedOwnServer = false
    /// A gateway of this data folder that outlived an earlier run of the app and was verified to be
    /// ours; "Restart Gateway" stops it, quitting the app leaves it alone.
    var attachedPid: Int?
    /// The first-launch seeding runs once; a reload while it runs must not start it again.
    var seedingInProgress = false

    /// How this run was asked to behave (isolated data folder and port, see docs/install.md).
    let options = ShellLaunchOptions.parse(
        environment: ProcessInfo.processInfo.environment, arguments: CommandLine.arguments)

    /// The gateway port, read from config.json at every start (never fixed here).
    var port = gatewayDefaultPort
    var baseURL: String { "http://127.0.0.1:\(port)" }

    /// Boot runs on its own queue; a newer boot (Restart Gateway) makes an older one stop.
    let bootQueue = DispatchQueue(label: "dev.oaa.desktop.boot")
    let bootLock = NSLock()
    var bootGeneration = 0

    /// Like Possibility's inset title bar: no title strip, traffic lights sit in a 52pt band
    /// centred on the console's sidebar head row (26pt from the top).
    let titleBandHeight: CGFloat = 52
    let trafficLightX: CGFloat = 20

    lazy var appSupportDir: String = {
        let fm = FileManager.default
        // Isolated run: everything the shell reads or writes lives in the folder it was given.
        if let home = options.home {
            try? fm.createDirectory(
                atPath: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            return home
        }
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = base.appendingPathComponent("OpenAgentAPI", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
    }()

    lazy var appRootDir: String = {
        if let res = Bundle.main.resourcePath {
            let bundled = (res as NSString).appendingPathComponent("app")
            if FileManager.default.fileExists(atPath: (bundled as NSString).appendingPathComponent("dist/src/cli.js")) {
                return bundled
            }
        }
        return FileManager.default.currentDirectoryPath
    }()

    func resolveActiveToken() -> String {
        let fm = FileManager.default
        var candidates = [(appSupportDir as NSString).appendingPathComponent("admin.token")]
        // An isolated run must never pick up the key of another gateway.
        if !options.isolated {
            candidates += [
                (appRootDir as NSString).appendingPathComponent(".oaa/admin.token"),
                (NSHomeDirectory() as NSString).appendingPathComponent(".open-agent-api/admin.token"),
            ]
        }
        for path in candidates {
            if fm.fileExists(atPath: path),
               let raw = try? String(contentsOfFile: path, encoding: .utf8) {
                let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    return trimmed
                }
            }
        }
        return ""
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        // Wrong isolation settings: say so and quit before anything is read or written.
        if let problem = options.problem {
            let text = StartupProblem.text(for: problem)
            let alert = NSAlert()
            alert.messageText = text.title
            alert.informativeText = text.body
            alert.alertStyle = .warning
            alert.addButton(withTitle: tr(.buttonOK))
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        setupMainMenu()
        setupStatusBar()
        setupMainWindow()
        if notificationsAvailable {
            UNUserNotificationCenter.current().delegate = self
            // `open -a "Open Agent API" --args --enable-notifications`: ask macOS for permission now,
            // then confirm with a test notification and switch the console's approval notifications on.
            if CommandLine.arguments.contains("--enable-notifications") {
                requestNotificationPermission(confirm: true)
            }
        }
        // The folders are resolved once, here on the main thread, before the boot queue uses them.
        _ = appSupportDir
        _ = appRootDir
        startBoot(terminating: nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            window.makeKeyAndOrderFront(nil)
        }
        return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Keep the gateway running in the menu bar when closing the console window.
        sender.orderOut(nil)
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopManagedKernel()
    }

    // MARK: - Menus

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: tr(.menuAbout), action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: tr(.menuSettings), action: #selector(openSettings), keyEquivalent: ",")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: tr(.menuReloadConsole), action: #selector(reloadConsole), keyEquivalent: "r")
        appMenu.addItem(withTitle: tr(.menuRestartGateway), action: #selector(restartKernel), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: tr(.menuHide), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(
            withTitle: tr(.menuHideOthers), action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: tr(.menuShowAll), action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: tr(.menuQuit), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        // Edit menu (enables Cmd+C, Cmd+V, Cmd+X, Cmd+A inside WKWebView)
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: tr(.menuEdit))
        editMenu.addItem(withTitle: tr(.menuUndo), action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: tr(.menuRedo), action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: tr(.menuCut), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: tr(.menuCopy), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: tr(.menuPaste), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: tr(.menuSelectAll), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: tr(.menuView))
        viewMenu.addItem(withTitle: tr(.menuCommandPalette), action: #selector(openCommandPalette), keyEquivalent: "k")
        viewMenu.addItem(withTitle: tr(.menuToggleSidebar), action: #selector(toggleConsoleSidebar), keyEquivalent: "\\")
        viewMenu.addItem(NSMenuItem.separator())
        let fullScreen = viewMenu.addItem(
            withTitle: tr(.menuFullScreen), action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewMenuItem.submenu = viewMenu

        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: tr(.menuWindow))
        windowMenu.addItem(withTitle: tr(.menuMinimize), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: tr(.menuZoom), action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(NSMenuItem.separator())
        windowMenu.addItem(withTitle: tr(.menuShowConsole), action: #selector(openStudioWindow), keyEquivalent: "0")
        windowMenu.addItem(withTitle: tr(.menuCloseWindow), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenuItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    private func setupStatusBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            // Template image of the O + A mark; macOS tints it for light, dark and highlighted bars.
            if let image = NSImage(named: "StatusTemplate") {
                image.isTemplate = true
                image.size = NSSize(width: 18, height: 18)
                button.image = image
            } else {
                button.title = "OAA"
            }
            button.toolTip = tr(.statusTooltip)
        }
        let menu = NSMenu()
        menu.addItem(withTitle: tr(.statusOpenConsole), action: #selector(openStudioWindow), keyEquivalent: "")
        menu.addItem(withTitle: tr(.statusOpenInBrowser), action: #selector(openInBrowser), keyEquivalent: "")
        menu.addItem(withTitle: tr(.menuSettings), action: #selector(openSettings), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: tr(.statusCopyAdminKey), action: #selector(copyAdminToken), keyEquivalent: "")
        menu.addItem(withTitle: tr(.statusCopyBaseUrl), action: #selector(copyCompatUrl), keyEquivalent: "")
        menu.addItem(withTitle: tr(.statusOpenDataFolder), action: #selector(openDataFolder), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: tr(.menuRestartGateway), action: #selector(restartKernel), keyEquivalent: "")
        menu.addItem(withTitle: tr(.menuQuit), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
    }

    // MARK: - Window chrome

    private func setupMainWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1400, height: 880)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        // The title stays for Mission Control and the Window menu but is never drawn.
        window.title =
            options.isolated ? tr(.windowTitleIsolated, ["title": "Open Agent API"]) : "Open Agent API"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 980, height: 640)
        window.center()
        // An isolated run keeps no window position or appearance in the user's preferences.
        if !options.isolated { window.setFrameAutosaveName("OAAMainWindow") }
        window.delegate = self
        let defaults = UserDefaults.standard
        applyAppearance(
            theme: options.isolated ? "system" : defaults.string(forKey: "OAAAppearance") ?? "system",
            palette: options.isolated ? "black" : defaults.string(forKey: "OAAPalette") ?? "black"
        )

        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        // Page → shell bridge: window dragging, appearance and desktop actions.
        controller.add(self, name: "oaa")
        config.userContentController = controller
        // An isolated run leaves no web storage (console preferences, language choice) on disk.
        if options.isolated { config.websiteDataStore = WKWebsiteDataStore.nonPersistent() }

        webView = WKWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        layoutTrafficLights()

        showSplashHTML(status: tr(.splashStarting))
    }

    func windowDidResize(_ notification: Notification) { layoutTrafficLights() }
    func windowDidEndLiveResize(_ notification: Notification) { layoutTrafficLights() }
    func windowDidExitFullScreen(_ notification: Notification) { layoutTrafficLights() }
    func windowDidBecomeKey(_ notification: Notification) { layoutTrafficLights() }
    func windowDidResignKey(_ notification: Notification) { layoutTrafficLights() }

    /// Electron's hiddenInset technique: grow the title bar container and centre the buttons in it.
    private func layoutTrafficLights() {
        guard let window = window, !window.styleMask.contains(.fullScreen),
            let close = window.standardWindowButton(.closeButton),
            let mini = window.standardWindowButton(.miniaturizeButton),
            let zoom = window.standardWindowButton(.zoomButton),
            let container = close.superview?.superview
        else { return }
        var band = container.frame
        band.size.height = titleBandHeight
        band.origin.y = window.frame.height - titleBandHeight
        container.frame = band
        let measured = mini.frame.origin.x - close.frame.origin.x
        let step = measured > 0 ? measured : 20
        for (index, button) in [close, mini, zoom].enumerated() {
            var origin = button.frame.origin
            origin.x = trafficLightX + CGFloat(index) * step
            origin.y = (titleBandHeight - button.frame.height) / 2
            button.setFrameOrigin(origin)
        }
    }

    private func applyAppearance(theme: String, palette: String) {
        switch theme {
        case "light": window.appearance = NSAppearance(named: .aqua)
        case "dark": window.appearance = NSAppearance(named: .darkAqua)
        default: window.appearance = nil
        }
        let dark = window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        if dark {
            window.backgroundColor =
                palette == "tide"
                ? NSColor(srgbRed: 10 / 255, green: 18 / 255, blue: 17 / 255, alpha: 1)
                : NSColor.black
        } else {
            window.backgroundColor = NSColor(srgbRed: 236 / 255, green: 233 / 255, blue: 225 / 255, alpha: 1)
        }
        layoutTrafficLights()
    }

    // MARK: - Page bridge

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
    ) {
        guard message.name == "oaa", let body = message.body as? [String: Any],
            let type = body["type"] as? String
        else { return }
        switch type {
        case "drag":
            // Blank title-bar areas of the page move the window, like a native title bar.
            if let event = NSApp.currentEvent, event.type == .leftMouseDown || event.type == .leftMouseDragged {
                window.performDrag(with: event)
            }
        case "zoom":
            let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
            if action == "Minimize" {
                window.performMiniaturize(nil)
            } else if action != "None" {
                window.performZoom(nil)
            }
        case "appearance":
            let theme = body["theme"] as? String ?? "system"
            let palette = body["palette"] as? String ?? "black"
            if !options.isolated {
                UserDefaults.standard.set(theme, forKey: "OAAAppearance")
                UserDefaults.standard.set(palette, forKey: "OAAPalette")
            }
            applyAppearance(theme: theme, palette: palette)
        case "action":
            switch (body["name"] as? String) ?? "" {
            case "openDataFolder": openDataFolder()
            case "openInBrowser": openInBrowser()
            case "copyCompatUrl": copyCompatUrl()
            case "copyAdminToken": copyAdminToken()
            case "restartKernel": restartKernel()
            default: break
            }
        case "badge":
            // JSON numbers arrive as NSNumber; clamp to a sane, non-negative count.
            let raw = (body["count"] as? NSNumber)?.intValue ?? 0
            updateBadge(max(0, min(raw, 9999)))
        case "notifications":
            if (body["enabled"] as? Bool) == true { requestNotificationPermission() }
        case "notify":
            guard let id = body["id"] as? String, !id.isEmpty, id.count <= 200 else { return }
            postNotification(
                id: id,
                title: (body["title"] as? String) ?? "Open Agent API",
                body: (body["body"] as? String) ?? "",
                test: (body["test"] as? Bool) == true)
        default:
            break
        }
    }

    // MARK: - Approval notifications

    /// Notification Center needs a real bundle; running the bare binary must not crash.
    private var notificationsAvailable: Bool { Bundle.main.bundleIdentifier != nil }

    private func reportNotificationStatus(_ status: String) {
        DispatchQueue.main.async {
            self.webView?.evaluateJavaScript(
                "window.oaaShell && window.oaaShell.notificationStatus && window.oaaShell.notificationStatus('\(status)')",
                completionHandler: nil)
        }
    }

    private func requestNotificationPermission(confirm: Bool = false) {
        guard notificationsAvailable else { return reportNotificationStatus("unavailable") }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) {
            granted, error in
            self.reportNotificationStatus(error != nil ? "unavailable" : granted ? "granted" : "denied")
            guard confirm, granted, error == nil else { return }
            DispatchQueue.main.async {
                self.postNotification(
                    id: "test", title: "Open Agent API",
                    body: tr(.notificationTestBody), test: true)
                self.enableConsoleNotifications(attempt: 0)
            }
        }
    }

    /// Mirror the permission into the console preference once the page has loaded.
    private func enableConsoleNotifications(attempt: Int) {
        webView?.evaluateJavaScript(
            "window.oaaShell && window.oaaShell.setNotify ? (window.oaaShell.setNotify(true), true) : false"
        ) { result, _ in
            if (result as? Bool) != true && attempt < 20 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.enableConsoleNotifications(attempt: attempt + 1)
                }
            }
        }
    }

    private func postNotification(id: String, title: String, body: String, test: Bool) {
        guard notificationsAvailable else { return reportNotificationStatus("unavailable") }
        // Like Possibility: stay quiet while the console window is in front (tests always show).
        if !test && NSApp.isActive && window.isKeyWindow { return }
        let content = UNMutableNotificationContent()
        content.title = String(title.prefix(80))
        content.body = String(body.prefix(240))
        content.sound = .default
        content.threadIdentifier = "oaa.approvals"
        if !test { content.userInfo = ["runId": id] }
        // One notification per request: a repeat replaces rather than stacks.
        let request = UNNotificationRequest(identifier: "oaa.run.\(id)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if error != nil { self.reportNotificationStatus("unavailable") }
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let runId = response.notification.request.content.userInfo["runId"] as? String
        DispatchQueue.main.async {
            self.openStudioWindow()
            // JSON-encode the ID so it can never break out of the script string.
            if let runId, let data = try? JSONSerialization.data(withJSONObject: [runId]),
                let encoded = String(data: data, encoding: .utf8)
            {
                self.webView.evaluateJavaScript(
                    "window.oaaShell && window.oaaShell.openRun && window.oaaShell.openRun(\(encoded)[0])",
                    completionHandler: nil)
            }
        }
        completionHandler()
    }

    /// Requests waiting for this person's approval, on the Dock icon and beside the menu-bar mark.
    private func updateBadge(_ count: Int) {
        let label = count > 99 ? "99+" : String(count)
        NSApp.dockTile.badgeLabel = count > 0 ? label : nil
        if let button = statusItem?.button {
            button.imagePosition = count > 0 ? .imageLeading : .imageOnly
            button.title = count > 0 ? label : ""
            button.toolTip =
                count > 0
                ? tr(count == 1 ? .statusBadgeOne : .statusBadgeMany, ["count": label])
                : tr(.statusTooltip)
        }
    }

    // MARK: - WKUIDelegate (dialogs, file pickers, new windows)

    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        // Links with target=_blank (agent documentation) open in the default browser.
        if let url = navigationAction.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: tr(.buttonOK))
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: tr(.buttonConfirm))
        alert.addButton(withTitle: tr(.buttonCancel))
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    /// <input type="file"> needs a native open panel inside WKWebView (token file, attachments, bundles).
    func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        // The admin token lives in a dot directory (.oaa/admin.token).
        panel.showsHiddenFiles = true
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    // MARK: - Navigation & downloads

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url,
            ["http", "https"].contains(url.scheme ?? ""), let host = url.host,
            !["127.0.0.1", "localhost", "::1"].contains(host)
        {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    /// Outputs, step records and artifacts are saved to ~/Downloads without overwriting files.
    func download(
        _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let fm = FileManager.default
        guard let folder = fm.urls(for: .downloadsDirectory, in: .userDomainMask).first else {
            completionHandler(nil)
            return
        }
        let name = (suggestedFilename as NSString).lastPathComponent
        let stem = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var target = folder.appendingPathComponent(name)
        var n = 2
        while fm.fileExists(atPath: target.path) {
            target = folder.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
            n += 1
        }
        completionHandler(target)
    }

    // MARK: - Content

    private func installUserScripts(token: String) {
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(
            WKUserScript(
                source: "document.documentElement.dataset.shell = 'macos';",
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // The admin key goes into sessionStorage only (the one place the console reads it from), never
        // into the persistent localStorage, and only into the main frame on the gateway's own origin.
        controller.addUserScript(
            WKUserScript(
                source: ConsoleBridge.tokenScript(token: token, origin: ConsoleBridge.origin(port: port)),
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    func showSplashHTML(status: String?, problem: (title: String, body: String)? = nil) {
        webView.loadHTMLString(SplashPage.html(status: status, problem: problem), baseURL: nil)
    }

    func connectWebView() {
        seedDefaultAgentsIfNeeded()
        installUserScripts(token: resolveActiveToken())
        if let url = URL(string: baseURL) {
            webView.load(URLRequest(url: url))
        }
    }

    @objc func openStudioWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func openSettings() {
        openStudioWindow()
        webView.evaluateJavaScript(
            "window.oaaShell ? window.oaaShell.openSettings() : (location.hash = 'settings')",
            completionHandler: nil)
    }

    @objc func openCommandPalette() {
        webView.evaluateJavaScript("window.oaaShell && window.oaaShell.openCommand()", completionHandler: nil)
    }

    @objc func toggleConsoleSidebar() {
        webView.evaluateJavaScript("window.oaaShell && window.oaaShell.toggleSidebar()", completionHandler: nil)
    }

    @objc func openInBrowser() {
        if let url = URL(string: baseURL) {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func reloadConsole() {
        connectWebView()
    }

    @objc func copyAdminToken() {
        let token = resolveActiveToken()
        guard !token.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(token, forType: .string)
    }

    @objc func copyCompatUrl() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("\(baseURL)/v1/compat", forType: .string)
    }

    @objc func openDataFolder() {
        NSWorkspace.shared.open(URL(fileURLWithPath: appSupportDir))
    }

    @objc func restartKernel() {
        showSplashHTML(status: tr(.splashRestarting))
        stopManagedKernel()
        // A gateway that outlived an earlier run (verified to be ours when it was found) is stopped too.
        let leftover = attachedPid
        attachedPid = nil
        startBoot(terminating: leftover)
    }

    @objc func showAbout() {
        let alert = NSAlert()
        // The version comes from Info.plist (written from package.json by scripts/package-all.mjs);
        // never write it here. A bare binary without a bundle has no Info.plist and shows no version.
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        alert.messageText = version.map { "Open Agent API \($0)" } ?? "Open Agent API"
        alert.informativeText = tr(.aboutBody, ["url": baseURL, "dir": appSupportDir])
        alert.alertStyle = .informational
        alert.runModal()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
