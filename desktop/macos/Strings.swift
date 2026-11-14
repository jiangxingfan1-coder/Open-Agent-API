import Foundation

// Every user-visible string of the macOS shell lives here, in Chinese and English. main.swift and
// ShellCore.swift only refer to `Msg` cases, so a missing translation is a compile error and the
// self-check (desktop/macos/tests/shell-checks.swift) can prove both columns are complete.

/// The shell speaks Chinese when the first preferred system language starts with "zh", English
/// otherwise. This is the rule of the console (`navigator.language` in web/boot.js) and of the
/// command line, so the three always agree.
enum ShellLanguage: Equatable {
    case zh
    case en

    static func resolve(preferred: [String]) -> ShellLanguage {
        guard let first = preferred.first else { return .zh }
        return first.lowercased().hasPrefix("zh") ? .zh : .en
    }

    static let current: ShellLanguage = resolve(preferred: Locale.preferredLanguages)

    /// Value for `<html lang>`.
    var htmlLang: String { self == .zh ? "zh-CN" : "en" }
}

enum Msg: String, CaseIterable {
    // Application menu
    case menuAbout, menuSettings, menuReloadConsole, menuRestartGateway
    case menuHide, menuHideOthers, menuShowAll, menuQuit
    // Edit menu
    case menuEdit, menuUndo, menuRedo, menuCut, menuCopy, menuPaste, menuSelectAll
    // View menu
    case menuView, menuCommandPalette, menuToggleSidebar, menuFullScreen
    // Window menu
    case menuWindow, menuMinimize, menuZoom, menuShowConsole, menuCloseWindow
    // Menu bar item
    case statusTooltip, statusBadgeOne, statusBadgeMany
    case statusOpenConsole, statusOpenInBrowser, statusCopyAdminKey, statusCopyBaseUrl
    case statusOpenDataFolder
    // Dialogs and notifications
    case buttonOK, buttonConfirm, buttonCancel
    case notificationTestBody
    // About
    case aboutBody
    // Splash page
    case splashTagline, splashStarting, splashStartingAt, splashRestarting, splashFailed
    case windowTitleIsolated
    // Startup problems (title and body each)
    case problemPortOtherTitle, problemPortOtherBody
    case problemPortGatewayTitle, problemPortGatewayBody
    case problemConfigPortTitle, problemConfigPortBody
    case problemConfigTitle, problemConfigBody
    case problemNotStartedTitle
    case problemHomeTitle, problemHomeBody
    case problemEnvPortTitle, problemEnvPortBody
    case problemNeedsHomeTitle, problemNeedsHomeBody
    // First-launch note
    case firstRunTitle, firstRunSample, firstRunAntigravity, firstRunEngines, firstRunNoEngines
    case firstRunFooter, firstRunOpenMachines
    /// Between the items of an inline list.
    case listSeparator
}

/// A message in both languages. Placeholders look like `{name}`.
struct Entry {
    let zh: String
    let en: String
}

enum L10n {
    static let table: [Msg: Entry] = [
        .menuAbout: Entry(zh: "关于 Open Agent API", en: "About Open Agent API"),
        .menuSettings: Entry(zh: "设置…", en: "Settings…"),
        .menuReloadConsole: Entry(zh: "重新载入控制台", en: "Reload Console"),
        .menuRestartGateway: Entry(zh: "重启后台服务", en: "Restart Gateway"),
        .menuHide: Entry(zh: "隐藏 Open Agent API", en: "Hide Open Agent API"),
        .menuHideOthers: Entry(zh: "隐藏其他", en: "Hide Others"),
        .menuShowAll: Entry(zh: "全部显示", en: "Show All"),
        .menuQuit: Entry(zh: "退出 Open Agent API", en: "Quit Open Agent API"),

        .menuEdit: Entry(zh: "编辑", en: "Edit"),
        .menuUndo: Entry(zh: "撤销", en: "Undo"),
        .menuRedo: Entry(zh: "重做", en: "Redo"),
        .menuCut: Entry(zh: "剪切", en: "Cut"),
        .menuCopy: Entry(zh: "拷贝", en: "Copy"),
        .menuPaste: Entry(zh: "粘贴", en: "Paste"),
        .menuSelectAll: Entry(zh: "全选", en: "Select All"),

        .menuView: Entry(zh: "显示", en: "View"),
        .menuCommandPalette: Entry(zh: "命令面板", en: "Command Palette"),
        .menuToggleSidebar: Entry(zh: "切换侧栏", en: "Toggle Sidebar"),
        .menuFullScreen: Entry(zh: "进入全屏幕", en: "Enter Full Screen"),

        .menuWindow: Entry(zh: "窗口", en: "Window"),
        .menuMinimize: Entry(zh: "最小化", en: "Minimize"),
        .menuZoom: Entry(zh: "缩放", en: "Zoom"),
        .menuShowConsole: Entry(zh: "显示控制台", en: "Show Console"),
        .menuCloseWindow: Entry(zh: "关闭窗口", en: "Close Window"),

        .statusTooltip: Entry(zh: "Open Agent API · 智能体控制台", en: "Open Agent API · Agent console"),
        .statusBadgeOne: Entry(
            zh: "Open Agent API · {count} 个请求等待审批",
            en: "Open Agent API · {count} request awaiting approval"),
        .statusBadgeMany: Entry(
            zh: "Open Agent API · {count} 个请求等待审批",
            en: "Open Agent API · {count} requests awaiting approval"),
        .statusOpenConsole: Entry(zh: "打开控制台", en: "Open Console"),
        .statusOpenInBrowser: Entry(zh: "在默认浏览器中打开", en: "Open in Default Browser"),
        .statusCopyAdminKey: Entry(zh: "复制管理员密钥", en: "Copy Admin Key"),
        .statusCopyBaseUrl: Entry(zh: "拷贝服务地址（Base URL）", en: "Copy Base URL"),
        .statusOpenDataFolder: Entry(zh: "打开数据目录", en: "Open Data Folder"),

        .buttonOK: Entry(zh: "好", en: "OK"),
        .buttonConfirm: Entry(zh: "确认", en: "Confirm"),
        .buttonCancel: Entry(zh: "取消", en: "Cancel"),
        .notificationTestBody: Entry(
            zh: "审批通知已开启：有请求等待你审批时，会这样提醒你。",
            en: "Approval notifications are on: this is how you will be alerted when a request is waiting for your approval."),

        .aboutBody: Entry(
            zh: "智能体控制台 · 一次发布，随处调用。\n\n监听地址：{url}\n数据目录：{dir}",
            en: "Agent console · publish once, call anywhere.\n\nListening on: {url}\nData folder: {dir}"),

        .splashTagline: Entry(zh: "一次发布 · 随处调用", en: "Publish once · call anywhere"),
        .splashStarting: Entry(zh: "正在启动后台服务…", en: "Starting the gateway…"),
        .splashStartingAt: Entry(zh: "正在启动后台服务 · {address}", en: "Starting the gateway · {address}"),
        .splashRestarting: Entry(zh: "正在重启后台服务…", en: "Restarting the gateway…"),
        .splashFailed: Entry(
            zh: "后台服务没能启动（端口 {port}）。请查看日志：{log}",
            en: "The gateway did not start (port {port}). See the log: {log}"),
        .windowTitleIsolated: Entry(zh: "{title}（隔离运行）", en: "{title} (isolated run)"),

        .problemPortOtherTitle: Entry(
            zh: "端口 {port} 已被占用",
            en: "Port {port} is already in use"),
        .problemPortOtherBody: Entry(
            zh: "有别的程序（也可能是另一个 Open Agent API 实例）在使用 127.0.0.1:{port}，Open Agent API 没有连接它。\n\n请退出占用该端口的程序，或把配置文件里的 \"port\" 改成别的数字，然后在菜单里选「重启后台服务」。\n配置文件：{config}\n（隔离运行时请改用环境变量 OAA_DESKTOP_PORT。）",
            en: "Another program (possibly another Open Agent API instance) is using 127.0.0.1:{port}, and Open Agent API did not connect to it.\n\nQuit that program, or change \"port\" in the configuration file to another number, then choose “Restart Gateway” from the menu.\nConfiguration file: {config}\n(For an isolated run, change the OAA_DESKTOP_PORT environment variable instead.)"),
        .problemPortGatewayTitle: Entry(
            zh: "端口 {port} 上已有另一个 Open Agent API 网关",
            en: "Another Open Agent API gateway is already on port {port}"),
        .problemPortGatewayBody: Entry(
            zh: "127.0.0.1:{port} 上的网关不是由这份数据目录启动的，可能是另一个 Open Agent API 实例（例如用命令行启动的，或另一份应用）。为了不连到别人的数据，本应用没有使用它。\n\n请先退出那个实例，或把配置文件里的 \"port\" 改成别的数字，然后在菜单里选「重启后台服务」。\n配置文件：{config}\n（隔离运行时请改用环境变量 OAA_DESKTOP_PORT。）",
            en: "The gateway on 127.0.0.1:{port} was not started from this data folder. It may be another Open Agent API instance (for example one started from the command line, or another copy of the app). To avoid connecting to someone else's data, the app did not use it.\n\nQuit that instance first, or change \"port\" in the configuration file to another number, then choose “Restart Gateway” from the menu.\nConfiguration file: {config}\n(For an isolated run, change the OAA_DESKTOP_PORT environment variable instead.)"),
        .problemConfigPortTitle: Entry(
            zh: "配置里的端口无效",
            en: "The configured port is not valid"),
        .problemConfigPortBody: Entry(
            zh: "配置文件里的 \"port\"（{value}）不是 1–65535 之间的整数。请改成一个空闲的端口，再在菜单里选「重启后台服务」。\n配置文件：{config}",
            en: "\"port\" in the configuration file ({value}) is not an integer between 1 and 65535. Set it to a free port, then choose “Restart Gateway” from the menu.\nConfiguration file: {config}"),
        .problemConfigTitle: Entry(
            zh: "没能读取网关配置",
            en: "Could not read the gateway configuration"),
        .problemConfigBody: Entry(
            zh: "没能读取或创建 {dir} 里的 config.json（文件夹不可写，或文件不是有效的 JSON）。请检查这个文件夹和文件。",
            en: "Could not read or create config.json in {dir} (the folder is not writable, or the file is not valid JSON). Check the folder and the file."),
        .problemNotStartedTitle: Entry(
            zh: "后台服务没能启动",
            en: "The gateway did not start"),
        .problemHomeTitle: Entry(
            zh: "隔离运行的数据目录无效",
            en: "Invalid data folder for the isolated run"),
        .problemHomeBody: Entry(
            zh: "OAA_DESKTOP_HOME（或 --home）必须是绝对路径，可以用 ~ 开头。现在的值是：{value}",
            en: "OAA_DESKTOP_HOME (or --home) must be an absolute path, which may start with ~. The value is: {value}"),
        .problemEnvPortTitle: Entry(
            zh: "隔离运行的端口无效",
            en: "Invalid port for the isolated run"),
        .problemEnvPortBody: Entry(
            zh: "OAA_DESKTOP_PORT（或 --port）必须是 1–65535 之间的整数。现在的值是：{value}",
            en: "OAA_DESKTOP_PORT (or --port) must be an integer between 1 and 65535. The value is: {value}"),
        .firstRunTitle: Entry(
            zh: "首次启动：已为你做好这些准备",
            en: "First launch: set up for you"),
        .firstRunSample: Entry(
            zh: "• 发布了离线示例智能体 {agent}：它不调用任何模型，也不联网，可以直接试用。",
            en: "• Published the offline sample agent {agent}: it calls no model and uses no network, so you can try it right away."),
        .firstRunAntigravity: Entry(
            zh: "• 发布了示例智能体 {agent}：由本机的 Antigravity 执行。",
            en: "• Published the example agent {agent}: it runs on the Antigravity installed on this Mac."),
        .firstRunEngines: Entry(
            zh: "• 启用了本机检测到的智能体引擎：{engines}。",
            en: "• Enabled the agent engines found on this Mac: {engines}."),
        .firstRunNoEngines: Entry(
            zh: "• 没有在本机检测到 Codex、Claude Code 等智能体引擎，所以没有启用任何引擎。",
            en: "• No agent engine such as Codex or Claude Code was found on this Mac, so none was enabled."),
        .firstRunFooter: Entry(
            zh: "启用只是让引擎「可用」：只有你发布了使用它的智能体、并且用密钥调用时，它才会运行。\n想停用某个引擎，请打开控制台的「执行机器」页，关掉对应的开关（本应用每次启动都会重新检测并启用已安装的引擎）。",
            en: "Enabling only makes an engine available: it runs only after you publish an agent that uses it and call that agent with a key.\nTo turn an engine off, open the “Execution machines” page of the console and switch it off (this app detects and enables the installed engines again each time it starts)."),
        .listSeparator: Entry(zh: "、", en: ", "),
        .firstRunOpenMachines: Entry(
            zh: "查看「执行机器」页",
            en: "Show Execution Machines"),
        .problemNeedsHomeTitle: Entry(
            zh: "缺少隔离运行的数据目录",
            en: "No data folder for the isolated run"),
        .problemNeedsHomeBody: Entry(
            zh: "OAA_DESKTOP_PORT（或 --port）只能和 OAA_DESKTOP_HOME（或 --home）一起使用：端口会写进隔离数据目录的 config.json，不会改动默认数据目录。",
            en: "OAA_DESKTOP_PORT (or --port) only works together with OAA_DESKTOP_HOME (or --home): the port is written into the config.json of the isolated data folder and never into the default data folder."),
    ]

    /// The text of a message with `{name}` placeholders filled in. A message that is missing from the
    /// table (never in a shipped build: the self-check covers every case) falls back to its key.
    static func text(_ msg: Msg, _ params: [String: String] = [:], lang: ShellLanguage = .current) -> String {
        guard let entry = table[msg] else { return msg.rawValue }
        var out = lang == .zh ? entry.zh : entry.en
        for (name, value) in params { out = out.replacingOccurrences(of: "{\(name)}", with: value) }
        return out
    }

    /// Names of the `{placeholders}` in a template, for the self-check.
    static func placeholders(in text: String) -> Set<String> {
        var found = Set<String>()
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {
            found.insert(String(rest[rest.index(after: open)..<close]))
            rest = rest[rest.index(after: close)...]
        }
        return found
    }
}

/// Shorthand used by the AppKit code.
func tr(_ msg: Msg, _ params: [String: String] = [:]) -> String {
    L10n.text(msg, params)
}
