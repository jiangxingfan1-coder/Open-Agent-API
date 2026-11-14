import Foundation

// The pure, testable logic of the macOS shell: no AppKit, no window, no network, no disk access
// beyond what the caller passes in. main.swift wires it to the real world; test/desktop-shell.test.ts
// runs it through desktop/macos/tests/main.swift.

/// The gateway's own default for `port` (src/config/config.ts). `oaa init` writes the port into
/// config.json, so this only applies when someone removed the key; test/desktop-shell.test.ts checks
/// that it still equals the default of the schema.
let gatewayDefaultPort = 8787

// MARK: - Isolated runs

enum LaunchProblem: Equatable {
    case homeNotAbsolute(String)
    case invalidPort(String)
    case portNeedsHome
}

/// How this process was asked to run. `OAA_DESKTOP_HOME` (or `--home <dir>`) puts every read and
/// write of the shell in that directory; `OAA_DESKTOP_PORT` (or `--port <n>`) sets the gateway port
/// of such an isolated run. Arguments win over environment variables.
struct ShellLaunchOptions: Equatable {
    var home: String?
    var port: Int?
    var problem: LaunchProblem?

    var isolated: Bool { home != nil }

    static let homeVariable = "OAA_DESKTOP_HOME"
    static let portVariable = "OAA_DESKTOP_PORT"

    /// `arguments` is the full argument vector, executable first. Unknown arguments are ignored
    /// (the shell also receives `--enable-notifications` and macOS's own flags).
    static func parse(environment: [String: String], arguments: [String]) -> ShellLaunchOptions {
        var rawHome = environment[homeVariable]
        var rawPort = environment[portVariable]
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "--home", index + 1 < arguments.count {
                rawHome = arguments[index + 1]
                index += 1
            } else if argument.hasPrefix("--home=") {
                rawHome = String(argument.dropFirst("--home=".count))
            } else if argument == "--port", index + 1 < arguments.count {
                rawPort = arguments[index + 1]
                index += 1
            } else if argument.hasPrefix("--port=") {
                rawPort = String(argument.dropFirst("--port=".count))
            }
            index += 1
        }
        var options = ShellLaunchOptions()
        let home = rawHome?.trimmingCharacters(in: .whitespaces) ?? ""
        let port = rawPort?.trimmingCharacters(in: .whitespaces) ?? ""
        if !home.isEmpty {
            let expanded = (home as NSString).expandingTildeInPath
            if expanded.hasPrefix("/") {
                options.home = URL(fileURLWithPath: expanded).standardized.path
            } else {
                options.problem = .homeNotAbsolute(home)
                return options
            }
        }
        if !port.isEmpty {
            guard let value = validPort(port) else {
                options.problem = .invalidPort(port)
                return options
            }
            if options.home == nil {
                options.problem = .portNeedsHome
                return options
            }
            options.port = value
        }
        return options
    }

    /// A TCP port written as plain decimal digits, 1 to 65535.
    static func validPort(_ text: String) -> Int? {
        guard !text.isEmpty, text.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }), let value = Int(text),
            (1...65535).contains(value)
        else { return nil }
        return value
    }
}

// MARK: - Gateway configuration (config.json)

enum PortSetting: Equatable {
    case unset
    case valid(Int)
    case invalid(String)
}

enum GatewayConfigFile {
    /// The `port` of a parsed config.json.
    static func portSetting(in json: [String: Any]) -> PortSetting {
        guard let raw = json["port"] else { return .unset }
        if let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            let value = number.doubleValue
            if value == value.rounded(), value >= 1, value <= 65535 { return .valid(Int(value)) }
        }
        return .invalid(describe(raw))
    }

    private static func describe(_ value: Any) -> String {
        if let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() {
            return number.boolValue ? "true" : "false"
        }
        if let text = value as? String { return "\"\(text)\"" }
        return "\(value)"
    }

    struct Patch {
        var json: [String: Any]
        var modified: Bool
        /// Native engines this call switched on, in key order.
        var enabledEngines: [String]
    }

    /// What the shell changes in config.json before it starts its own gateway (the owner wants the
    /// app to work out of the box): removes the obsolete `localAgents`, switches on every native
    /// engine whose executable exists, keeps the offline sample adapter pointing at this app's
    /// copy, and (isolated runs only) writes the requested port.
    static func prepareForStart(
        _ input: [String: Any], isExecutable: (String) -> Bool, sampleScript: String?,
        nodeCommand: String, portOverride: Int?
    ) -> Patch {
        var json = input
        var modified = false
        var enabled: [String] = []
        if json["localAgents"] != nil {
            json.removeValue(forKey: "localAgents")
            modified = true
        }
        if var worker = json["localWorker"] as? [String: Any], var native = worker["native"] as? [String: Any] {
            for key in native.keys.sorted() {
                guard var entry = native[key] as? [String: Any], let executable = entry["executable"] as? String,
                    isExecutable(executable), (entry["enabled"] as? Bool) != true
                else { continue }
                entry["enabled"] = true
                native[key] = entry
                enabled.append(key)
            }
            if !enabled.isEmpty {
                worker["native"] = native
                json["localWorker"] = worker
                modified = true
            }
        }
        // The offline sample agent (examples/sample-agent.mjs) runs on the bundled Node and calls no
        // model. Re-written on every launch so the paths follow the app.
        if let script = sampleScript, var worker = json["localWorker"] as? [String: Any] {
            var adapters = (worker["adapters"] as? [String: Any]) ?? [:]
            let sample: [String: Any] = [
                "transport": "acp", "command": nodeCommand, "args": [script], "enabled": true,
            ]
            if !NSDictionary(dictionary: sample).isEqual(adapters["oaa-sample"] as? [String: Any] ?? [:]) {
                adapters["oaa-sample"] = sample
                worker["adapters"] = adapters
                json["localWorker"] = worker
                modified = true
            }
        }
        if let port = portOverride, portSetting(in: json) != .valid(port) {
            json["port"] = port
            modified = true
        }
        return Patch(json: json, modified: modified, enabledEngines: enabled)
    }
}

// MARK: - Who is on the port

enum PortProbe: Equatable {
    /// Nothing answered HTTP: the port is free, or held by something that does not speak HTTP.
    case silent
    /// An Open Agent API gateway answered `/health`; `pid` is the process it reports.
    case gateway(pid: Int?)
    /// Something answered HTTP but is not an Open Agent API gateway.
    case other

    static func classify(statusCode: Int?, body: Data?) -> PortProbe {
        guard let statusCode else { return .silent }
        guard statusCode == 200, let body,
            let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
            (json["protocol"] as? String) == "oaa/1"
        else { return .other }
        if let number = json["pid"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            return .gateway(pid: number.intValue)
        }
        return .gateway(pid: nil)
    }
}

enum GatewayOwnership {
    /// Whether a process command line is `oaa serve --config <this data folder's config.json>`.
    static func commandServes(_ commandLine: String, configPath: String) -> Bool {
        let command = commandLine.trimmingCharacters(in: .whitespacesAndNewlines)
        let marker = "serve --config \(configPath)"
        var searchFrom = command.startIndex
        while let range = command.range(of: marker, range: searchFrom..<command.endIndex) {
            let rest = command[range.upperBound...]
            if rest.isEmpty || rest.hasPrefix(" ") { return true }
            searchFrom = range.upperBound
        }
        return false
    }

    /// The gateway on the port is ours when it is the child this app just started, or when the
    /// process it reports (its pid comes from `/health`, which a local probe may read) is running
    /// `serve --config` on this app's own configuration file, for example a gateway that outlived a
    /// crashed app. Anything else is somebody else's gateway: it is neither used nor sent the key.
    static func isOurs(pid: Int?, ownChild: Int?, commandLine: String?, configPaths: [String]) -> Bool {
        guard let pid else { return false }
        if let ownChild, pid == ownChild { return true }
        guard let commandLine else { return false }
        return configPaths.contains { commandServes(commandLine, configPath: $0) }
    }
}

// MARK: - Startup problems

enum StartupProblem: Error, Equatable {
    case portHeldByOther(port: Int, configPath: String)
    case portHeldByGateway(port: Int, configPath: String)
    case invalidConfigPort(value: String, configPath: String)
    case configUnavailable(dir: String)
    case gatewayNotStarted(port: Int, logPath: String)

    func text(lang: ShellLanguage = .current) -> (title: String, body: String) {
        switch self {
        case .portHeldByOther(let port, let config):
            return (
                L10n.text(.problemPortOtherTitle, ["port": String(port)], lang: lang),
                L10n.text(.problemPortOtherBody, ["port": String(port), "config": config], lang: lang)
            )
        case .portHeldByGateway(let port, let config):
            return (
                L10n.text(.problemPortGatewayTitle, ["port": String(port)], lang: lang),
                L10n.text(.problemPortGatewayBody, ["port": String(port), "config": config], lang: lang)
            )
        case .invalidConfigPort(let value, let config):
            return (
                L10n.text(.problemConfigPortTitle, lang: lang),
                L10n.text(.problemConfigPortBody, ["value": value, "config": config], lang: lang)
            )
        case .configUnavailable(let dir):
            return (
                L10n.text(.problemConfigTitle, lang: lang),
                L10n.text(.problemConfigBody, ["dir": dir], lang: lang)
            )
        case .gatewayNotStarted(let port, let log):
            return (
                L10n.text(.problemNotStartedTitle, lang: lang),
                L10n.text(.splashFailed, ["port": String(port), "log": log], lang: lang)
            )
        }
    }

    /// What the app says when the launch options themselves are wrong.
    static func text(for problem: LaunchProblem, lang: ShellLanguage = .current) -> (title: String, body: String) {
        switch problem {
        case .homeNotAbsolute(let value):
            return (
                L10n.text(.problemHomeTitle, lang: lang), L10n.text(.problemHomeBody, ["value": value], lang: lang)
            )
        case .invalidPort(let value):
            return (
                L10n.text(.problemEnvPortTitle, lang: lang),
                L10n.text(.problemEnvPortBody, ["value": value], lang: lang)
            )
        case .portNeedsHome:
            return (L10n.text(.problemNeedsHomeTitle, lang: lang), L10n.text(.problemNeedsHomeBody, lang: lang))
        }
    }

    /// Whether the end of a gateway log says the listen address was taken.
    static func logShowsAddressInUse(_ logTail: String) -> Bool {
        logTail.contains("EADDRINUSE")
    }
}

// MARK: - Splash page

/// Text for the splash page's HTML. The messages carry file paths, so `&`, `<` and `>` must not
/// reach the markup raw.
func htmlEscape(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
}

// MARK: - First launch

/// The one-time note that says what a first launch did for the user without being asked.
enum FirstRunNotice {
    static let sampleAgent = "agent/sample"
    static let antigravityAgent = "agent/antigravity"

    /// Names of the native engines as people know them.
    static func engineName(_ key: String) -> String {
        switch key {
        case "codex": return "Codex"
        case "claude": return "Claude Code"
        case "antigravity": return "Antigravity (agy)"
        case "dsh": return "DeepSeek Harness"
        default: return key
        }
    }

    /// Native engines that are switched on in config.json and whose executable exists, in a stable
    /// order (the known ones first).
    static func enabledEngines(in json: [String: Any], isExecutable: (String) -> Bool) -> [String] {
        guard let worker = json["localWorker"] as? [String: Any], let native = worker["native"] as? [String: Any]
        else { return [] }
        let known = ["codex", "claude", "antigravity", "dsh"]
        let keys = native.keys.sorted { a, b in
            let ia = known.firstIndex(of: a) ?? known.count
            let ib = known.firstIndex(of: b) ?? known.count
            return ia == ib ? a < b : ia < ib
        }
        return keys.filter { key in
            guard let entry = native[key] as? [String: Any], (entry["enabled"] as? Bool) == true,
                let executable = entry["executable"] as? String
            else { return false }
            return isExecutable(executable)
        }
    }

    /// Title and text of the note, or nil when the first launch did nothing worth mentioning.
    static func compose(
        engines: [String], published: [String], lang: ShellLanguage = .current
    ) -> (title: String, body: String)? {
        if engines.isEmpty && published.isEmpty { return nil }
        var lines: [String] = []
        if published.contains(sampleAgent) {
            lines.append(L10n.text(.firstRunSample, ["agent": sampleAgent], lang: lang))
        }
        if published.contains(antigravityAgent) {
            lines.append(L10n.text(.firstRunAntigravity, ["agent": antigravityAgent], lang: lang))
        }
        if engines.isEmpty {
            lines.append(L10n.text(.firstRunNoEngines, lang: lang))
        } else {
            let names = engines.map(engineName).joined(separator: L10n.text(.listSeparator, lang: lang))
            lines.append(L10n.text(.firstRunEngines, ["engines": names], lang: lang))
        }
        let body = lines.joined(separator: "\n") + "\n\n" + L10n.text(.firstRunFooter, lang: lang)
        return (L10n.text(.firstRunTitle, lang: lang), body)
    }
}
