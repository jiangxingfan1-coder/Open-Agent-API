// Windows 包里的启动脚本模板（由 scripts/package-all.mjs 写出）。
// - .cmd / .vbs 只用 ASCII：cmd.exe 与 WSH 按系统代码页读脚本，中文会乱码；路径里的中文与空格靠
//   %~dp0 / ScriptFullName 在运行时取得、全程加引号，不受脚本编码影响。
// - .ps1 带 UTF-8 BOM 写出（见 package-all.mjs），Windows PowerShell 5.1 才会按 UTF-8 读中文提示。
// - 数据目录：%LOCALAPPDATA%\OpenAgentAPI（对应 macOS 的 ~/Library/Application Support/OpenAgentAPI）。
// - ExecutionPolicy：用 -ExecutionPolicy Bypass 只作用于这一次启动的 powershell 进程，不改系统或用户的
//   执行策略；不用它的话，默认策略（Restricted / 从网上下载带标记的 RemoteSigned）会拒绝运行未签名脚本。

/** engines.node（如 ">=24.18.0 <25"）→ 给人看的说明与 cmd 里检查用的最低主/次版本与上限主版本。 */
export function nodeRequirement(range) {
  const min = /^>=\s*v?(\d+)\.(\d+)/.exec(range.trim());
  const max = /<\s*v?(\d+)\s*$/.exec(range.trim());
  if (!min || !max) throw new Error(`无法从 engines.node 推出 Windows 启动器的版本检查：${range}`);
  const [major, minor, below] = [Number(min[1]), Number(min[2]), Number(max[1])];
  return { major, minor, below, text: `Node.js ${major}.${minor}+ (below ${below})` };
}

export function oaaCmd(req) {
  // 注意：括号块里的 %ERRORLEVEL% 在解析整块时就展开了，所以用 goto 而不是在块里 exit /b %ERRORLEVEL%。
  const check = `const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>=${req.major}&&a<${req.below}&&(a>${req.major}||b>=${req.minor})?0:1)`;
  return `@echo off
setlocal
set "OAA_ROOT=%~dp0app"
set "OAA_NODE=%~dp0runtime\\node.exe"
if exist "%OAA_NODE%" goto run
set "OAA_NODE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined OAA_NODE set "OAA_NODE=%%N"
if not defined OAA_NODE goto nonode
"%OAA_NODE%" -e "${check}"
if errorlevel 1 goto badnode
:run
"%OAA_NODE%" "%OAA_ROOT%\\dist\\src\\cli.js" %*
exit /b %ERRORLEVEL%
:nonode
echo [Open Agent API] ${req.text} is required. This package normally ships it as runtime\\node.exe; that file is missing. 1>&2
exit /b 1
:badnode
echo [Open Agent API] "%OAA_NODE%" is not ${req.text}. Restore runtime\\node.exe from the release zip. 1>&2
exit /b 1
`;
}

export function consoleCmd() {
  return `@echo off
setlocal
title Open Agent API - Gateway
set "OAA_DATA=%LOCALAPPDATA%\\OpenAgentAPI"
if not exist "%OAA_DATA%\\config.json" (
  call "%~dp0oaa.cmd" init --dir "%OAA_DATA%"
  if errorlevel 1 goto failed
)
echo Open Agent API data: "%OAA_DATA%"
echo The address is printed below (port is "port" in config.json). Press Ctrl+C to stop.
call "%~dp0oaa.cmd" serve --config "%OAA_DATA%\\config.json"
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo [Open Agent API] The gateway did not start. If the port is in use, change "port" in
echo   "%OAA_DATA%\\config.json" or stop the other program, then run this again.
pause
exit /b 1
`;
}

export function desktopVbs() {
  return `' Open Agent API - starts the gateway without a console window and opens the console.
Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")
strDir = objFSO.GetParentFolderName(WScript.ScriptFullName)
strPs1 = Chr(34) & strDir & "\\scripts\\win-desktop.ps1" & Chr(34)
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & strPs1, 0, False
`;
}

export function stopCmd() {
  return `@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\win-stop.ps1"
`;
}

const PS_COMMON = `$BundleRoot = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $BundleRoot "app"
$DataDir = Join-Path $env:LOCALAPPDATA "OpenAgentAPI"
$PidFile = Join-Path $DataDir "desktop.pid"
`;

export function desktopPs1(req) {
  return `# Open Agent API 桌面启动器：后台启动网关（无控制台窗口），然后以独立窗口打开控制台。
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
${PS_COMMON}
function Show-Error([string]$Message) {
  [System.Windows.Forms.MessageBox]::Show($Message, "Open Agent API", 0, 16) | Out-Null
  exit 1
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$NodeExe = Join-Path $BundleRoot "runtime\\node.exe"
if (-not (Test-Path -LiteralPath $NodeExe)) {
  Show-Error "安装包里缺少 runtime\\node.exe（需要 ${req.text}）。请重新解压完整的发布包。"
}
$CliJs = Join-Path $AppDir "dist\\src\\cli.js"
$ConfigPath = Join-Path $DataDir "config.json"
$LogOut = Join-Path $DataDir "oaa-desktop.log"
$LogErr = Join-Path $DataDir "oaa-desktop.err.log"

$QuickstartLog = Join-Path $DataDir "quickstart.log"
# 首次启动时还没有 config.json：端口按默认 8787，由下面的 quickstart 初始化。
$Port = 8787
if (Test-Path -LiteralPath $ConfigPath) {
  $Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($Config.port) { $Port = [int]$Config.port }
}
$BaseUrl = "http://127.0.0.1:$Port"

# 是不是本网关在监听（只认 protocol = oaa/1 的 /health）。
# 不经系统代理：Windows PowerShell 5.1 的 Web cmdlet 没有绕过代理的参数，所以直接用 HttpWebRequest。
function Test-Gateway {
  try {
    $req = [System.Net.HttpWebRequest]::Create("$BaseUrl/health")
    $req.Proxy = $null
    $req.Timeout = 1000
    $res = $req.GetResponse()
    $body = (New-Object System.IO.StreamReader($res.GetResponseStream())).ReadToEnd()
    $res.Close()
    return (($body | ConvertFrom-Json).protocol -eq "oaa/1")
  } catch { return $false }
}
function Test-PortBusy {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect("127.0.0.1", $Port); $c.Close(); return $true
  } catch { return $false }
}

if (-not (Test-Gateway)) {
  if (Test-PortBusy) {
    Show-Error "端口 $Port 已被其他程序占用。请关闭占用它的程序，或修改 $ConfigPath 里的 port 后重试。"
  }
  # 由 oaa quickstart 启动：首次初始化、后台启动网关（只监听 127.0.0.1）、发布离线示例智能体
  # agent/sample（不调用任何模型）并真调一次确认可用；重复运行不重复创建。输出（含调用方密钥文件位置与
  # 一条可直接运行的 curl）写进 quickstart.log。用 Start-Process 重定向输出：Windows PowerShell 5.1 在
  # Stop 模式下重定向原生命令的 stderr 会直接中断脚本。
  $Qs = Start-Process -FilePath $NodeExe -ArgumentList @("\`"$CliJs\`"", "quickstart", "--dir", "\`"$DataDir\`"") -WorkingDirectory $AppDir -WindowStyle Hidden -RedirectStandardOutput $QuickstartLog -RedirectStandardError $LogErr -PassThru
  # 不用 -Wait：它会连同 quickstart 留在后台的网关进程一起等，永远不返回；WaitForExit 只等 quickstart 本身。
  $Qs.WaitForExit()
  if ($Qs.ExitCode -ne 0 -or -not (Test-Gateway)) {
    Show-Error "网关没有启动成功，详见日志：$LogErr 与 $QuickstartLog"
  }
}

$TokenPath = Join-Path $DataDir "admin.token"
if (Test-Path -LiteralPath $TokenPath) {
  $Token = (Get-Content -LiteralPath $TokenPath -Raw).Trim()
  if ($Token) { Set-Clipboard -Value $Token }
}

$Browsers = @(
  (Join-Path \${env:ProgramFiles(x86)} "Microsoft\\Edge\\Application\\msedge.exe"),
  (Join-Path $env:ProgramFiles "Microsoft\\Edge\\Application\\msedge.exe"),
  (Join-Path $env:LOCALAPPDATA "Microsoft\\Edge\\Application\\msedge.exe"),
  (Join-Path $env:ProgramFiles "Google\\Chrome\\Application\\chrome.exe"),
  (Join-Path \${env:ProgramFiles(x86)} "Google\\Chrome\\Application\\chrome.exe"),
  (Join-Path $env:LOCALAPPDATA "Google\\Chrome\\Application\\chrome.exe")
)
foreach ($Browser in $Browsers) {
  if ($Browser -and (Test-Path -LiteralPath $Browser)) {
    Start-Process -FilePath $Browser -ArgumentList @("--app=$BaseUrl", "--window-size=1400,880")
    exit 0
  }
}
Start-Process $BaseUrl
`;
}

export function stopPs1() {
  return `# 退出由桌面启动器在后台启动的网关（只结束记录在 desktop.pid 里、且确是本包 node.exe 的进程）。
$ErrorActionPreference = "Stop"
${PS_COMMON}
$NodeExe = Join-Path $BundleRoot "runtime\\node.exe"
$CliJs = Join-Path $AppDir "dist\\src\\cli.js"
# 由 quickstart（oaa serve --detach）启动的网关记录在 server.pid：oaa stop 只结束 /health 报告的那个进程。
if (Test-Path -LiteralPath (Join-Path $DataDir "server.pid")) {
  $Stop = Start-Process -FilePath $NodeExe -ArgumentList @("\`"$CliJs\`"", "stop", "--dir", "\`"$DataDir\`"") -WorkingDirectory $AppDir -NoNewWindow -PassThru -Wait
  if ($Stop.ExitCode -eq 0) { Write-Host "已退出 Open Agent API 网关。" }
}
# 旧版启动器直接启动的网关记录在 desktop.pid。
if (-not (Test-Path -LiteralPath $PidFile)) { exit 0 }
$Id = [int](Get-Content -LiteralPath $PidFile -Raw).Trim()
$Proc = Get-Process -Id $Id -ErrorAction SilentlyContinue
if ($Proc -and $Proc.Path -and ((Resolve-Path -LiteralPath $Proc.Path).Path -eq (Resolve-Path -LiteralPath $NodeExe).Path)) {
  Stop-Process -Id $Id
  Write-Host "已退出 Open Agent API 网关（进程 $Id）。"
} else {
  Write-Host "记录的进程 $Id 已不在运行，或不是本安装包的网关；未结束任何进程。"
}
Remove-Item -LiteralPath $PidFile -Force
`;
}

export function installPs1(version) {
  return `# Open Agent API 一键安装：复制到 %LOCALAPPDATA%\\Programs\\OpenAgentAPI，创建快捷方式，把 oaa 加到用户 PATH。
$ErrorActionPreference = "Stop"
Write-Host "Open Agent API v${version} - Windows 安装" -ForegroundColor Cyan

$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\\OpenAgentAPI"
$StopScript = Join-Path $InstallDir "scripts\\win-stop.ps1"
if (Test-Path -LiteralPath $StopScript) {
  Write-Host "[0/4] 先退出正在运行的旧版本网关 ..."
  & $StopScript
}
Write-Host "[1/4] 复制文件到 $InstallDir ..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot "*") -Destination $InstallDir -Recurse -Force

Write-Host "[2/4] 创建桌面与开始菜单快捷方式 ..."
$Vbs = Join-Path $InstallDir "OpenAgentAPI-Desktop.vbs"
$WshShell = New-Object -ComObject WScript.Shell
foreach ($Dir in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))) {
  $Shortcut = $WshShell.CreateShortcut((Join-Path $Dir "Open Agent API.lnk"))
  $Shortcut.TargetPath = "wscript.exe"
  $Shortcut.Arguments = "\`"$Vbs\`""
  $Shortcut.WorkingDirectory = $InstallDir
  $Shortcut.IconLocation = (Join-Path $InstallDir "runtime\\node.exe") + ",0"
  $Shortcut.Description = "Open Agent API"
  $Shortcut.Save()
}

Write-Host "[3/4] 把 oaa 命令加到用户 PATH ..."
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$Parts = @($UserPath -split ";" | Where-Object { $_ })
if ($Parts -notcontains $InstallDir) {
  [Environment]::SetEnvironmentVariable("Path", (($Parts + $InstallDir) -join ";"), "User")
}

Write-Host "[4/4] 启动 Open Agent API ..."
Start-Process "wscript.exe" -ArgumentList "\`"$Vbs\`""
Write-Host "安装完成。可从桌面或开始菜单打开 Open Agent API；新开的终端里可以直接运行 oaa。" -ForegroundColor Green
`;
}

export function installCmd() {
  return `@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-OAA-Windows.ps1"
pause
`;
}

export function readmeTxt(version, req) {
  return `Open Agent API v${version} - Windows (x64)
========================================================================

本安装包自带 ${req.text} 运行时（runtime\\node.exe），不需要另装 Node.js。
数据与日志目录：%LOCALAPPDATA%\\OpenAgentAPI
  config.json         网关配置（端口 port 默认 8787）
  admin.token         管理员令牌
  oaa-desktop.log     桌面启动器启动的网关的输出
  oaa-desktop.err.log 网关与 quickstart 的错误输出
  quickstart.log      桌面启动器运行 quickstart 的输出（密钥文件位置、curl 示例）
  keys\\quickstart.key  调用方密钥（只在这个文件里，不打印）

第一步：在本目录打开命令提示符，运行  oaa.cmd quickstart
   它会初始化、在后台启动网关（只监听 127.0.0.1）、发布离线示例智能体 agent/sample
   （不调用任何模型、不联网、不花钱）、生成调用方密钥文件并真调一次，
   最后打印 Base URL、model、一条可直接运行的 curl，以及接上你自己的智能体的命令
   （例如本机装了 codex 时：oaa.cmd connect codex）。重复运行不会重复创建。
   下面的桌面启动方式也会自动做同样的事，输出写在 %LOCALAPPDATA%\\OpenAgentAPI\\quickstart.log。

1. 一键安装（推荐）：双击 Install-OAA-Windows.cmd
   安装到 %LOCALAPPDATA%\\Programs\\OpenAgentAPI，创建桌面与开始菜单快捷方式，
   把 oaa 命令加到用户 PATH，然后启动。

2. 免安装运行：双击 OpenAgentAPI-Desktop.vbs
   在后台启动网关，把管理员令牌复制到剪贴板，并以独立窗口打开控制台。
   退出后台网关：双击 Stop-OpenAgentAPI.cmd

3. 控制台模式：双击 OpenAgentAPI.cmd（关闭窗口或按 Ctrl+C 即退出网关）

4. 命令行：oaa.cmd --help

首次运行时 Windows SmartScreen 可能提示「Windows 已保护你的电脑」：安装包没有代码签名，
确认来源是本项目的 GitHub Release 并核对 SHA256SUMS 后，点「更多信息」→「仍要运行」。

Claude 原生引擎需要另行安装 @anthropic-ai/claude-agent-sdk（受 Anthropic 条款约束，不随本包分发），
运行 oaa.cmd doctor 可看到安装命令。
`;
}
