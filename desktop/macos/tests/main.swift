import Foundation

// Self-check of the pure logic of the macOS shell (Strings.swift, ShellCore.swift). It is compiled
// together with those files by test/desktop-shell.test.ts and is never part of the app bundle:
// scripts/package-all.mjs only compiles the .swift files directly inside desktop/macos/.
//
//   main                       run every check; exit code 1 when one fails
//   main token-script <token>  print the script the shell injects into the console page

var checks = 0
var failures = 0

func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    checks += 1
    if !condition() {
        failures += 1
        print("FAIL: \(name)")
    }
}

/// True when the text holds Chinese characters or full-width punctuation.
func hasCJK(_ text: String) -> Bool {
    text.unicodeScalars.contains {
        (0x4E00...0x9FFF).contains($0.value) || (0x3000...0x303F).contains($0.value)
            || (0xFF00...0xFFEF).contains($0.value)
    }
}

// MARK: - Language

func languageChecks() {
    check(ShellLanguage.resolve(preferred: ["zh-Hans-CN", "en"]) == .zh, "zh-Hans first is Chinese")
    check(ShellLanguage.resolve(preferred: ["zh-TW"]) == .zh, "zh-TW is Chinese")
    check(ShellLanguage.resolve(preferred: ["ZH-hans"]) == .zh, "the match ignores case")
    check(ShellLanguage.resolve(preferred: ["en-US", "zh-Hans"]) == .en, "only the first language counts")
    check(ShellLanguage.resolve(preferred: ["ja-JP"]) == .en, "other languages get English")
    check(ShellLanguage.resolve(preferred: ["en-SG"]) == .en, "English is English")
    check(ShellLanguage.resolve(preferred: []) == .zh, "no preference behaves like the console: Chinese")
    check(ShellLanguage.zh.htmlLang == "zh-CN" && ShellLanguage.en.htmlLang == "en", "html lang tags")
}

// MARK: - Strings table

func tableChecks() {
    for msg in Msg.allCases {
        guard let entry = L10n.table[msg] else {
            check(false, "\(msg.rawValue) is in the table")
            continue
        }
        check(!entry.zh.isEmpty && !entry.en.isEmpty, "\(msg.rawValue) has both languages")
        check(
            L10n.placeholders(in: entry.zh) == L10n.placeholders(in: entry.en),
            "\(msg.rawValue) uses the same placeholders in both languages")
        check(!hasCJK(entry.en), "\(msg.rawValue): the English text has no Chinese characters")
        check(entry.zh != entry.en, "\(msg.rawValue): the Chinese and English texts differ")
    }
    check(L10n.table.count == Msg.allCases.count, "the table has no stray keys")
    check(
        L10n.text(.statusBadgeMany, ["count": "3"], lang: .en) == "Open Agent API · 3 requests awaiting approval",
        "placeholders are filled in")
    check(
        L10n.text(.statusBadgeOne, ["count": "1"], lang: .en) == "Open Agent API · 1 request awaiting approval",
        "singular badge text")
    check(
        L10n.text(.menuQuit, lang: .zh) == "退出 Open Agent API" && L10n.text(.menuQuit, lang: .en) == "Quit Open Agent API",
        "both languages are reachable")
    check(L10n.placeholders(in: "a {x} b {y}c {x}") == ["x", "y"], "placeholder scan")
}

// MARK: - Isolated runs

func launchOptionChecks() {
    let exe = "/Applications/Open Agent API.app/Contents/MacOS/OpenAgentAPI"
    let none = ShellLaunchOptions.parse(environment: [:], arguments: [exe])
    check(none == ShellLaunchOptions(), "no variables: a normal run")
    check(!none.isolated, "a normal run is not isolated")

    let env = ShellLaunchOptions.parse(
        environment: ["OAA_DESKTOP_HOME": "/tmp/oaa-a", "OAA_DESKTOP_PORT": "18787"], arguments: [exe])
    check(env.home == "/tmp/oaa-a" && env.port == 18787 && env.problem == nil, "environment variables")
    check(env.isolated, "a home makes the run isolated")

    let args = ShellLaunchOptions.parse(
        environment: [:], arguments: [exe, "--enable-notifications", "--home", "/tmp/oaa-b", "--port=19000"])
    check(args.home == "/tmp/oaa-b" && args.port == 19000, "arguments, both spellings, other flags ignored")

    let both = ShellLaunchOptions.parse(
        environment: ["OAA_DESKTOP_HOME": "/tmp/from-env", "OAA_DESKTOP_PORT": "18787"],
        arguments: [exe, "--home=/tmp/from-args", "--port", "19001"])
    check(both.home == "/tmp/from-args" && both.port == 19001, "arguments win over environment variables")

    let tilde = ShellLaunchOptions.parse(environment: ["OAA_DESKTOP_HOME": "~/oaa-test"], arguments: [exe])
    check(tilde.home == NSHomeDirectory() + "/oaa-test", "a leading ~ is expanded")
    let dots = ShellLaunchOptions.parse(environment: ["OAA_DESKTOP_HOME": "/tmp/a/../b/"], arguments: [exe])
    check(dots.home == "/tmp/b", "the path is standardized")
    let spaced = ShellLaunchOptions.parse(
        environment: ["OAA_DESKTOP_HOME": "  /tmp/with space  "], arguments: [exe])
    check(spaced.home == "/tmp/with space", "surrounding blanks are trimmed, inner spaces stay")

    check(
        ShellLaunchOptions.parse(environment: ["OAA_DESKTOP_HOME": "relative/dir"], arguments: [exe]).problem
            == .homeNotAbsolute("relative/dir"),
        "a relative home is refused")
    check(
        ShellLaunchOptions.parse(environment: ["OAA_DESKTOP_HOME": "relative"], arguments: [exe]).home == nil,
        "a refused home is not used")
    for bad in ["0", "65536", "-1", "+80", "8787.5", "abc", "1e3", "80 80"] {
        let parsed = ShellLaunchOptions.parse(
            environment: ["OAA_DESKTOP_HOME": "/tmp/x", "OAA_DESKTOP_PORT": bad], arguments: [exe])
        check(parsed.problem == .invalidPort(bad) && parsed.port == nil, "port '\(bad)' is refused")
    }
    for good in ["1", "8787", "65535"] {
        check(ShellLaunchOptions.validPort(good) == Int(good), "port '\(good)' is accepted")
    }
    check(
        ShellLaunchOptions.parse(environment: ["OAA_DESKTOP_PORT": "18787"], arguments: [exe]).problem
            == .portNeedsHome,
        "a port without a home is refused: it would rewrite the default config.json")
    check(
        ShellLaunchOptions.parse(environment: ["OAA_DESKTOP_HOME": "", "OAA_DESKTOP_PORT": ""], arguments: [exe])
            == ShellLaunchOptions(),
        "empty variables count as unset")
}

// MARK: - config.json

func configChecks() {
    check(GatewayConfigFile.portSetting(in: [:]) == .unset, "no port key")
    check(GatewayConfigFile.portSetting(in: ["port": 8787]) == .valid(8787), "an integer port")
    check(GatewayConfigFile.portSetting(in: ["port": 65535]) == .valid(65535), "the highest port")
    for bad: Any in [0, 65536, -5, 80.5, "8787", true, NSNull(), [8787]] {
        if case .invalid = GatewayConfigFile.portSetting(in: ["port": bad]) {
            check(true, "port \(bad) is invalid")
        } else {
            check(false, "port \(bad) is invalid")
        }
    }
    let parsed = (try? JSONSerialization.jsonObject(with: Data(#"{"port": 18787, "host": "127.0.0.1"}"#.utf8))) as? [String: Any]
    check(GatewayConfigFile.portSetting(in: parsed ?? [:]) == .valid(18787), "a port parsed from JSON text")
    let boolean = (try? JSONSerialization.jsonObject(with: Data(#"{"port": true}"#.utf8))) as? [String: Any]
    check(GatewayConfigFile.portSetting(in: boolean ?? [:]) == .invalid("true"), "a JSON boolean is not a port")
    check(
        GatewayConfigFile.portSetting(in: ["port": "8787"]) == .invalid("\"8787\""),
        "a string is shown with quotes in the message")

    let base: [String: Any] = [
        "port": 8787, "localAgents": ["old"],
        "localWorker": [
            "native": [
                "codex": ["executable": "/bin/codex", "enabled": false, "args": []],
                "claude": ["executable": "/bin/claude", "enabled": true],
                "dsh": ["executable": "/missing/dsh", "enabled": false],
            ],
        ],
    ]
    let patch = GatewayConfigFile.prepareForStart(
        base, isExecutable: { $0 != "/missing/dsh" }, sampleScript: "/app/sample.mjs", nodeCommand: "/node",
        portOverride: nil)
    check(patch.modified, "the config needed changes")
    check(patch.json["localAgents"] == nil, "the obsolete localAgents key is removed")
    check(patch.enabledEngines == ["codex"], "only the installed engine that was off is switched on")
    let worker = patch.json["localWorker"] as? [String: Any]
    let native = worker?["native"] as? [String: Any]
    check(((native?["codex"] as? [String: Any])?["enabled"] as? Bool) == true, "codex is enabled")
    check(((native?["dsh"] as? [String: Any])?["enabled"] as? Bool) == false, "a missing executable stays off")
    check(((native?["codex"] as? [String: Any])?["args"] as? [Any])?.isEmpty == true, "other fields are kept")
    let adapter = (worker?["adapters"] as? [String: Any])?["oaa-sample"] as? [String: Any]
    check(
        (adapter?["command"] as? String) == "/node" && (adapter?["args"] as? [String]) == ["/app/sample.mjs"]
            && (adapter?["enabled"] as? Bool) == true && (adapter?["transport"] as? String) == "acp",
        "the offline sample adapter points at the app's copy")
    check((patch.json["port"] as? Int) == 8787, "the port is untouched without an override")

    let again = GatewayConfigFile.prepareForStart(
        patch.json, isExecutable: { $0 != "/missing/dsh" }, sampleScript: "/app/sample.mjs", nodeCommand: "/node",
        portOverride: nil)
    check(!again.modified && again.enabledEngines.isEmpty, "a second pass changes nothing")

    let moved = GatewayConfigFile.prepareForStart(
        patch.json, isExecutable: { _ in true }, sampleScript: "/app/sample.mjs", nodeCommand: "/node",
        portOverride: 18787)
    check(moved.modified && (moved.json["port"] as? Int) == 18787, "an isolated run's port is written")
    let same = GatewayConfigFile.prepareForStart(
        moved.json, isExecutable: { _ in true }, sampleScript: "/app/sample.mjs", nodeCommand: "/node",
        portOverride: 18787)
    check(!same.modified, "the same port is not rewritten")
    let noSample = GatewayConfigFile.prepareForStart(
        ["localWorker": ["native": [:]]], isExecutable: { _ in true }, sampleScript: nil, nodeCommand: "node",
        portOverride: nil)
    check(!noSample.modified, "no sample script, nothing to change")
}

// MARK: - Whose gateway

func ownershipChecks() {
    func body(_ json: String) -> Data { Data(json.utf8) }
    check(PortProbe.classify(statusCode: nil, body: nil) == .silent, "no answer")
    check(
        PortProbe.classify(statusCode: 200, body: body(#"{"status":"ok","protocol":"oaa/1","pid":4242}"#))
            == .gateway(pid: 4242),
        "a gateway with its pid")
    check(
        PortProbe.classify(statusCode: 200, body: body(#"{"status":"ok","protocol":"oaa/1"}"#))
            == .gateway(pid: nil),
        "a gateway that does not report a pid")
    check(
        PortProbe.classify(statusCode: 200, body: body(#"{"status":"ok","protocol":"oaa/1","pid":true}"#))
            == .gateway(pid: nil),
        "a boolean is not a pid")
    check(PortProbe.classify(statusCode: 200, body: body(#"{"status":"ok"}"#)) == .other, "some other JSON service")
    check(PortProbe.classify(statusCode: 200, body: body("<html></html>")) == .other, "a web page")
    check(
        PortProbe.classify(statusCode: 403, body: body(#"{"protocol":"oaa/1","pid":1}"#)) == .other,
        "a refusal is not a gateway")
    check(PortProbe.classify(statusCode: 200, body: nil) == .other, "an empty answer")

    let config = "/Users/me/Library/Application Support/OpenAgentAPI/config.json"
    let node = "/Applications/Open Agent API.app/Contents/Resources/node/bin/node"
    let cli = "/Applications/Open Agent API.app/Contents/Resources/app/dist/src/cli.js"
    check(
        GatewayOwnership.commandServes("\(node) \(cli) serve --config \(config)\n", configPath: config),
        "the app's own gateway command line")
    check(
        GatewayOwnership.commandServes(
            "node cli.js serve --config \(config) --tool-config /tmp/t.json", configPath: config),
        "extra options after the config path")
    check(
        !GatewayOwnership.commandServes("node cli.js serve --config \(config).bak", configPath: config),
        "another file that only starts with the same path")
    check(
        !GatewayOwnership.commandServes(
            "node cli.js serve --config /Users/me/.oaa/config.json", configPath: config),
        "a gateway of another data folder")
    check(!GatewayOwnership.commandServes("node server.js --config \(config)", configPath: config), "not `serve`")
    check(!GatewayOwnership.commandServes("", configPath: config), "an empty command line")
    check(
        GatewayOwnership.commandServes(
            "node cli.js serve --config /x/config.json.bak --x serve --config /x/config.json", configPath: "/x/config.json"),
        "a later exact match still counts")

    check(
        GatewayOwnership.isOurs(pid: 77, ownChild: 77, commandLine: nil, configPaths: [config]),
        "the child this app started")
    check(
        GatewayOwnership.isOurs(pid: 78, ownChild: 77, commandLine: "node cli.js serve --config \(config)", configPaths: [config]),
        "a gateway of this data folder that outlived the app")
    check(
        !GatewayOwnership.isOurs(pid: 78, ownChild: 77, commandLine: "node cli.js serve --config /elsewhere/config.json", configPaths: [config]),
        "somebody else's gateway")
    check(
        !GatewayOwnership.isOurs(pid: 78, ownChild: nil, commandLine: nil, configPaths: [config]),
        "a process that cannot be inspected")
    check(
        !GatewayOwnership.isOurs(pid: nil, ownChild: 77, commandLine: "serve --config \(config)", configPaths: [config]),
        "a gateway that reports no pid cannot be verified")
    check(
        GatewayOwnership.isOurs(pid: 5, ownChild: nil, commandLine: "node cli.js serve --config /real/cfg/config.json", configPaths: [config, "/real/cfg/config.json"]),
        "the data folder reached through a symbolic link")
}

// MARK: - Problems and the splash page

func problemChecks() {
    let config = "/Users/me/Library/Application Support/OpenAgentAPI/config.json"
    let cases: [StartupProblem] = [
        .portHeldByOther(port: 8787, configPath: config),
        .portHeldByGateway(port: 8787, configPath: config),
        .invalidConfigPort(value: "\"abc\"", configPath: config),
        .configUnavailable(dir: "/Users/me/x"),
        .gatewayNotStarted(port: 8787, logPath: "/Users/me/x/oaa-desktop.log"),
    ]
    for lang in [ShellLanguage.zh, ShellLanguage.en] {
        for problem in cases {
            let text = problem.text(lang: lang)
            check(!text.title.isEmpty && !text.body.isEmpty, "\(problem) has text in \(lang)")
            check(!text.body.contains("{") && !text.title.contains("{"), "\(problem) has no unfilled placeholder in \(lang)")
        }
    }
    let busy = StartupProblem.portHeldByOther(port: 18787, configPath: config)
    check(busy.text(lang: .en).title.contains("18787") && busy.text(lang: .en).body.contains(config), "the busy port and the config file are named")
    check(busy.text(lang: .zh).title.contains("18787") && busy.text(lang: .zh).body.contains("OAA_DESKTOP_PORT"), "Chinese text names the port and the isolated-run variable")
    check(busy.text(lang: .en).body.contains("another Open Agent API instance"), "the English text mentions another instance")
    check(busy.text(lang: .zh).body.contains("另一个 Open Agent API 实例"), "the Chinese text mentions another instance")
    let foreign = StartupProblem.portHeldByGateway(port: 8787, configPath: config)
    check(foreign.text(lang: .en).body.contains("not started from this data folder"), "the foreign-gateway text says why it is not used")
    for launch: LaunchProblem in [.homeNotAbsolute("x"), .invalidPort("y"), .portNeedsHome] {
        for lang in [ShellLanguage.zh, ShellLanguage.en] {
            let text = StartupProblem.text(for: launch, lang: lang)
            check(!text.title.isEmpty && !text.body.contains("{"), "launch problem \(launch) in \(lang)")
        }
    }
    check(StartupProblem.logShowsAddressInUse("Error: listen EADDRINUSE: address already in use 127.0.0.1:8787"), "log shows a taken address")
    check(!StartupProblem.logShowsAddressInUse("listening on 127.0.0.1:8787"), "a healthy log")

    check(htmlEscape("<a href=\"x\">&</a>") == "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;", "html escaping")
    let page = SplashPage.html(status: nil, problem: ("T <1>", "/Users/a&b/config.json"), lang: .en)
    check(page.contains("<html lang=\"en\">") && page.contains("T &lt;1&gt;") && page.contains("/Users/a&amp;b/config.json"), "the problem page escapes its text")
    check(!page.contains("<p>"), "a problem page has no progress line")
    let progress = SplashPage.html(status: "Starting <b>", lang: .zh)
    check(progress.contains("<html lang=\"zh-CN\">") && progress.contains("<p>Starting &lt;b&gt;</p>") && progress.contains("一次发布 · 随处调用"), "the progress page")
}

// MARK: - Console page script

func bridgeChecks() {
    check(ConsoleBridge.origin(port: 8787) == "http://127.0.0.1:8787", "origin with a port")
    check(ConsoleBridge.origin(port: 80) == "http://127.0.0.1", "the default port is not part of the origin")
    let script = ConsoleBridge.tokenScript(token: "k-1", origin: ConsoleBridge.origin(port: 18787))
    check(script.contains("sessionStorage.setItem(\"oaa-token\", \"k-1\")"), "the key goes into sessionStorage")
    check(!script.contains("localStorage.setItem"), "nothing is ever written to localStorage")
    check(script.contains("location.origin === \"http://127.0.0.1:18787\""), "only the gateway's own origin")
    for legacy in ["oaa-token", "oaa_token", "oaa_admin_token"] {
        check(script.contains("localStorage.removeItem(\"\(legacy)\")"), "legacy localStorage \(legacy) is removed")
    }
    check(script.contains("sessionStorage.removeItem(\"oaa_token\")"), "the legacy session copy is removed")
    check(!script.contains("oaa.console.lang") && !script.contains("oaa.prefs"), "the console's own settings are not touched")
    let empty = ConsoleBridge.tokenScript(token: "", origin: "http://127.0.0.1:8787")
    check(!empty.contains("setItem") && empty.contains("removeItem"), "without a key it only cleans up")
    let tricky = ConsoleBridge.jsString("a'b\"c\\d\n</script>\u{2028}")
    check(!tricky.contains("\n") && !tricky.contains("\u{2028}"), "a tricky key stays on one line")
}

// MARK: - First launch note

func firstRunChecks() {
    let config: [String: Any] = [
        "localWorker": [
            "native": [
                "dsh": ["executable": "/bin/dsh", "enabled": true],
                "claude": ["executable": "/bin/claude", "enabled": true],
                "codex": ["executable": "/bin/codex", "enabled": false],
                "antigravity": ["executable": "/missing/agy", "enabled": true],
                "zeta": ["executable": "/bin/zeta", "enabled": true],
            ],
        ],
    ]
    let engines = FirstRunNotice.enabledEngines(in: config, isExecutable: { $0 != "/missing/agy" })
    check(engines == ["claude", "dsh", "zeta"], "only enabled engines with an executable, known ones first")
    check(FirstRunNotice.enabledEngines(in: [:], isExecutable: { _ in true }).isEmpty, "no worker, no engines")
    check(FirstRunNotice.engineName("claude") == "Claude Code" && FirstRunNotice.engineName("x") == "x", "engine names")

    check(FirstRunNotice.compose(engines: [], published: []) == nil, "nothing done, nothing to say")
    let both = FirstRunNotice.compose(
        engines: ["codex", "claude"], published: ["agent/sample", "agent/antigravity"], lang: .en)
    check(both?.title == "First launch: set up for you", "English title")
    check(both?.body.contains("offline sample agent agent/sample") == true, "the sample agent is named")
    check(both?.body.contains("Codex, Claude Code") == true, "the engines are named")
    check(both?.body.contains("Execution machines") == true, "it says where to turn an engine off")
    check(both?.body.contains("each time it starts") == true, "it says the engines are enabled again at every start")
    check(both?.body.contains("agent/antigravity") == true, "the Antigravity example is named when published")
    let zh = FirstRunNotice.compose(engines: ["codex", "claude"], published: ["agent/sample"], lang: .zh)
    check(zh?.body.contains("Codex、Claude Code") == true && zh?.body.contains("执行机器") == true, "Chinese text")
    check(zh?.body.contains("agent/antigravity") == false, "an unpublished example is not claimed")
    let none = FirstRunNotice.compose(engines: [], published: ["agent/sample"], lang: .en)
    check(none?.body.contains("none was enabled") == true, "no engines found is said plainly")
    let engineOnly = FirstRunNotice.compose(engines: ["codex"], published: [], lang: .en)
    check(engineOnly?.body.contains("sample agent") == false, "a failed publish is not claimed")
    for lang in [ShellLanguage.zh, ShellLanguage.en] {
        let text = FirstRunNotice.compose(engines: ["codex"], published: ["agent/sample", "agent/antigravity"], lang: lang)
        check(text?.body.contains("{") == false && text?.title.contains("{") == false, "no unfilled placeholder in \(lang)")
    }
}

// MARK: - Run

if CommandLine.arguments.count > 3, CommandLine.arguments[1] == "token-script" {
    // The script the shell injects for a key and an origin, for test/desktop-shell.test.ts to run.
    print(ConsoleBridge.tokenScript(token: CommandLine.arguments[2], origin: CommandLine.arguments[3]), terminator: "")
    exit(0)
}

if CommandLine.arguments.count > 2, CommandLine.arguments[1] == "config-port" {
    // The port setting the shell would read from a real config.json (written by `oaa init`).
    let data = (try? Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))) ?? Data()
    let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    print(GatewayConfigFile.portSetting(in: json))
    exit(0)
}

languageChecks()
tableChecks()
launchOptionChecks()
configChecks()
ownershipChecks()
problemChecks()
bridgeChecks()
firstRunChecks()

print("shell checks: \(checks) run, \(failures) failed")
exit(failures == 0 ? 0 : 1)
