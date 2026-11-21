# 安装 Open Agent API

[English](../install.md) · 简体中文

下面每条路线的结尾都一样：`oaa quickstart` 会初始化数据目录，在 `127.0.0.1` 上后台启动网关，发布一个**离线示例智能体**
（`agent/sample`：不调用模型、不联网、不花钱），生成调用方密钥文件，真调一次，最后打印 Base URL、model 名和一条可以直接粘贴运行的
`curl`。重复运行不会重复创建任何东西。`oaa stop` 停止网关。

发布文件在项目的 GitHub 发布页（`https://github.com/jiangxingfan1-coder/Open-Agent-API/releases`）。示例里的 `<version>` 指你下载的那个版本。
0.0.64 提供 macOS 与 Windows 安装包，没有 Linux 包、`install.sh` 或 npm tarball。发布页没有所需文件时，请[从源码启动](#源码)或[用 Docker 构建](#docker)。
用发布页的 `SHA256SUMS` 校验下载：Linux 用 `sha256sum -c SHA256SUMS --ignore-missing`，macOS 用 `shasum -a 256 -c SHA256SUMS --ignore-missing`，
Windows 用 `Get-FileHash`。

| 路线 | 环境要求 | 适用场景 | 不适用场景 |
| --- | --- | --- | --- |
| [macOS](#macos) | macOS 13+（Apple 芯片 / Intel） | 希望使用集成控制台、Dock 角标与托盘审批面板的桌面端 | 无头服务器 |
| [Windows](#windows) | Windows 10+（x64） | 希望一键安装桌面应用与命令行工具 | 无头服务器 |
| [Linux](#linux) | glibc 2.28+（x64 或 arm64） | Linux 工作站或服务器，免 root、免预装 Node.js 或 Docker | Alpine / musl 环境 |
| [Docker](#docker) | Docker 与 Compose v2 | 云服务器、容器化隔离部署、托管内置智能体或连接远程节点 | 直接调用宿主机上的 Codex / Claude Code CLI |
| [npm tarball](#npm) | Node.js 24.18+（24 或 26 版本线） | 本机已有 Node 环境，希望将 `oaa` 加入全局 `PATH` | 未装 Node 的机器 |
| [源码](#源码) | Node.js 24.18+（24 或 26 版本线）、git | 二次开发、调试源码或抢先体验主干分支特性 | 仅日常使用 |

macOS、Windows 与 Linux 的包自带 Node.js 运行时；npm 与源码路线用本机的 Node.js（`package.json` 的 `engines`：`>=24.18.0 <27`）。

**Claude 原生引擎**需要 Anthropic 的 `@anthropic-ai/claude-agent-sdk`。它受 Anthropic 自己的条款约束，所以不在任何安装包或镜像里。没有它时，
只有这一个引擎会返回 `adapter_unavailable` 并给出安装命令（`oaa doctor` 也会打印）：
`npm install --prefix ~/.oaa/vendor @anthropic-ai/claude-agent-sdk@<固定的版本>`，装好后重启网关。其余一切都不需要它。

## macOS

**安装。** 打开 `Open-Agent-API-<version>-macOS-arm64.dmg`（Apple 芯片）或 `…-macOS-x64.dmg`（Intel），把应用拖进「应用程序」。
除非维护者配置了证书，应用只做临时签名、**没有公证**，所以第一次打开会被拦下：按住 Control 点按应用，选「打开」，再点一次「打开」
（macOS 15：系统设置 → 隐私与安全性 →「仍要打开」）。只有第一次需要这样做。

**Quickstart。**

```bash
"/Applications/Open Agent API.app/Contents/Resources/oaa" quickstart
```

桌面应用如果已经打开，它占着 8787 端口；加上 `--port 18787`。数据目录是当前目录下的 `.oaa`；桌面应用自己的数据在
`~/Library/Application Support/OpenAgentAPI`。

**首次启动。** 为了开箱即用，应用会发布离线示例智能体 `agent/sample`（不调用任何模型、不联网；装了 `agy` 时还会发布 Antigravity
示例 `agent/antigravity`），并启用它在这台 Mac 上找到的智能体引擎（Codex、Claude Code、Antigravity、DeepSeek Harness）。启用只是让引擎
「可用」：你发布了使用它的智能体、并用密钥调用时才会运行。会有一个对话框把做了什么、去哪里关掉某个引擎（控制台的「执行机器」页；
应用每次启动都会重新检测并启用已安装的引擎）说明一次。

**端口。** 桌面应用的端口取自它自己 `config.json` 里的 `port`（没改过就是 8787；菜单栏图标里有「打开数据目录」）。要改端口，
编辑这个文件，再选「重启后台服务」。端口被占用时，应用会说明是哪个端口、可能是另一个 Open Agent API 实例、怎么改端口，
不会去连那里应答的任何东西。端口上已经有网关在运行时，只有它是为同一份 `config.json` 启动的才会被使用（比如应用崩溃后留下的那个）。

**隔离运行（测试、再开一份）。** 设置 `OAA_DESKTOP_HOME`（数据目录；`--home <目录>` 等价）后，应用的一切读写都在这个目录里；
`OAA_DESKTOP_PORT`（`--port <端口>`，只能和数据目录一起用）指定端口。直接复制运行：

```bash
OAA_DESKTOP_HOME="$(mktemp -d)" OAA_DESKTOP_PORT=18787 "/Applications/Open Agent API.app/Contents/MacOS/OpenAgentAPI"
```

它可以和已安装的那份并排运行而不影响它：已安装那份的数据目录 `~/Library/Application Support/OpenAgentAPI`、它的端口、
`/Applications`、`~/Applications` 与 `~/.local/bin` 都不动，隔离运行也不安装、不链接任何东西。配置、管理员密钥、日志、示例智能体
和端口设置都写在指定目录里；控制台的网页存储（偏好、语言）只放在内存里；窗口位置与外观不保存。窗口标题会带「隔离运行」。
用 ⌘Q 退出，再删掉那个目录。隔离不覆盖的有：macOS 的通知权限属于应用本身，是共用的；从控制台下载的文件仍存到 `~/Downloads`；
你运行的智能体仍是你自己的程序，用的还是真实的主目录。

**卸载。** 退出应用（从终端启动的网关用 `oaa stop`），把应用拖进废纸篓；不再需要数据时，删掉
`~/Library/Application Support/OpenAgentAPI` 与各处的 `.oaa` 目录。

## Windows

**安装。** 下载 `Open-Agent-API-<version>-win-x64.zip` 并解压（先在 zip 上右键 → 属性 → 解除锁定，可以避免逐个文件提示）。
双击 `Install-OAA-Windows.cmd`：它把文件复制到 `%LOCALAPPDATA%\Programs\OpenAgentAPI`，创建桌面与开始菜单快捷方式，把这个文件夹加进用户
`PATH`，然后启动应用。包没有代码签名，SmartScreen 可能提示「Windows 已保护你的电脑」：先核对 `SHA256SUMS`，再点「更多信息」→「仍要运行」。
脚本只对这一次启动的 PowerShell 进程用 `-ExecutionPolicy Bypass`，不改你的执行策略。PowerShell 脚本（安装、启动、退出）的提示文字跟随 Windows 的显示语言：以 `zh` 开头用中文，否则用英文。
启动器的端口取自 `%LOCALAPPDATA%\OpenAgentAPI\config.json` 里的 `port`（这个文件还不存在时用 8787）。

**Quickstart。** 在新终端里运行 `oaa quickstart`（没有安装时，在解压出的文件夹里运行 `oaa.cmd quickstart`）。快捷方式做的是同一件事，
输出写在 `%LOCALAPPDATA%\OpenAgentAPI\quickstart.log`。

**卸载。** 目前没有卸载程序。运行 `Stop-OpenAgentAPI.cmd`（或 `oaa stop`），删除 `%LOCALAPPDATA%\Programs\OpenAgentAPI`、两个快捷方式，
以及 `PATH` 里的那一项（设置 → 系统 → 关于 → 高级系统设置 → 环境变量）。要删除数据，删 `%LOCALAPPDATA%\OpenAgentAPI`。

## Linux

[v0.0.64](https://github.com/jiangxingfan1-coder/Open-Agent-API/releases/tag/v0.0.64) 不含 Linux 安装包，请[从源码启动](#源码)或[用 Docker 构建镜像](#docker)。

发布页有 Linux 文件时，按 CPU 选择 x64 或 arm64 压缩包（`Open-Agent-API-<version>-linux-x64.tar.gz`、`…-linux-arm64.tar.gz`）。包里自带官方 Node.js 运行时，没有桌面外壳。
需要 glibc 2.28 及以上（Debian 10+、Ubuntu 20.04+、RHEL 8+）；Alpine（musl）不支持，请改用 Docker。

**用脚本安装**（不需要 root，`~/.local` 之外什么都不动，也不改 shell 配置文件）。从同一个发布页下载 `install.sh` 和 `SHA256SUMS`，然后运行：

```bash
sha256sum -c SHA256SUMS --ignore-missing && sh install.sh
```

脚本下载适合你 CPU 的 `.tar.gz`，用发布页的 `SHA256SUMS` 校验（不符就拒绝安装），解压到 `~/.local/share/open-agent-api`，并把
`~/.local/bin/oaa` 链接到启动脚本；如果 `~/.local/bin` 不在 `PATH` 上，它会告诉你。选项：`--version X.Y.Z`、
`--prefix DIR`（装到 `DIR/share` 与 `DIR/bin`）、`--uninstall`、`--help`。随发布页附上的那份只安装那个版本。
再次运行就是原地升级。

**手动安装。**

```bash
tar -xzf Open-Agent-API-<version>-linux-x64.tar.gz
./Open-Agent-API-linux-x64/oaa quickstart        # 或：sh Open-Agent-API-linux-x64/install.sh
```

**Quickstart。** 在你想放 `.oaa` 数据目录的目录里运行 `oaa quickstart`。

**卸载。** `oaa stop`，然后 `sh install.sh --uninstall`（删除安装目录与链接，绝不删除你的 `.oaa` 数据目录），或者直接删掉解压出来的文件夹。

## Docker

镜像以非 root 的 `node` 用户运行网关，所有状态持久化在 `/data` 卷里，容器内部监听 `0.0.0.0`。`docker-compose.yml` 默认仅绑定宿主机回环地址（`127.0.0.1:8787`），外部网络无法直接访问；如需公网暴露，请在前端前置 TLS 反向代理（见 [deploy-public.md](deploy-public.md)）并配置 `OAA_PUBLIC_BASE_URL` 与 `OAA_ALLOWED_HOSTS`。CI 在每次提交时自动构建镜像并运行容器启动、密钥生成、接口调用与重启烟雾测试；正式发布版本时同步推送 `linux/amd64` 与 `linux/arm64` 多架构镜像。

**安装与 quickstart。** 在本仓库的检出目录里（镜像还没发布时也能用）：

```bash
docker compose up --build -d
docker compose logs oaa          # 打印密钥文件的位置（绝不打印密钥本身），然后是一条可以粘贴运行的 curl
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $(docker compose exec -T oaa cat /data/.oaa/keys/quickstart.key)" \
  -H 'Content-Type: application/json' \
  -d '{"model":"agent/sample","messages":[{"role":"user","content":"Hello"}]}'
```

第一次启动会初始化 `/data/.oaa`，发布离线示例智能体，写出调用方密钥文件 `/data/.oaa/keys/quickstart.key`（管理员密钥：`/data/.oaa/admin.token`，
用于 `http://127.0.0.1:8787` 的控制台）。之后的启动都复用它们。若已有镜像发布到 GHCR，标签是 `ghcr.io/jiangxingfan1-coder/open-agent-api:<version>`（以及 `:latest`），
有 `linux/amd64` 与 `linux/arm64`；没有检出目录时用 `docker run`：

```bash
docker run -d --init --name oaa -p 127.0.0.1:8787:8787 -v oaa-data:/data \
  ghcr.io/jiangxingfan1-coder/open-agent-api:latest
```

其他命令用 `docker compose exec oaa oaa <命令>` 在容器里运行（工作目录是 `/data`，所以 `.oaa` 就是网关的数据目录）：`oaa doctor`、
`oaa key create --name ci --token-file /data/.oaa/admin.token`、`oaa publish my.oaa --token-file /data/.oaa/admin.token`。内置智能体的模型密钥是环境变量
（`OPENAI_API_KEY`，见 `docker-compose.yml` 里注释掉的占位符）。用 bind mount 代替命名卷时，目录必须对 uid 1000 可写（`sudo chown 1000:1000 ./data`）。

**这条路线能跑什么、不能跑什么。** 容器里没有你宿主机上装的任何命令行智能体：没有 Codex、没有 Claude Code、没有 Antigravity，`oaa connect codex`
什么也找不到。它适合：

- **内置智能体**：用你自己的密钥调用模型 API（默认提供方：OpenAI Responses）；
- **ACP 与 A2A 远程智能体**：网关通过网络连过去；
- **执行节点**：在装了 Codex / Claude Code 的开发机上运行 `oaa node join --config worker.json`，指向容器里的网关（见 [operations.md](operations.md)），
  这样容器是 API 入口，干智能体活儿的是你的机器。

它不会让 Docker 宿主机上装的智能体在容器里可用。

**卸载。** `docker compose down`（加 `-v` 会删除 `oaa-data` 卷，连同里面的全部密钥与运行记录）。

## npm

只有发布页列出 `open-agent-api-<version>.tgz` 时，才用发布包安装；也可以运行 `npm pack` 自己打包。包在 `package.json` 里标了 `private`，没有发布到 npm 官方源。

```bash
npm install -g https://github.com/jiangxingfan1-coder/Open-Agent-API/releases/download/v<version>/open-agent-api-<version>.tgz
oaa quickstart
```

不安装直接用：`npx --package <.tgz 的地址或路径> oaa quickstart`。安装时会从 npm 官方源下载运行时依赖（磁盘上约 270 MB，大头是
`@anthropic-ai/sandbox-runtime` 带进来的可选的 Windows 沙箱 SDK）。其中没有 Claude Agent SDK，见上文。想自己打这个 tarball，在检出目录里运行
`npm pack`（它会先重新编译 `dist/`）。

**卸载。** `oaa stop`，然后 `npm uninstall -g open-agent-api`（你的 `.oaa` 数据目录保留）。

## 源码

```bash
git clone https://github.com/jiangxingfan1-coder/Open-Agent-API.git
cd Open-Agent-API
npm ci --omit=optional --ignore-scripts
npm run build
npm run oaa -- quickstart
```

`npm run verify` 会跑类型检查、格式检查与全部测试。**卸载：** `npm run oaa -- stop`，然后删掉检出目录。
