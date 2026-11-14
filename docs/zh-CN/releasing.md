# 发布版本

[English](../releasing.md) · 简体中文

本文说明怎样发一个版本、本机开发打包与发布打包有什么不同、安装包里带了什么，以及别人第一次打开未公证的应用时要怎么做。

## 发一个版本

1. **改版本号**（5 处，全部改成同一个新版本）：
   - `package.json` 的 `version`
   - `package-lock.json` 顶部的 `version` 与 `packages[""].version`（2 处）
   - `src/core/version.ts` 的 `PRODUCT_VERSION`：网关（`/health`、OpenAPI、`GATEWAY_VERSION`）、ACP 握手的 `clientInfo.version` 与 MCP 客户端/服务端 `version` 的唯一来源。`test/architecture.test.ts` 会核对它与 `package.json` 一致，并且没有其它源文件写死版本号。
   - `desktop/macos/main.swift`「关于」对话框里的 `Open Agent API <版本>` 字样。这一处是写死的字面量，没有测试覆盖，需要手工改。

   核对：`grep -rn --exclude-dir=node_modules --exclude-dir=dist -F "<旧版本>" .`，除 `CHANGELOG.md` 里叙述历史的地方外不应再有旧版本号。（打包脚本以前在 `package.json` 没有版本号时回退到一个写死的版本，现在已去掉。）

2. **改变更记录**：把 `CHANGELOG.md` 顶部的 `## Unreleased` 改为 `## <版本> (<日期>)`，并在它上方补一个新的空 `## Unreleased`。发布工作流取这一节作为草稿 Release 的正文，找不到这一节会直接失败。`CHANGELOG.zh-CN.md`（标题为 `## 未发布`）同步更新；工作流不读这个文件。

3. **本机验证**：`npm run verify`。

4. **提交并打标签**：

   ```bash
   git tag v<版本>
   git push origin main v<版本>
   ```

   也可以在 GitHub 的 Actions 页面手动运行 Release 工作流并填写版本号（须与 `package.json` 一致）；这时草稿 Release 的标签在公开时才创建，指向触发时的提交。

5. **等 CI**：Release 工作流（`.github/workflows/release.yml`）在 macOS arm64、macOS x64、Windows x64、Linux x64、Linux arm64 上各自检查、打包、做烟雾测试；另有一个 `npm-package` 作业打 npm 包并试装；最后汇总产物创建**草稿** Release。

6. **检查草稿 Release**：在 GitHub 的 Releases 页面打开草稿，确认有这些文件：三个桌面安装包（`Open-Agent-API-<版本>-macOS-arm64.dmg`、`…-macOS-x64.dmg`、`…-win-x64.zip`）、两个 Linux 包（`…-linux-x64.tar.gz`、`…-linux-arm64.tar.gz`）、npm 包 `open-agent-api-<版本>.tgz`、盖了版本号的 `install.sh`，以及一个 `SHA256SUMS`（覆盖除它自己以外的全部文件），正文是变更记录里对应的一节。可以下载下来在真机上试装（各条安装路线的最短步骤见 [install.md](install.md)）。

7. **发布**：确认无误后在草稿页面点「Publish release」。工作流从不自动公开。点发布会触发 `.github/workflows/docker.yml`：构建 `linux/amd64` 与 `linux/arm64` 镜像并推到 `ghcr.io/<owner 小写>/open-agent-api:<版本>` 与 `:latest`（预发布版本和 `1.2.3-rc.1` 这类版本号不打 `latest`）。这一步失败不影响已发布的 Release，修好后在 Actions 页面手动运行 Docker 工作流并填同一个版本号即可（要求该提交的 `package.json` 版本与之一致）。

   首次推送后 ghcr 上的包默认是私有的：在仓库的 Packages 页面把 `open-agent-api` 的可见性改成 Public，并确认它已关联到本仓库（镜像带 `org.opencontainers.image.source` 标签，通常会自动关联）。

## 本机开发打包与发布打包

| | 本机开发打包 | 发布打包 |
| --- | --- | --- |
| 命令 | `npm run package:mac` / `package:win` / `package:all`（`all` = mac + win；Linux 包只有发布模式） | `npm run package:release:mac -- --arch <arm64\|x64> --node-dir <目录> [--node-version <v>]`、`npm run package:release:win -- --node-dir <目录> --node-version <v>`、`npm run package:release:linux -- --arch <x64\|arm64> --node-dir <目录> [--node-version <v>]` |
| 编译 | 先运行 `npm run build` | 不编译，要求 `dist/` 已存在（CI 里由检查步骤生成） |
| 安装到本机 | **会**：覆盖安装到 `~/Applications` 与 `/Applications`，把 `~/.local/bin/oaa` 链接到应用里的 CLI | **不会**：不安装、不链接、不写用户主目录 |
| 写到哪里 | `release/` 与上面的安装位置 | 只写仓库的 `release/`；脚本的副作用层会拒绝任何越界的写操作 |
| Node 运行时 | 不带，使用本机的 Node | 带官方 Node（`--node-dir` 必填，版本须满足 `engines.node`） |
| 依赖 | 整个 `node_modules`（去掉 `.bin`、`typescript`、`prettier`、`@types`） | 按 `package-lock.json` 筛选，见下节 |
| macOS 产物 | `.dmg` 与 `.pkg` | `.dmg` |
| 校验和 | `release/<平台>/SHA256SUMS` | 同左 |

两种模式都可以加 `--dry-run`：只打印每一步要写的路径和要执行的外部命令（`swiftc`、`sips`、`iconutil`、`codesign`、`ditto`、`hdiutil`、`zip` 等），什么都不做；唯一真正执行的是只读的 `node --version`（校验 `--node-dir` 里的 Node）。进包的顶层依赖清单与各自体积也会打印出来。

`--node-dir` 是从 `https://nodejs.org/dist/v<版本>/` 下载并解压的官方发行目录（macOS 用 `node-v<版本>-darwin-<arm64|x64>.tar.gz`，Windows 用 `node-v<版本>-win-x64.zip`，Linux 用 `node-v<版本>-linux-<x64|arm64>.tar.gz`），下载后请用同目录的 `SHASUMS256.txt` 校验。在 macOS 上打 Windows 或 Linux 包时无法执行目标平台的 node，用 `--node-version` 写明版本号以便校验。CI 用的 Node 版本只在 `release.yml` 顶部的 `NODE_RUNTIME_VERSION` 定义一处，测试会核对它满足 `engines.node`。

## 安装包里带了什么、没带什么

带了：

- 编译后的网关与 CLI（`dist/`，不含测试与基准）、控制台（`web/`）、示例、`package.json`、`LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md` 与 `licenses/`。
- **官方 Node 运行时**（只有可执行文件与它的 `LICENSE`，不带 npm）：macOS 在 `Open Agent API.app/Contents/Resources/node/`，Windows 在 `runtime\`，Linux 在 `runtime/bin/node`。用户不需要另装 Node。
- 运行时依赖：从 `package.json` 的 `dependencies` 出发、按 `package-lock.json` 能到达的包。

没带：

- **`@anthropic-ai/claude-agent-sdk` 及其各平台的包**：它是 Anthropic 的专有许可（「SEE LICENSE IN README.md」），随安装包分发属于再分发，所以不打进公开发布的安装包。只有 Claude 原生引擎用到它；缺少时该引擎返回错误码 `adapter_unavailable`，并说明安装方法：

  ```bash
  npm install --prefix ~/.oaa/vendor @anthropic-ai/claude-agent-sdk@<package.json 里固定的版本>
  ```

  网关在 `~/.oaa/vendor/node_modules`（或环境变量 `OAA_CLAUDE_SDK_DIR` 指定的目录下的 `node_modules`）里查找它，装好后重启网关。安装即表示接受 Anthropic 的条款。`oaa doctor` 与控制台的本机后端信息会把 Claude 引擎标为 `requires_separate_install` 并给出安装命令。它在 `package.json` 里是**开发依赖**（`devDependencies`），所以从源码运行（`npm ci`）时仍随开发依赖安装、行为不变，而 npm 包（`npm install -g` 一个 tgz 只装 `dependencies`）与 Docker 镜像（`npm ci --omit=dev`）自然不含它，不需要再手工排除；它的平台二进制每个约 340 MB，作为普通依赖会让 `npm install -g` 与每次 `npx` 冷启动都多下载一份。
- 开发依赖（`package-lock.json` 里标了 `dev` 的包，如 `typescript`、`prettier`、`openai`、`@types/*`）。
- 只被上述排除的包引用的包（如 `@anthropic-ai/sdk` 及其依赖：它在锁文件里只是专有 SDK 的 peer 依赖，现在随 SDK 一起标为 `dev`）。
- 与目标平台/架构不符的可选原生包（锁文件里带 `os` / `cpu` 的包，如 `@koromix/koffi-<平台>`），以及 `node-pty/prebuilds/`、`koffi/build/koffi/` 下其他平台的预编译目录。
- 第三方包里运行时不读的文件（`scripts/release-plan.mjs` 的 `isThirdPartyDeadWeight`，有测试）：所有 `*.map`；包根目录下的 `test(s)`、`__tests__`、`example(s)`、`doc(s)`、`benchmark(s)`、`.github`；lucide 的 `dist/esm` 与 `dist/cjs`（本项目只读 `dist/umd/lucide.js`）；sandbox-runtime 的 `vendor/srt-win`（只留在 Windows 包）与 `vendor/seccomp`（只留在 Linux 包）。另外编译出来的 `dist/examples` 不进包。`.d.ts` 与许可证、README 保留。核对方法：入选包的 `main`/`module`/`bin`/`exports` 没有指向这些目录（lucide 的 `main` 例外，但没有代码 import 它），并且烟雾测试用包内 Node 逐个 import `dist/src` 下的每个模块（`--app-dir`）再跑完整的首次调用链路。macOS arm64 实测：node_modules 64.2 MB → 27.2 MB，`.dmg` 123.0 MB → 86.0 MB。

## 签名、公证与首次打开

### macOS

没有 Apple 开发者证书时，应用只做临时签名（ad-hoc），**没有公证**。别人第一次打开时 macOS 会提示「无法验证开发者」或「Apple 无法检查其是否包含恶意软件」。打开方法（任选其一）：

- 把应用拖进「应用程序」后，在 Finder 里**按住 Control 点按**（或右键）应用 →「打开」→ 在弹出的对话框里再点「打开」。只需要第一次这样做。
- macOS 15 及以后：先双击一次（会被拦下），然后打开「系统设置」→「隐私与安全性」，在页面下方找到被拦下的 Open Agent API，点「仍要打开」并确认。

请先核对下载文件的校验和：`shasum -a 256 -c SHA256SUMS`（只核对你下载的那个文件时，可以 `grep` 出对应的一行再校验）。

有证书时，在仓库的 Actions secrets 里配置以下内容，Release 工作流会自动改用开发者证书签名（hardened runtime，权限见 `desktop/macos/entitlements.plist`）并公证、装订；缺少任何一项时对应步骤直接跳过，不会失败：

| secret | 内容 |
| --- | --- |
| `MACOS_CERT_P12` | 「Developer ID Application」证书与私钥导出的 .p12，base64 编码 |
| `MACOS_CERT_PASSWORD` | .p12 的密码 |
| `MACOS_SIGN_IDENTITY` | 签名身份，如 `Developer ID Application: 名字 (TEAMID)` |
| `APPLE_ID`、`APPLE_TEAM_ID`、`APPLE_APP_PASSWORD` | 公证用的 Apple ID、团队 ID 与 App 专用密码（三者都有才公证） |

本机用证书打包：设置环境变量 `OAA_MACOS_SIGN_IDENTITY` 后运行打包脚本。

### Windows

Windows 包没有代码签名。双击里面的脚本时，SmartScreen 可能提示「Windows 已保护你的电脑」：核对来源与 `SHA256SUMS` 后点「更多信息」→「仍要运行」。从浏览器下载的 zip 带「来自网络」的标记，解压前也可以在 zip 的「属性」里勾选「解除锁定」，这样解压出的文件不再逐个提示。

启动脚本用 `powershell -ExecutionPolicy Bypass -File …` 运行包内的 `.ps1`：这只对这一次启动的 PowerShell 进程生效，不改变系统或用户的执行策略。

Windows 包的数据与日志在 `%LOCALAPPDATA%\OpenAgentAPI`（对应 macOS 的 `~/Library/Application Support/OpenAgentAPI`）；`Stop-OpenAgentAPI.cmd` 退出由桌面启动器在后台启动的网关。

## 平台相关的测试

CI（`.github/workflows/ci.yml`）在 Ubuntu 与 macOS 上跑完整的 `npm run verify`（`release-plan` 测试还会离线核对 `.github/workflows/` 下的全部工作流：action 是否固定哈希、有没有超时、运行器标签是否退役、矩阵字段与产物目录是否一致）。Windows 作业目前只跑类型检查、格式检查与打包相关的测试（`release-plan`、`claude-sdk`），因为不少测试用到 POSIX 专用写法：用 `chmod` 生成带 shebang 的假可执行文件（`acp`、`approval-policy`、`claude-failure`、`conformance`、`handoff`、`overview`、`sandbox-native` 等）、`/bin/sh`、文件权限位（`harness-bridge-acp`）、`SIGTERM`/`SIGKILL`（`process`、`step-checkpoints`）、写死的 `/tmp` 与 `/usr/bin` 路径（`native-env` 等）。让完整测试在 Windows 上通过是单独的一项工作。

**Node 版本矩阵。** `ci.yml` 的 `verify` 作业除 Node 24 外还有一个 Node 26（`ubuntu-latest`，`continue-on-error: true`，只收集结果、不挡合并）。`engines` 仍是 `>=24.18.0 <25`：查过仓库与全部依赖（`package-lock.json` 里只有根包带这个上限）、`git log` 与文档，没有任何代码、注释或说明记录「Node 25 及以上确有不兼容」，上限来自首个基线快照，属保守写法。内核唯一用到的实验性接口是 `node:sqlite`。Node 25 是奇数版本，维护期已结束（nodejs.org 上最后一个 25.x 是 25.9.0），Node 26（Lithium）已是 LTS，所以收集 26 的结果有意义。是否放宽 `engines`（以及同步改 `scripts/package-windows.mjs` 的版本提示、`release.yml` 的 `NODE_RUNTIME_VERSION`、README 与 CONTRIBUTING 里的说法）等这个条目连续几次绿了再定。写这段时本机只有 Node 24.18，没有在 26 上跑过。

## 工作流的运行器与 action 版本

- **运行器**：Linux x64 用 `ubuntu-latest`，Linux arm64 用 `ubuntu-24.04-arm`（GitHub 文档与 runner-images README 把它列在公开仓库的标准运行器里，公开仓库免费不限量；仓库若改回私有，Linux arm64 运行器要按分钟计费，先核对再发布）。macOS arm64 用 `macos-26`，macOS x64 用 `macos-26-intel`，Windows 用 `windows-latest`（Windows Server 2025）。标签以 [actions/runner-images 的 README](https://github.com/actions/runner-images#available-images) 为准；`macos-14` 已于 2026-11-02 从 GitHub Actions 退役，用它会让作业一直排不上队或直接失败。隔一两个版本回来看一眼 README 里有没有新的「deprecated」标记。
- **action 固定到提交哈希**：`uses:` 一律写 `owner/repo@<40 位哈希> # vX.Y.Z`，防止上游标签被改写；`test/release-plan.test.ts` 会检查每一处都是这个格式。升级时到该 action 的 Releases 页面选新版本，用 `git ls-remote --tags https://github.com/<owner>/<repo>` 或 GitHub API（`/repos/<owner>/<repo>/git/ref/tags/<tag>`；注解标签要再取一次 `tag` 对象指向的提交）查出提交哈希，同时改哈希与注释里的版本号。
- **超时**：每个作业都有 `timeout-minutes`（测试会检查），卡死时最多耗掉对应分钟数的额度。
- **Windows 上的几处约定**：打包用的 bash 是 Git Bash；Windows 的 zip 用系统自带的 `System32\tar.exe`（bsdtar），而不是 PATH 里靠前的 Git 自带的 GNU tar（它不会生成 zip）；下载的 Node 校验用 node 自己算 SHA-256；`shell: powershell` 的步骤脚本只能含 ASCII。

## Linux 包、npm 包与 Docker 镜像

- **Linux 包**（`scripts/package-all.mjs linux`，模板在 `scripts/package-linux.mjs`）：`Open-Agent-API-<版本>-linux-<x64|arm64>.tar.gz`，解开是 `Open-Agent-API-linux-<arch>/`：`oaa`（POSIX sh 启动脚本，跟随符号链接，优先用 `runtime/bin/node`）、`app/`、`runtime/`（官方 Node）、`install.sh`、`README-LINUX.txt`。没有桌面外壳。`scripts/install.sh` 是给 `curl | sh` 用的安装脚本（下载、校验 `SHA256SUMS`、解压到 `~/.local/share/open-agent-api`、在 `~/.local/bin/oaa` 放符号链接；`--version`、`--prefix`、`--uninstall`），主体全在函数里且最后一行是 `{ main "$@"; }`，下载被截断时 shell 因语法不完整而不执行任何东西（测试在每个换行处和最后一行的每个前缀处截断来验证）。随包的与发布页上的那份由 `scripts/stamp-install.mjs` 盖上版本号，只安装自己所属的版本；源码里没盖章的副本会改去解析最新发布的标签。
- **npm 包**：`npm pack` 产出 `open-agent-api-<版本>.tgz`（`package.json` 保持 `private: true`，不会误发到 npm 官方源，是否发布由所有者决定），`prepack` 先清掉并重新编译 `dist/`。`release.yml` 的 `npm-package` 作业打包、用 `npm install -g --prefix` 装到临时目录、跑同一个烟雾测试，再用 `npx --package <tgz> oaa --help` 验证依赖被提升到包旁边时也能启动；tgz 作为发布产物上传并写进 `SHA256SUMS`。用户安装：`npm install -g <发布页上 tgz 的地址>`。
- **Docker 镜像**：`Dockerfile`（多阶段、`node:24-slim`、非 root 的 `node` 用户、`/data` 数据卷、`HEALTHCHECK` 打 `/healthz`、生产依赖里没有专有 SDK）、`.dockerignore`、`docker-compose.yml`（端口只映射到宿主机回环 `127.0.0.1:8787`）、`scripts/docker-entrypoint.mjs`（容器内网关监听 `0.0.0.0`，因为端口映射需要；`allowedHosts` 的默认值只含回环名，所以从宿主机访问 `http://127.0.0.1:8787` 的 Host 校验通过，对外暴露只由 compose 的回环映射限制；首次启动初始化数据目录、发布离线示例智能体、写调用方密钥文件并只打印文件位置）。`.github/workflows/docker.yml`：`release: published` 或手动触发时推 `linux/amd64` + `linux/arm64`；`push` 与 `pull_request` 只构建 amd64 并跑容器烟雾测试（首次启动、密钥文件、API 调用、日志里没有密钥、Host 校验、重启幂等、`docker stop` 退出码 0），烟雾测试通过后才推送。

## 第一次在 GitHub 上跑 Release 时盯什么

工作流从未在 GitHub 上真正运行过，Windows 的包也没在 Windows 上跑过；Linux 包、Docker 镜像与 Node 26 条目只在开发机上做过等价的演练（macOS 上用 stub 的 node 解出 Linux 包跑烟雾测试；那里没有 Docker，Dockerfile 的每个阶段是在临时目录里按 `COPY` 与 `RUN` 逐条复现的）。第一次推标签后，按下面的顺序看日志，哪一步红了就对着修：

| 步骤 | 失败时日志的样子 | 原因与处理 |
| --- | --- | --- |
| 作业一直 Queued | `Waiting for a runner to pick up this job…` 超过几分钟 | 运行器标签不存在或已退役：对照 runner-images README 改 `matrix.runner` |
| 下载官方 Node | `curl: (22) The requested URL returned error: 404`；或 `SHA-256 不符` | Node 版本号写错或网络抖动；校验不符不要放行，重新下载 |
| 解压 Node（Windows） | `unzip: command not found` 与 `7z: command not found` 同时出现，或 `tar.exe: ... Unrecognized archive format` | 三条回退都不可用，改用 PowerShell 的 `Expand-Archive` |
| 打包（Windows） | `[失败] Command failed: …System32\tar.exe` | 看 tar 的报错；路径过长时把 `--node-dir` 与仓库放得更浅 |
| 烟雾测试（Windows） | `网关没有就绪（进程已退出，码 N）` 并附 serve.log 末尾 | 包内缺依赖或 Windows 上启动即崩：按 serve.log 的堆栈修；`MODULE_NOT_FOUND` 说明发布包裁剪过头 |
| 烟雾测试（Windows） | `… 退出码 1` 且输出里是中文乱码 | `.cmd` 里混进了非 ASCII，或路径编码问题（测试已限制 `.cmd` 只用 ASCII） |
| PowerShell 5.1 语法检查 | `missing UTF-8 BOM` 或 ParseError 的位置 | 对应 `.ps1` 模板（`scripts/package-windows.mjs`）有语法错误 |
| 烟雾测试（macOS） | `hdiutil: attach failed` / `create failed - Resource busy` | 偶发：脚本已自动重试 3 次；仍失败就重跑作业 |
| 汇总（release 作业） | `test "$(ls -1 *.dmg \| wc -l)" -eq 2` 失败（或 `*.tar.gz` 要 2 个、`*.tgz` 要 1 个） | 某个平台的产物没上传；看 build 与 `npm-package` 作业各自的 `upload-artifact` 步骤 |
| 作业一直 Queued（Linux arm64） | `ubuntu-24.04-arm` 排不上队 | 仓库是私有的，或标签变了：对照 runner-images README；不可用时先把矩阵里 arm64 的 Linux 条目删掉，只出 x64 |
| 打包（Linux） | `tar: ... Cannot change ownership` 或 `unrecognized option '--owner=0'` | 运行器上的 `tar` 不是 GNU tar：改 `tarCommand`（`scripts/release-plan.mjs`）里 linux 分支的参数 |
| 烟雾测试（Linux） | `网关没有就绪` 且 serve.log 里是 `GLIBC_2.xx not found` 或 `cannot execute binary file` | 官方 Node 的架构或 glibc 与运行器不符：核对 `matrix.node_dist` 与 `matrix.arch` |
| 烟雾测试（Linux / npm） | `有模块无法 import` 并列出模块 | 瘦身裁掉了运行时要读的文件：看缺的是哪个包的哪个路径，把它加进 `isThirdPartyDeadWeight` 的例外 |
| 烟雾测试（各平台） | `等待超时` 出现在 `任务停在 requires_action`、`oaa approvals 列出待批准项` 或 `stop 之后仍有进程使用 …` | 示例智能体子进程没起来（Linux 上看 `ps` 与 serve.log）或网关没退干净：按日志修；残留进程说明 SIGTERM 没被处理 |
| `install.sh` 试装（Linux） | `SHA-256 mismatch` 或 `download failed: file://…` | 试装用的 `OAA_DOWNLOAD_BASE` 指向 `release/linux`：核对包名里的版本与 `SHA256SUMS` 是否对得上 |
| `npm-package` 作业 | `npm error code E404`（装依赖时）或 `EBADENGINE` 警告 | 前者是 npm 官方源偶发问题，重跑；后者只是警告（`engines` 是 24.x，作业用 `NODE_RUNTIME_VERSION`） |
| `npm-package` 作业 | `npx … oaa --help` 输出为空或 `ERR_MODULE_NOT_FOUND` | `bin` 指向的 `dist/src/cli.js` 没打进包，或依赖被提升后路径写死：看 `npm pack` 的文件清单（`test/npm-package.test.ts` 会核对） |

### Docker 首跑观察清单

Docker 路线**没有在开发机上构建过**（那里没有 Docker），首次由 `docker.yml` 在 CI 里验证。按这个顺序看 `Docker` 工作流的日志：

| 步骤 | 失败时日志的样子 | 原因与处理 |
| --- | --- | --- |
| Build linux/amd64（build 阶段） | `npm error ... EUSAGE` / `npm ci can only install packages when your package.json and package-lock.json are in sync` | 改了 `package.json` 没更新锁文件：本地 `npm install --package-lock-only` 后提交 |
| Build（build 阶段） | `tsc` 报 `Cannot find module` / `TS6059 rootDir` / 找不到 `test/...` | build 阶段只拷了 `src test examples bench tsconfig.json`：`tsconfig.json` 的 `include` 加了新目录时，Dockerfile 要对应加 `COPY` |
| Build（deps 阶段） | `test ! -e node_modules/@anthropic-ai/claude-agent-sdk` 失败，退出码 1 | 专有 SDK 又被改回普通依赖（`package.json` 的 `dependencies`）：改回 `devDependencies`（`test/claude-sdk.test.ts` 会拦住） |
| Build（runtime 阶段） | `COPY failed: file not found in build context` | `.dockerignore` 把某个要拷的路径排掉了，或路径改名了（`test/docker-config.test.ts` 会拦住）：对照报错的路径 |
| 烟雾测试 | `The gateway did not answer /healthz` 并附容器日志 | 看日志：`Cannot find module` 是 runtime 阶段漏拷了文件（`package.json` 必须在，里面的 `"type": "module"`），`EACCES` 是 `/data` 没有归 `node` 用户（`VOLUME` 要在 `chown` 之后）；`invalid_host` 说明 Host 校验没放行回环 |
| 烟雾测试 | `No caller key file appeared`，日志里有 `Preparing the sample agent or key failed` | 看后面的错误：`adapter_unavailable` / 示例智能体子进程起不来（容器里 `process.execPath` 是 `/usr/local/bin/node`，路径写在 `config.json` 的 `adapters.oaa-sample`） |
| 烟雾测试 | `A key was printed in the container log` | 入口脚本或网关把密钥打到了日志里：入口只许打印密钥文件的位置 |
| 烟雾测试 | 重启后 `healthy` 迟迟不来 | `HEALTHCHECK` 的 `--start-period` 与 `--interval`（各 30 秒）：慢运行器上调大 `--start-period` |
| 烟雾测试 | `docker stop` 之后退出码不是 0（143 / 137） | 信号没有传到网关：`--init`（compose 里是 `init: true`）负责转发，入口脚本把 SIGTERM 转给子进程；137 说明超过 10 秒被杀，看日志里 `app.close()` 为什么没结束 |
| Build and push（arm64） | 在 QEMU 下 `npm ci` 极慢（超过 30 分钟）或 `Illegal instruction` | 仿真下的偶发：重跑；长期方案是改用 arm64 运行器（`ubuntu-24.04-arm`）分别构建再合并清单 |
| Log in / push | `denied: permission_denied: write_package` | 作业权限里要 `packages: write`（已写），且仓库设置 → Actions → General → Workflow permissions 不能把 `GITHUB_TOKEN` 限成只读；包若是旧的、挂在别的仓库下，要在 Packages 设置里给本仓库写权限 |
| pull（用户侧） | `manifest unknown` / `denied` | 首次推送后包默认私有：在 Packages 设置里改成 Public |
| `docker compose up -d`（用户侧，没有 checkout） | 报 `build` 路径不存在 | compose 里同时写了 `image` 与 `build`：没有 checkout 时用 `docker run`（见 install.md）或把 `build:` 一行删掉 |
