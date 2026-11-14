# 安装 Open Agent API

[English](../install.md) · 简体中文

下面每条路线的结尾都一样：`oaa quickstart` 会初始化数据目录，在 `127.0.0.1` 上后台启动网关，发布一个**离线示例智能体**
（`agent/sample`：不调用模型、不联网、不花钱），生成调用方密钥文件，真调一次，最后打印 Base URL、model 名和一条可以直接粘贴运行的
`curl`。重复运行不会重复创建任何东西。`oaa stop` 停止网关。

发布文件在项目的 GitHub 发布页（`https://github.com/jiangxingfan1-coder/Open-Agent-API/releases`）。示例里的 `<version>` 指你下载的那个版本。
Linux 包、`install.sh`、npm tarball 与 Docker 镜像随 0.0.64 之后发布的版本提供；0.0.64 本身只有 macOS 与 Windows 安装包。每个版本都有一个
`SHA256SUMS`：Linux 用 `sha256sum -c SHA256SUMS --ignore-missing` 校验下载，macOS 用 `shasum -a 256 -c SHA256SUMS --ignore-missing`，
Windows 用 `Get-FileHash`。

| 路线 | 需要 | 适合 | 不适合 |
| --- | --- | --- | --- |
| [macOS 应用](#macos) | macOS 13+ | 想要桌面应用与控制台在一个窗口里 | 服务器 |
| [Windows zip](#windows) | Windows 10+，x64 | 想要桌面启动器 | 服务器 |
| [Linux tar.gz / `install.sh`](#linux) | glibc 2.28+（x64 或 arm64） | Linux 工作站或服务器，不用 root，不用 Docker | Alpine / musl |
| [Docker](#docker) | 带 Compose v2 的 Docker | 服务器、隔离的网关、内置智能体或远程智能体 | 使用宿主机上的 Codex / Claude Code 命令行 |
| [npm tarball](#npm) | Node.js 24.18 及以上（24 或 26 版本线） | 已经在用 Node，想让 `oaa` 在 PATH 上 | 没有 Node 的机器 |
| [源码](#源码) | Node.js 24.18 及以上（24 或 26 版本线），git | 开发 Open Agent API 本身 | 其他人 |

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

**卸载。** 退出应用（从终端启动的网关用 `oaa stop`），把应用拖进废纸篓；不再需要数据时，删掉
`~/Library/Application Support/OpenAgentAPI` 与各处的 `.oaa` 目录。

## Windows

**安装。** 下载 `Open-Agent-API-<version>-win-x64.zip` 并解压（先在 zip 上右键 → 属性 → 解除锁定，可以避免逐个文件提示）。
双击 `Install-OAA-Windows.cmd`：它把文件复制到 `%LOCALAPPDATA%\Programs\OpenAgentAPI`，创建桌面与开始菜单快捷方式，把这个文件夹加进用户
`PATH`，然后启动应用。包没有代码签名，SmartScreen 可能提示「Windows 已保护你的电脑」：先核对 `SHA256SUMS`，再点「更多信息」→「仍要运行」。
脚本只对这一次启动的 PowerShell 进程用 `-ExecutionPolicy Bypass`，不改你的执行策略。

**Quickstart。** 在新终端里运行 `oaa quickstart`（没有安装时，在解压出的文件夹里运行 `oaa.cmd quickstart`）。快捷方式做的是同一件事，
输出写在 `%LOCALAPPDATA%\OpenAgentAPI\quickstart.log`。

**卸载。** 目前没有卸载程序。运行 `Stop-OpenAgentAPI.cmd`（或 `oaa stop`），删除 `%LOCALAPPDATA%\Programs\OpenAgentAPI`、两个快捷方式，
以及 `PATH` 里的那一项（设置 → 系统 → 关于 → 高级系统设置 → 环境变量）。要删除数据，删 `%LOCALAPPDATA%\OpenAgentAPI`。

## Linux

x64 与 arm64 都有包（`Open-Agent-API-<version>-linux-x64.tar.gz`、`…-linux-arm64.tar.gz`）。包里自带官方 Node.js 运行时，没有桌面外壳。
需要 glibc 2.28 及以上（Debian 10+、Ubuntu 20.04+、RHEL 8+）；Alpine（musl）不支持，请改用 Docker。

**用脚本安装**（不需要 root，`~/.local` 之外什么都不动，也不改 shell 配置文件）：

```bash
curl -fsSL https://github.com/jiangxingfan1-coder/Open-Agent-API/releases/latest/download/install.sh | sh
```

脚本下载适合你 CPU 的 `.tar.gz`，用发布页的 `SHA256SUMS` 校验（不符就拒绝安装），解压到 `~/.local/share/open-agent-api`，并把
`~/.local/bin/oaa` 链接到启动脚本；如果 `~/.local/bin` 不在 `PATH` 上，它会告诉你。选项：`--version X.Y.Z`、
`--prefix DIR`（装到 `DIR/share` 与 `DIR/bin`）、`--uninstall`、`--help`。随发布页附上的那份只安装那个版本；想先读再运行，就下载下来再 `sh install.sh`。
再次运行就是原地升级。

**手动安装。**

```bash
tar -xzf Open-Agent-API-<version>-linux-x64.tar.gz
./Open-Agent-API-linux-x64/oaa quickstart        # 或：sh Open-Agent-API-linux-x64/install.sh
```

**Quickstart。** 在你想放 `.oaa` 数据目录的目录里运行 `oaa quickstart`。

**卸载。** `oaa stop`，然后 `sh install.sh --uninstall`（删除安装目录与链接，绝不删除你的 `.oaa` 数据目录），或者直接删掉解压出来的文件夹。

## Docker

镜像以非 root 的 `node` 用户运行网关，所有状态都在 `/data` 卷里，网关在容器**内部**监听 `0.0.0.0`。`docker-compose.yml` 只把它发布在宿主机的回环地址
（`127.0.0.1:8787`）上，其他机器访问不到；要对外开放，请在前面放一个带 TLS 的反向代理（见 [deploy-public.md](deploy-public.md)），并设置
`OAA_PUBLIC_BASE_URL` / `OAA_ALLOWED_HOSTS`。

> **状态：这份 Dockerfile 没有在开发机上构建过（那里没有 Docker），首次由 CI 验证**（`.github/workflows/docker.yml` 在每次 push 与 pull request
> 时构建它，并在发布任何东西之前跑一遍容器烟雾测试）。首次构建如果失败，看那个工作流的日志；排查清单见 [releasing.md](releasing.md)。

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
用于 `http://127.0.0.1:8787` 的控制台）。之后的启动都复用它们。发布版本后，镜像是 `ghcr.io/jiangxingfan1-coder/open-agent-api:<version>`（以及 `:latest`），
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

发布页上有 `open-agent-api-<version>.tgz`。这个包在 `package.json` 里标了 `private`，防止误发布到 npm 官方源；从文件或发布页地址安装都没问题。

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
npm ci
npm run build
npm run oaa -- quickstart
```

`npm run verify` 会跑类型检查、格式检查与全部测试。**卸载：** `npm run oaa -- stop`，然后删掉检出目录。
