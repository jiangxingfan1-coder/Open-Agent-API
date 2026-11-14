import Cocoa

// Starting, finding and stopping the gateway, and the first-run seeding. This is the part of the
// shell that touches the disk, processes and the network; the decisions it takes (which port, whose
// gateway, what to change in config.json) are made by the pure code in ShellCore.swift.

extension AppDelegate {
    var configPath: String { (appSupportDir as NSString).appendingPathComponent("config.json") }
    var logPath: String { (appSupportDir as NSString).appendingPathComponent("oaa-desktop.log") }

    /// Paths under which a gateway of this data folder shows up in `ps` (the folder may be reached
    /// through a symbolic link).
    var configPathVariants: [String] {
        let resolved = URL(fileURLWithPath: configPath).resolvingSymlinksInPath().path
        return resolved == configPath ? [configPath] : [configPath, resolved]
    }

    /// The environment of the gateway and of the `oaa` commands: the user's, plus the places where
    /// engine executables usually are (a Dock-launched app does not inherit the shell's PATH).
    func gatewayEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let extraPaths = [
            "\(NSHomeDirectory())/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
            "/usr/sbin", "/sbin",
        ]
        env["PATH"] = (extraPaths + [env["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")
        return env
    }

    // MARK: - Boot

    private func isCurrentBoot(_ generation: Int) -> Bool {
        bootLock.lock()
        defer { bootLock.unlock() }
        return generation == bootGeneration
    }

    private func onMain(_ work: @escaping () -> Void) {
        DispatchQueue.main.async(execute: work)
    }

    /// Reads the port from config.json, decides whether the gateway on it is ours, starts one if the
    /// port is free, and opens the console once the gateway answers. A newer boot (Restart Gateway)
    /// makes an older one stop. `terminating` is a verified gateway of this data folder to stop first.
    func startBoot(terminating pid: Int?) {
        bootLock.lock()
        bootGeneration += 1
        let generation = bootGeneration
        bootLock.unlock()
        showSplashHTML(status: tr(.splashStarting))
        bootQueue.async { self.bootSequence(generation, terminating: pid) }
    }

    private func bootSequence(_ generation: Int, terminating pid: Int?) {
        // 1. The configuration decides the port.
        let port: Int
        switch prepareConfiguration() {
        case .failure(let problem):
            return onMain { if self.isCurrentBoot(generation) { self.showStartupProblem(problem) } }
        case .success(let value):
            port = value
        }
        onMain {
            guard self.isCurrentBoot(generation) else { return }
            self.port = port
            self.showSplashHTML(status: tr(.splashStartingAt, ["address": "127.0.0.1:\(port)"]))
        }
        if let pid {
            stopVerifiedGateway(pid: pid, port: port)
        }
        guard isCurrentBoot(generation) else { return }

        // 2. Is something on the port already?
        switch judge(probe: probeGateway(port: port), ownChild: nil, port: port) {
        case .problem(let problem):
            return onMain { if self.isCurrentBoot(generation) { self.showStartupProblem(problem) } }
        case .attach(let ours):
            return onMain {
                guard self.isCurrentBoot(generation) else { return }
                self.attachedPid = ours
                self.connectWebView()
            }
        case .wait:
            break
        }

        // 3. The port is free: start our own gateway and wait for it.
        guard let child = startManagedKernel() else {
            return onMain {
                if self.isCurrentBoot(generation) {
                    self.showStartupProblem(.gatewayNotStarted(port: port, logPath: self.logPath))
                }
            }
        }
        for _ in 0..<60 {
            guard isCurrentBoot(generation) else { return }
            if !child.isRunning {
                // It exited: say why when the log says the address was taken.
                let held = StartupProblem.logShowsAddressInUse(logTail())
                let problem: StartupProblem =
                    held
                    ? .portHeldByOther(port: port, configPath: configPath)
                    : .gatewayNotStarted(port: port, logPath: logPath)
                return onMain { if self.isCurrentBoot(generation) { self.showStartupProblem(problem) } }
            }
            switch judge(
                probe: probeGateway(port: port), ownChild: Int(child.processIdentifier), port: port)
            {
            case .attach:
                return onMain {
                    guard self.isCurrentBoot(generation) else { return }
                    self.attachedPid = nil
                    self.connectWebView()
                }
            case .problem(let problem):
                return onMain { if self.isCurrentBoot(generation) { self.showStartupProblem(problem) } }
            case .wait:
                Thread.sleep(forTimeInterval: 0.2)
            }
        }
        onMain {
            if self.isCurrentBoot(generation) {
                self.showStartupProblem(.gatewayNotStarted(port: port, logPath: self.logPath))
            }
        }
    }

    // MARK: - Configuration

    /// Creates config.json on the first launch and returns the port the gateway will listen on.
    private func prepareConfiguration() -> Result<Int, StartupProblem> {
        let fm = FileManager.default
        if !fm.fileExists(atPath: configPath) {
            _ = runCliSync(["init", "--dir", appSupportDir], env: gatewayEnvironment())
        }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
            var json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return .failure(.configUnavailable(dir: appSupportDir)) }
        // An isolated run's port is written into that run's own config.json (never the default one).
        if let wanted = options.port, GatewayConfigFile.portSetting(in: json) != .valid(wanted) {
            json["port"] = wanted
            guard writeConfig(json) else { return .failure(.configUnavailable(dir: appSupportDir)) }
        }
        switch GatewayConfigFile.portSetting(in: json) {
        case .unset: return .success(gatewayDefaultPort)
        case .valid(let value): return .success(value)
        case .invalid(let text): return .failure(.invalidConfigPort(value: text, configPath: configPath))
        }
    }

    private func writeConfig(_ json: [String: Any]) -> Bool {
        guard let updated = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
        else { return false }
        return (try? updated.write(to: URL(fileURLWithPath: configPath))) != nil
    }

    // MARK: - Who is on the port

    enum BootDecision {
        case attach(pid: Int)
        case problem(StartupProblem)
        /// Nothing there yet.
        case wait
    }

    /// Sends no key anywhere: it only asks `/health`. The gateway is used only when it is the child
    /// this app started or a gateway of this very data folder (see GatewayOwnership).
    func judge(probe: PortProbe, ownChild: Int?, port: Int) -> BootDecision {
        switch probe {
        case .silent:
            return .wait
        case .other:
            return .problem(.portHeldByOther(port: port, configPath: configPath))
        case .gateway(let pid):
            let command = pid.flatMap { commandLine(ofProcess: $0) }
            if let pid, GatewayOwnership.isOurs(
                pid: pid, ownChild: ownChild, commandLine: command, configPaths: configPathVariants)
            {
                return .attach(pid: pid)
            }
            return .problem(.portHeldByGateway(port: port, configPath: configPath))
        }
    }

    /// GET /health on loopback. Blocking: only called on the boot queue. It bypasses the system
    /// proxy settings, which must never apply to the loopback address.
    private func probeGateway(port: Int) -> PortProbe {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return .silent }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        configuration.timeoutIntervalForRequest = 1.5
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        let box = ProbeBox()
        let done = DispatchSemaphore(value: 0)
        session.dataTask(with: url) { data, response, _ in
            box.set(status: (response as? HTTPURLResponse)?.statusCode, body: data)
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 3)
        let result = box.get()
        return PortProbe.classify(statusCode: result.status, body: result.body)
    }

    /// The command line of a process, or nil when it is gone or cannot be read.
    private func commandLine(ofProcess pid: Int) -> String? {
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-ww", "-p", String(pid), "-o", "command="]
        let pipe = Pipe()
        ps.standardOutput = pipe
        ps.standardError = FileHandle.nullDevice
        do { try ps.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        ps.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }

    /// Asks a gateway that was verified to be ours to quit and waits (up to 3 seconds) for the port.
    private func stopVerifiedGateway(pid: Int, port: Int) {
        kill(pid_t(pid), SIGTERM)
        for _ in 0..<15 {
            if probeGateway(port: port) == .silent { return }
            Thread.sleep(forTimeInterval: 0.2)
        }
    }

    private func logTail() -> String {
        guard let handle = FileHandle(forReadingAtPath: logPath) else { return "" }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: size > 8192 ? size - 8192 : 0)
        return String(data: handle.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }

    // MARK: - Problems

    func showStartupProblem(_ problem: StartupProblem) {
        let text = problem.text()
        showSplashHTML(status: nil, problem: text)
        window.makeKeyAndOrderFront(nil)
        let alert = NSAlert()
        alert.messageText = text.title
        alert.informativeText = text.body
        alert.alertStyle = .warning
        alert.addButton(withTitle: tr(.buttonOK))
        alert.addButton(withTitle: tr(.statusOpenDataFolder))
        alert.beginSheetModal(for: window) { response in
            if response == .alertSecondButtonReturn { self.openDataFolder() }
        }
    }

    // MARK: - Processes

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
            "\(home)/.volta/bin/node",
        ]
        for path in candidates {
            if fm.isExecutableFile(atPath: path) {
                return path
            }
        }
        return "/usr/bin/env"
    }

    /// Runs `oaa <args>` to completion with the bundled (or a local) Node; returns its exit status.
    @discardableResult
    func runCliSync(_ args: [String], env: [String: String]) -> Int32 {
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
        do { try proc.run() } catch { return -1 }
        proc.waitUntilExit()
        return proc.terminationStatus
    }

    /// Starts `oaa serve` for this data folder after the configuration was prepared for the app
    /// (see GatewayConfigFile.prepareForStart). Returns the child, or nil when it cannot be started.
    private func startManagedKernel() -> Process? {
        let fm = FileManager.default
        let env = gatewayEnvironment()

        // Enable installed local native CLI adapters (antigravity/agy, claude, codex, dsh) and point the
        // offline sample adapter at this app's copy of the sample agent.
        if let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        {
            let sampleScript = (appRootDir as NSString).appendingPathComponent("examples/sample-agent.mjs")
            let nodeBin = findNodeBinary()
            let patch = GatewayConfigFile.prepareForStart(
                json, isExecutable: { fm.isExecutableFile(atPath: $0) },
                sampleScript: fm.fileExists(atPath: sampleScript) ? sampleScript : nil,
                nodeCommand: nodeBin == "/usr/bin/env" ? "node" : nodeBin, portOverride: nil)
            if patch.modified { _ = writeConfig(patch.json) }
        }

        let nodeBin = findNodeBinary()
        let cliPath = (appRootDir as NSString).appendingPathComponent("dist/src/cli.js")
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
            return proc
        } catch {
            NSLog("Failed to start OAA Kernel: \(error)")
            return nil
        }
    }

    func stopManagedKernel() {
        if startedOwnServer, let proc = serverProcess, proc.isRunning {
            proc.terminate()
            proc.waitUntilExit()
        }
        serverProcess = nil
        startedOwnServer = false
    }

    // MARK: - First run

    /// Whether config.json records an executable for this native engine that exists on disk.
    private func nativeInstalled(_ engine: String) -> Bool {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let lw = json["localWorker"] as? [String: Any],
            let native = lw["native"] as? [String: Any],
            let entry = native[engine] as? [String: Any],
            let exec = entry["executable"] as? String
        else { return false }
        return FileManager.default.isExecutableFile(atPath: exec)
    }

    func seedDefaultAgentsIfNeeded() {
        let fm = FileManager.default
        // v2: seed the offline sample agent (calls no model) so a fresh install has one agent that works;
        // the agy example is published only when agy is installed.
        let marker = (appSupportDir as NSString).appendingPathComponent(".seeded-v2")
        if fm.fileExists(atPath: marker) || seedingInProgress { return }
        let tokenFile = (appSupportDir as NSString).appendingPathComponent("admin.token")
        guard fm.fileExists(atPath: tokenFile) else { return }
        seedingInProgress = true

        let env = gatewayEnvironment()
        let url = baseURL
        DispatchQueue.global().async { [weak self] in
            guard let self = self else { return }
            // (file, id of the agent it publishes)
            var examples = [("examples/sample-agent.json", FirstRunNotice.sampleAgent)]
            if self.nativeInstalled("antigravity") {
                examples.append(("examples/agy-gemini-3.8-flash.oaa", FirstRunNotice.antigravityAgent))
            }
            var published: [String] = []
            for (rel, agent) in examples {
                let full = (self.appRootDir as NSString).appendingPathComponent(rel)
                if fm.fileExists(atPath: full),
                    self.runCliSync(["publish", full, "--url", url, "--token-file", tokenFile], env: env) == 0
                {
                    published.append(agent)
                }
            }
            try? "ok".write(toFile: marker, atomically: true, encoding: .utf8)
            // What the notice says it enabled is read back from config.json, not assumed.
            var engines: [String] = []
            if let data = try? Data(contentsOf: URL(fileURLWithPath: self.configPath)),
                let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            {
                engines = FirstRunNotice.enabledEngines(in: json, isExecutable: { fm.isExecutableFile(atPath: $0) })
            }
            DispatchQueue.main.async {
                self.seedingInProgress = false
                self.webView.reload()
                self.presentFirstRunNotice(engines: engines, published: published)
            }
        }
    }

    /// The one-time note after the first launch (the seed marker makes sure it appears only once):
    /// what was published and enabled without being asked, and where to turn an engine off. It is a
    /// sheet on the console window with one button, not a notification, so it needs no permission.
    func presentFirstRunNotice(engines: [String], published: [String]) {
        guard let text = FirstRunNotice.compose(engines: engines, published: published) else { return }
        openStudioWindow()
        let alert = NSAlert()
        alert.messageText = text.title
        alert.informativeText = text.body
        alert.alertStyle = .informational
        alert.addButton(withTitle: tr(.buttonOK))
        alert.addButton(withTitle: tr(.firstRunOpenMachines))
        alert.beginSheetModal(for: window) { response in
            if response == .alertSecondButtonReturn {
                self.webView.evaluateJavaScript("location.hash = 'nodes'", completionHandler: nil)
            }
        }
    }
}

/// The answer of a `/health` probe, handed from the URLSession queue to the boot queue.
final class ProbeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var status: Int?
    private var body: Data?

    func set(status: Int?, body: Data?) {
        lock.lock()
        self.status = status
        self.body = body
        lock.unlock()
    }

    func get() -> (status: Int?, body: Data?) {
        lock.lock()
        defer { lock.unlock() }
        return (status, body)
    }
}
