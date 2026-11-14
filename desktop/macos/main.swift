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

    let port = 8787
    var baseURL: String { "http://127.0.0.1:\(port)" }

    /// Like Possibility's inset title bar: no title strip, traffic lights sit in a 52pt band
    /// centred on the console's sidebar head row (26pt from the top).
    let titleBandHeight: CGFloat = 52
    let trafficLightX: CGFloat = 20

    lazy var appSupportDir: String = {
        let fm = FileManager.default
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

    func findNodeBinary() -> String {
        let fm = FileManager.default
        if let res = Bundle.main.resourcePath {
            let bundledNode = (res as NSString).appendingPathComponent("node/bin/node")
            if fm.isExecutableFile(atPath: bundledNode) {
                return bundledNode
            }
        }
        let home = NSHomeDirectory()
        let candidates = [
            "\(home)/.local/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "\(home)/.nvm/current/bin/node",
            "\(home)/.volta/bin/node"
        ]
        for path in candidates {
            if fm.isExecutableFile(atPath: path) {
                return path
            }
        }
        return "/usr/bin/env"
    }

    func resolveActiveToken() -> String {
        let fm = FileManager.default
        let candidates = [
            (appSupportDir as NSString).appendingPathComponent("admin.token"),
            (appRootDir as NSString).appendingPathComponent(".oaa/admin.token"),
            (NSHomeDirectory() as NSString).appendingPathComponent(".open-agent-api/admin.token")
        ]
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
        setupMainMenu()
        setupStatusBar()
        setupMainWindow()
        if notificationsAvailable {
            UNUserNotificationCenter.current().delegate = self
            // `open -a "Open Agent API" --args --enable-notifications`: ask macOS for permission now,
            // then confirm with a test notification and switch the console's 审批通知 on.
            if CommandLine.arguments.contains("--enable-notifications") {
                requestNotificationPermission(confirm: true)
            }
        }
        ensureKernelAndLoadUI()
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
        appMenu.addItem(withTitle: "关于 Open Agent API", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "设置…", action: #selector(openSettings), keyEquivalent: ",")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "重新载入控制台", action: #selector(reloadConsole), keyEquivalent: "r")
        appMenu.addItem(withTitle: "重启后台服务", action: #selector(restartKernel), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "隐藏 Open Agent API", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(
            withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 Open Agent API", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        // Edit menu (enables Cmd+C, Cmd+V, Cmd+X, Cmd+A inside WKWebView)
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "显示")
        viewMenu.addItem(withTitle: "命令面板", action: #selector(openCommandPalette), keyEquivalent: "k")
        viewMenu.addItem(withTitle: "切换侧栏", action: #selector(toggleConsoleSidebar), keyEquivalent: "\\")
        viewMenu.addItem(NSMenuItem.separator())
        let fullScreen = viewMenu.addItem(
            withTitle: "进入全屏幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewMenuItem.submenu = viewMenu

        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(NSMenuItem.separator())
        windowMenu.addItem(withTitle: "显示控制台", action: #selector(openStudioWindow), keyEquivalent: "0")
        windowMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
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
            button.toolTip = "Open Agent API · 智能体控制台"
        }
        let menu = NSMenu()
        menu.addItem(withTitle: "打开控制台", action: #selector(openStudioWindow), keyEquivalent: "")
        menu.addItem(withTitle: "在默认浏览器中打开", action: #selector(openInBrowser), keyEquivalent: "")
        menu.addItem(withTitle: "设置…", action: #selector(openSettings), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "复制管理员密钥", action: #selector(copyAdminToken), keyEquivalent: "")
        menu.addItem(withTitle: "拷贝服务地址（Base URL）", action: #selector(copyCompatUrl), keyEquivalent: "")
        menu.addItem(withTitle: "打开数据目录", action: #selector(openDataFolder), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "重启后台服务", action: #selector(restartKernel), keyEquivalent: "")
        menu.addItem(withTitle: "退出 Open Agent API", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
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
        window.title = "Open Agent API"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 980, height: 640)
        window.center()
        window.setFrameAutosaveName("OAAMainWindow")
        window.delegate = self
        applyAppearance(
            theme: UserDefaults.standard.string(forKey: "OAAAppearance") ?? "system",
            palette: UserDefaults.standard.string(forKey: "OAAPalette") ?? "black"
        )

        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        // Page → shell bridge: window dragging, appearance and desktop actions.
        controller.add(self, name: "oaa")
        config.userContentController = controller

        webView = WKWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        layoutTrafficLights()

        showSplashHTML(status: "正在启动后台服务 · 127.0.0.1:\(port)")
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
            UserDefaults.standard.set(theme, forKey: "OAAAppearance")
            UserDefaults.standard.set(palette, forKey: "OAAPalette")
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
                    body: "审批通知已开启：有请求等待你审批时，会这样提醒你。", test: true)
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
                ? "Open Agent API · \(label) 个请求等待审批"
                : "Open Agent API · 智能体控制台"
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
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确认")
        alert.addButton(withTitle: "取消")
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
        guard !token.isEmpty else { return }
        let escaped = token
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        let js = """
        try {
          sessionStorage.setItem('oaa-token', '\(escaped)');
          localStorage.setItem('oaa-token', '\(escaped)');
          localStorage.setItem('oaa_token', '\(escaped)');
          localStorage.setItem('oaa_admin_token', '\(escaped)');
          sessionStorage.setItem('oaa_token', '\(escaped)');
        } catch (e) {}
        """
        controller.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    }

    private func showSplashHTML(status: String) {
        // Brand splash: the O + A interlocked line mark, following the window appearance.
        let html = """
        <!doctype html>
        <html lang="zh-CN">
        <head>
          <meta charset="utf-8" />
          <style>
            :root { color-scheme: light dark; }
            body {
              margin: 0;
              height: 100vh;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              background: #000000;
              color: #f2f2f2;
              font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
              -webkit-font-smoothing: antialiased;
              user-select: none;
              cursor: default;
            }
            .drag { position: fixed; inset: 0 0 auto 0; height: 52px; }
            .mark { width: 92px; height: 89px; margin-bottom: 22px; }
            .mark g { fill: none; stroke: currentColor; stroke-width: 8; stroke-linecap: round; stroke-linejoin: round; }
            h1 { margin: 0; font: italic 400 34px/1.1 "Instrument Serif", "Iowan Old Style", Georgia, serif; letter-spacing: -0.01em; }
            .sub { margin: 10px 0 28px 0; color: #8e8e8e; font-size: 13px; letter-spacing: 0.24em; }
            p { display: flex; align-items: center; gap: 8px; margin: 0; color: #9d9d9d; font: 12px ui-monospace, "SF Mono", Menlo, monospace; }
            p::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #81d8d0; animation: tide 1.4s ease-in-out infinite; }
            @keyframes tide { 50% { opacity: 0.3; } }
            @media (prefers-color-scheme: light) {
              body { background: #ece9e1; color: #132220; }
              .sub { color: #66726e; }
              p { color: #5b6864; }
            }
          </style>
        </head>
        <body>
          <div class="drag"></div>
          <svg class="mark" viewBox="40.11 43 175.78 170" aria-hidden="true"><g><path d="M209.89 207L150.11 49L108.57 155"/><path d="M94.7 190.38L88.19 207"/><path d="M143.36 106.65A50 50 0 1 1 119.1 78.6"/></g></svg>
          <h1>Open Agent API</h1>
          <div class="sub">一次发布 · 随处调用</div>
          <p>\(status)</p>
          <script>
            document.querySelector('.drag').addEventListener('mousedown', function () {
              try { window.webkit.messageHandlers.oaa.postMessage({ type: 'drag' }); } catch (e) {}
            });
          </script>
        </body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func checkHealth(completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: "\(baseURL)/health") else {
            completion(false)
            return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 0.6
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                completion(true)
            } else {
                completion(false)
            }
        }.resume()
    }

    private func ensureKernelAndLoadUI() {
        checkHealth { [weak self] alive in
            guard let self = self else { return }
            if alive {
                DispatchQueue.main.async {
                    self.connectWebView()
                }
            } else {
                self.startManagedKernel()
                self.pollUntilReady(attemptsLeft: 45)
            }
        }
    }

    private func pollUntilReady(attemptsLeft: Int) {
        checkHealth { [weak self] alive in
            guard let self = self else { return }
            if alive {
                DispatchQueue.main.async {
                    self.connectWebView()
                }
            } else if attemptsLeft > 0 {
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) {
                    self.pollUntilReady(attemptsLeft: attemptsLeft - 1)
                }
            } else {
                DispatchQueue.main.async {
                    self.showSplashHTML(status: "后台服务没能启动（端口 \(self.port)）。请查看日志：\(self.appSupportDir)/oaa-desktop.log")
                }
            }
        }
    }

    private func seedDefaultAgentsIfNeeded() {
        let fm = FileManager.default
        // v2: seed the offline sample agent (calls no model) so a fresh install has one agent that works;
        // the agy example is published only when agy is installed.
        let marker = (appSupportDir as NSString).appendingPathComponent(".seeded-v2")
        if fm.fileExists(atPath: marker) { return }
        let tokenFile = (appSupportDir as NSString).appendingPathComponent("admin.token")
        guard fm.fileExists(atPath: tokenFile) else { return }

        var env = ProcessInfo.processInfo.environment
        let extraPaths = [
            "\(NSHomeDirectory())/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin"
        ]
        env["PATH"] = (extraPaths + [env["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")

        DispatchQueue.global().async { [weak self] in
            guard let self = self else { return }
            var examples = ["examples/sample-agent.json"]
            if self.nativeInstalled("antigravity") {
                examples.append("examples/agy-gemini-3.8-flash.oaa")
            }
            for rel in examples {
                let full = (self.appRootDir as NSString).appendingPathComponent(rel)
                if fm.fileExists(atPath: full) {
                    self.runCliSync(["publish", full, "--url", self.baseURL, "--token-file", tokenFile], env: env)
                }
            }
            try? "ok".write(toFile: marker, atomically: true, encoding: .utf8)
            DispatchQueue.main.async {
                self.webView.reload()
            }
        }
    }

    /// Whether config.json records an executable for this native engine that exists on disk.
    private func nativeInstalled(_ engine: String) -> Bool {
        let configPath = (appSupportDir as NSString).appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let lw = json["localWorker"] as? [String: Any],
              let native = lw["native"] as? [String: Any],
              let entry = native[engine] as? [String: Any],
              let exec = entry["executable"] as? String else { return false }
        return FileManager.default.isExecutableFile(atPath: exec)
    }

    private func runCliSync(_ args: [String], env: [String: String]) {
        let nodeBin = findNodeBinary()
        let cliPath = (appRootDir as NSString).appendingPathComponent("dist/src/cli.js")
        let proc = Process()
        if nodeBin == "/usr/bin/env" {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", cliPath] + args
        } else {
            proc.executableURL = URL(fileURLWithPath: nodeBin)
            proc.arguments = [cliPath] + args
        }
        proc.currentDirectoryURL = URL(fileURLWithPath: appRootDir)
        proc.environment = env
        try? proc.run()
        proc.waitUntilExit()
    }

    private func startManagedKernel() {
        let fm = FileManager.default
        let configPath = (appSupportDir as NSString).appendingPathComponent("config.json")

        var env = ProcessInfo.processInfo.environment
        let extraPaths = [
            "\(NSHomeDirectory())/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin"
        ]
        let existingPath = env["PATH"] ?? "/usr/bin:/bin"
        env["PATH"] = (extraPaths + [existingPath]).joined(separator: ":")

        if !fm.fileExists(atPath: configPath) {
            runCliSync(["init", "--dir", appSupportDir], env: env)
        }

        // Ensure installed local native CLI adapters (antigravity/agy, claude, codex, dsh) are enabled in config.json
        if let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
           var json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            var modified = false
            if json["localAgents"] != nil {
                json.removeValue(forKey: "localAgents")
                modified = true
            }
            if var lw = json["localWorker"] as? [String: Any],
               var native = lw["native"] as? [String: Any] {
                for (k, v) in native {
                    if var entry = v as? [String: Any],
                       let execPath = entry["executable"] as? String,
                       fm.isExecutableFile(atPath: execPath),
                       (entry["enabled"] as? Bool) != true {
                        entry["enabled"] = true
                        native[k] = entry
                        modified = true
                    }
                }
                if modified {
                    lw["native"] = native
                    json["localWorker"] = lw
                }
            }
            // The offline sample agent (examples/sample-agent.mjs) runs on the bundled Node; it calls
            // no model and uses no network. Re-written on every launch so the paths follow the app.
            let sampleScript = (appRootDir as NSString).appendingPathComponent("examples/sample-agent.mjs")
            if fm.fileExists(atPath: sampleScript), var lw = json["localWorker"] as? [String: Any] {
                var adapters = (lw["adapters"] as? [String: Any]) ?? [:]
                let nodeBin = findNodeBinary()
                let sample: [String: Any] = [
                    "transport": "acp",
                    "command": nodeBin == "/usr/bin/env" ? "node" : nodeBin,
                    "args": [sampleScript],
                    "enabled": true
                ]
                if !NSDictionary(dictionary: sample).isEqual(adapters["oaa-sample"] as? [String: Any] ?? [:]) {
                    adapters["oaa-sample"] = sample
                    lw["adapters"] = adapters
                    json["localWorker"] = lw
                    modified = true
                }
            }
            if modified,
               let updated = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) {
                try? updated.write(to: URL(fileURLWithPath: configPath))
            }
        }

        let nodeBin = findNodeBinary()
        let cliPath = (appRootDir as NSString).appendingPathComponent("dist/src/cli.js")
        let logPath = (appSupportDir as NSString).appendingPathComponent("oaa-desktop.log")
        fm.createFile(atPath: logPath, contents: nil)
        let logHandle = FileHandle(forWritingAtPath: logPath)

        let proc = Process()
        if nodeBin == "/usr/bin/env" {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", cliPath, "serve", "--config", configPath]
        } else {
            proc.executableURL = URL(fileURLWithPath: nodeBin)
            proc.arguments = [cliPath, "serve", "--config", configPath]
        }
        proc.currentDirectoryURL = URL(fileURLWithPath: appRootDir)
        proc.environment = env
        if let logHandle = logHandle {
            proc.standardOutput = logHandle
            proc.standardError = logHandle
        }

        do {
            try proc.run()
            serverProcess = proc
            startedOwnServer = true
        } catch {
            NSLog("Failed to start OAA Kernel: \(error)")
        }
    }

    private func stopManagedKernel() {
        if startedOwnServer, let proc = serverProcess, proc.isRunning {
            proc.terminate()
            proc.waitUntilExit()
        }
        serverProcess = nil
        startedOwnServer = false
    }

    private func connectWebView() {
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
        showSplashHTML(status: "正在重启后台服务…")
        stopManagedKernel()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
            self.startManagedKernel()
            self.pollUntilReady(attemptsLeft: 45)
        }
    }

    @objc func showAbout() {
        let alert = NSAlert()
        alert.messageText = "Open Agent API 0.6.4"
        alert.informativeText = "智能体控制台 · 一次发布，随处调用。\n\n监听地址：\(baseURL)\n数据目录：\(appSupportDir)"
        alert.alertStyle = .informational
        alert.runModal()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
