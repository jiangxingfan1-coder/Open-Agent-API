# 在 Windows 上使用 Open Agent API

[English](../windows.md) · 简体中文

本页说明 Open Agent API（OAA）在 Windows 10/11 与 Windows Server 上的表现、与 macOS / Linux 的差异，以及已知不可用的地方。完整测试在 `.github/workflows/windows.yml` 里于 `windows-latest` 上运行；只在 POSIX 上有意义的测试在那里带原因跳过。

## 安装

- **发布 zip**（`Open-Agent-API-<版本>-win-x64.zip`）：解压后在该目录的命令提示符或 PowerShell 里运行 `oaa.cmd quickstart`。zip 自带 Node 运行时，不需要另装。安装包没有代码签名，首次运行时 SmartScreen 可能提示。
- **从源码**：安装 Node.js 24，然后 `npm ci`、`npm run build`、`node dist/src/cli.js quickstart`。

桌面启动器的数据与日志在 `%LOCALAPPDATA%\OpenAgentAPI`。用 `oaa serve --detach` 启动的网关把 `server.log` 与 `server.pid` 写在它的数据目录里。

## 接入已安装的智能体

在 Windows 上用 npm 安装的智能体是 `.cmd` 启动器（`codex.cmd`、`claude.cmd`、`gemini.cmd` 等）。OAA 的处理方式：

- **发现**（`oaa init`、`oaa quickstart`、`oaa connect`、`oaa doctor`、ACP 预设）按 `PATH` 与 `PATHEXT` 解析不带扩展名的名字（与 `where` 相同），记录带扩展名的完整路径，例如 `C:\Users\me\AppData\Roaming\npm\codex.cmd`。
- **npm 启动器**（`cmd-shim`）完全不经过 `cmd.exe`：OAA 从启动器里读出 JavaScript 入口，直接用 node 启动，参数原样到达智能体。
- **其它 `.cmd` / `.bat`** 用 `cmd.exe /d /s /c` 启动：每个参数先按 Windows 参数规则加引号，再用 `^` 转义两层（分别对付 `cmd.exe` 与批处理里的 `%*`），所以调用方输入里的 `&`、`|`、`%VAR%`、`!VAR!`、引号与空格都只是文本，不会被当成命令执行。含换行的参数无法安全地经过 `cmd.exe`，OAA 直接以 `invalid_request` 拒绝而不是截断；这只影响以普通批处理文件安装的 DSH（它的提示词是命令行参数）。
- **`.exe`** 与 `.js` / `.mjs` / `.cjs` 脚本直接启动（脚本经 node）。
- Claude Agent SDK 自己启动 Claude Code 命令行；OAA 交给它的是 npm 启动器背后的 JavaScript 入口（或 `claude.exe`），而不是 `claude.cmd`。

## 结束进程

Windows 上控制台程序没有 SIGTERM，结束 `.cmd` 启动器也不会结束它启动的程序。所以 OAA 在取消、超时与网关关闭时都用 `taskkill /pid <pid> /T /F` 结束智能体的整棵进程树。这是强制结束：智能体没有机会做清理。

`oaa stop` 先通过 `POST /v1/gateway/shutdown` 请后台网关自行关闭（需要覆盖整个所有者的管理员密钥，且只接受回环地址），等它处理完在途请求并关闭数据库；10 秒后仍在运行才强制结束进程。发信号前 `oaa stop` 会确认配置端口上应答的网关报告的正是记录的 pid，不会误杀被复用的 pid。

数据库是 WAL 模式加 `synchronous=FULL` 的 SQLite；强制结束最多丢失一个在途请求，不会丢已提交的数据。

在运行 `oaa serve` 的控制台里按 `Ctrl+C` 会正常关闭网关（Node 把它映射为 SIGINT）。

## 文件与权限

- `0600` 这类权限位在 Windows 上无效。OAA 写私有文件（`admin.token`、调用方密钥、`server.pid`）时会额外运行 `icacls <文件> /inheritance:r /grant:r <域>\<用户>:F`，只让当前用户可读。这是尽力而为：`icacls` 失败时文件沿用所在文件夹的 ACL。请把数据目录放在自己的用户目录下（默认如此），那里的文件夹 ACL 本身就是私有的。
- Windows 特殊对待的相对文件名会被拒绝（`invalid_path`）：含 `:` 的名字（备用数据流）、保留设备名（`CON`、`NUL`、`COM1` 等）、以点或空格结尾的名字。
- 支持含空格与非 ASCII 用户名的路径（`C:\Users\名字 带空格\`）。
- 调用方工具中继用命名管道（`\\.\pipe\oaa-relay-<随机数>`）代替 Unix 套接字；每个连接都必须出示该运行私有目录里令牌文件中的令牌。
- `oaa status` 用 `server.pid` 的修改时间推算网关运行时长（Windows 没有 `ps -o etime`），所以只有用 `--detach` 启动的网关会显示运行时长。`oaa verify` 没有 `ps` 无法列出子孙进程，会注明进程残留检查已跳过。

## 沙箱

原生智能体的 OS 沙箱（`@anthropic-ai/sandbox-runtime`）只支持 macOS 与 Linux。在 Windows 上要求沙箱的运行会以 `sandbox_unavailable` 失败，绝不会静默地不设防运行。

## 控制台输出

Node 直接向 Windows 控制台写 Unicode，所以在 Windows Terminal、PowerShell 与命令提示符里中文都能正常显示，不需要 `chcp 65001`。输出重定向到文件时是 UTF-8。发布 zip 里的 `.cmd` 启动器只含 ASCII。

## 已知限制

- 没有沙箱（见上）。
- 智能体进程总是被强制结束（`taskkill /F`）。
- 含换行的文本不能作为命令行参数传给非 npm 的批处理启动器。
- 安装包没有签名。
- 行为由 GitHub Windows 构建机上的自动化测试验证，还没有在 Windows 真机上配合真实的 Codex、Claude Code 或 Antigravity 人工使用过。
