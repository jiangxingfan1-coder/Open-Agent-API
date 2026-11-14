# 发布版本

本文说明怎样发一个版本、本机开发打包与发布打包有什么不同、安装包里带了什么，以及别人第一次打开未公证的应用时要怎么做。

## 发一个版本

1. **改版本号**（10 处，全部改成同一个新版本）：
   - `package.json` 的 `version`
   - `package-lock.json` 顶部的 `version` 与 `packages[""].version`（2 处）
   - `src/gateway/endpoints.ts` 的 `GATEWAY_VERSION`
   - `src/engines/acp.ts`、`src/engines/native.ts` 里 ACP 握手的 `clientInfo.version`
   - `src/client/mcp-relay.ts`、`src/client/mcp.ts`、`src/fabric/mcp-connections.ts` 里 MCP 客户端/服务端的 `version`
   - `desktop/macos/main.swift` 「关于」对话框的 `Open Agent API <版本>`

   核对：`grep -rn --exclude-dir=node_modules --exclude-dir=dist -F "<旧版本>" .`，除 `CHANGELOG.md` 里叙述历史的地方外不应再有旧版本号。（打包脚本以前在 `package.json` 没有版本号时回退到一个写死的版本，现在已去掉，所以比以前少一处。）

2. **改变更记录**：把 `CHANGELOG.md` 顶部的「未发布」改为 `## <版本>（<日期>）`。发布工作流取这一节作为草稿 Release 的正文，找不到这一节会直接失败。

3. **本机验证**：`npm run verify`。

4. **提交并打标签**：

   ```bash
   git tag v<版本>
   git push origin main v<版本>
   ```

   也可以在 GitHub 的 Actions 页面手动运行 Release 工作流并填写版本号（须与 `package.json` 一致）；这时草稿 Release 的标签在公开时才创建，指向触发时的提交。

5. **等 CI**：Release 工作流（`.github/workflows/release.yml`）在 macOS arm64、macOS x64、Windows x64 上各自检查、打包、做烟雾测试，最后汇总产物创建**草稿** Release。

6. **检查草稿 Release**：在 GitHub 的 Releases 页面打开草稿，确认有三个安装包（`Open-Agent-API-<版本>-macOS-arm64.dmg`、`…-macOS-x64.dmg`、`…-win-x64.zip`）和一个 `SHA256SUMS`，正文是变更记录里对应的一节。可以下载下来在真机上试装。

7. **发布**：确认无误后在草稿页面点「Publish release」。工作流从不自动公开。

## 本机开发打包与发布打包

| | 本机开发打包 | 发布打包 |
| --- | --- | --- |
| 命令 | `npm run package:mac` / `package:win` / `package:all` | `npm run package:release:mac -- --arch <arm64\|x64> --node-dir <目录> [--node-version <v>]`、`npm run package:release:win -- --node-dir <目录> --node-version <v>` |
| 编译 | 先运行 `npm run build` | 不编译，要求 `dist/` 已存在（CI 里由检查步骤生成） |
| 安装到本机 | **会**：覆盖安装到 `~/Applications` 与 `/Applications`，把 `~/.local/bin/oaa` 链接到应用里的 CLI | **不会**：不安装、不链接、不写用户主目录 |
| 写到哪里 | `release/` 与上面的安装位置 | 只写仓库的 `release/`；脚本的副作用层会拒绝任何越界的写操作 |
| Node 运行时 | 不带，使用本机的 Node | 带官方 Node（`--node-dir` 必填，版本须满足 `engines.node`） |
| 依赖 | 整个 `node_modules`（去掉 `.bin`、`typescript`、`prettier`、`@types`） | 按 `package-lock.json` 筛选，见下节 |
| macOS 产物 | `.dmg` 与 `.pkg` | `.dmg` |
| 校验和 | `release/<平台>/SHA256SUMS` | 同左 |

两种模式都可以加 `--dry-run`：只打印每一步要写的路径和要执行的外部命令（`swiftc`、`sips`、`iconutil`、`codesign`、`ditto`、`hdiutil`、`zip` 等），什么都不做；唯一真正执行的是只读的 `node --version`（校验 `--node-dir` 里的 Node）。进包的顶层依赖清单与各自体积也会打印出来。

`--node-dir` 是从 `https://nodejs.org/dist/v<版本>/` 下载并解压的官方发行目录（macOS 用 `node-v<版本>-darwin-<arm64|x64>.tar.gz`，Windows 用 `node-v<版本>-win-x64.zip`），下载后请用同目录的 `SHASUMS256.txt` 校验。在 macOS 上打 Windows 包时无法执行 `node.exe`，用 `--node-version` 写明版本号以便校验。CI 用的 Node 版本只在 `release.yml` 顶部的 `NODE_RUNTIME_VERSION` 定义一处，测试会核对它满足 `engines.node`。

## 安装包里带了什么、没带什么

带了：

- 编译后的网关与 CLI（`dist/`，不含测试与基准）、控制台（`web/`）、示例、`package.json`、`LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md` 与 `licenses/`。
- **官方 Node 运行时**（只有可执行文件与它的 `LICENSE`，不带 npm）：macOS 在 `Open Agent API.app/Contents/Resources/node/`，Windows 在 `runtime\`。用户不需要另装 Node。
- 运行时依赖：从 `package.json` 的 `dependencies` 出发、按 `package-lock.json` 能到达的包。

没带：

- **`@anthropic-ai/claude-agent-sdk` 及其各平台的包**：它是 Anthropic 的专有许可（「SEE LICENSE IN README.md」），随安装包分发属于再分发，所以不打进公开发布的安装包。只有 Claude 原生引擎用到它；缺少时该引擎返回错误码 `adapter_unavailable`，并说明安装方法：

  ```bash
  npm install --prefix ~/.oaa/vendor @anthropic-ai/claude-agent-sdk@<package.json 里固定的版本>
  ```

  网关在 `~/.oaa/vendor/node_modules`（或环境变量 `OAA_CLAUDE_SDK_DIR` 指定的目录下的 `node_modules`）里查找它，装好后重启网关。安装即表示接受 Anthropic 的条款。`oaa doctor` 与控制台的本机后端信息会把 Claude 引擎标为 `requires_separate_install` 并给出安装命令。从源码运行（`npm ci`）时 SDK 随依赖安装，行为不变。
- 开发依赖（`package-lock.json` 里标了 `dev` 的包，如 `typescript`、`prettier`、`openai`、`@types/*`）。
- 只被上述排除的包引用的包（如 `@anthropic-ai/sdk` 及其依赖：它在锁文件里只是专有 SDK 的 peer 依赖）。
- 与目标平台/架构不符的可选原生包（锁文件里带 `os` / `cpu` 的包，如 `@koromix/koffi-<平台>`），以及 `node-pty/prebuilds/`、`koffi/build/koffi/` 下其他平台的预编译目录。

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

CI（`.github/workflows/ci.yml`）在 Ubuntu 与 macOS 上跑完整的 `npm run verify`（`release-plan` 测试还会离线核对三个工作流：action 是否固定哈希、有没有超时、运行器标签是否退役、矩阵字段与产物目录是否一致）。Windows 作业目前只跑类型检查、格式检查与打包相关的测试（`release-plan`、`claude-sdk`），因为不少测试用到 POSIX 专用写法：用 `chmod` 生成带 shebang 的假可执行文件（`acp`、`approval-policy`、`claude-failure`、`conformance`、`handoff`、`overview`、`sandbox-native` 等）、`/bin/sh`、文件权限位（`harness-bridge-acp`）、`SIGTERM`/`SIGKILL`（`process`、`step-checkpoints`）、写死的 `/tmp` 与 `/usr/bin` 路径（`native-env` 等）。让完整测试在 Windows 上通过是单独的一项工作。

## 工作流的运行器与 action 版本

- **运行器**：macOS arm64 用 `macos-26`，macOS x64 用 `macos-26-intel`，Windows 用 `windows-latest`（Windows Server 2025）。标签以 [actions/runner-images 的 README](https://github.com/actions/runner-images#available-images) 为准；`macos-14` 已于 2026-11-02 从 GitHub Actions 退役，用它会让作业一直排不上队或直接失败。隔一两个版本回来看一眼 README 里有没有新的「deprecated」标记。
- **action 固定到提交哈希**：`uses:` 一律写 `owner/repo@<40 位哈希> # vX.Y.Z`，防止上游标签被改写；`test/release-plan.test.ts` 会检查每一处都是这个格式。升级时到该 action 的 Releases 页面选新版本，用 `git ls-remote --tags https://github.com/<owner>/<repo>` 或 GitHub API（`/repos/<owner>/<repo>/git/ref/tags/<tag>`；注解标签要再取一次 `tag` 对象指向的提交）查出提交哈希，同时改哈希与注释里的版本号。
- **超时**：每个作业都有 `timeout-minutes`（测试会检查），卡死时最多耗掉对应分钟数的额度。
- **Windows 上的几处约定**：打包用的 bash 是 Git Bash；Windows 的 zip 用系统自带的 `System32\tar.exe`（bsdtar），而不是 PATH 里靠前的 Git 自带的 GNU tar（它不会生成 zip）；下载的 Node 校验用 node 自己算 SHA-256；`shell: powershell` 的步骤脚本只能含 ASCII。

## 第一次在 GitHub 上跑 Release 时盯什么

工作流从未在 GitHub 上真正运行过，Windows 的包也没在 Windows 上跑过。第一次推标签后，按下面的顺序看日志，哪一步红了就对着修：

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
| 汇总（release 作业） | `test "$(ls -1 *.dmg \| wc -l)" -eq 2` 失败 | 某个平台的产物没上传；看 build 作业各自的 `upload-artifact` 步骤 |
