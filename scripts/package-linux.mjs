// Text files inside the Linux package (written by scripts/package-all.mjs): the `oaa` launcher and
// the README. POSIX sh only, no bashisms: the package runs on any glibc distribution.
import { nodeRequirement } from './package-windows.mjs';

export { nodeRequirement };

/** Name of the top-level directory inside the .tar.gz (install.sh expects exactly this). */
export const linuxBundleName = (arch) => `Open-Agent-API-linux-${arch}`;

/**
 * The `oaa` launcher. It follows symlinks (install.sh links ~/.local/bin/oaa to it), runs the bundled
 * Node runtime, and only falls back to a Node on PATH when that runtime is missing and the version fits.
 */
export function launcher(req) {
  const check = `const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>=${req.major}&&a<${req.below}&&(a>${req.major}||b>=${req.minor})?0:1)`;
  return `#!/bin/sh
# Open Agent API launcher (Linux). Runs the Node runtime shipped in runtime/ next to this file.
TARGET="$0"
while [ -L "$TARGET" ]; do
  TARGET_DIR="$(cd "$(dirname "$TARGET")" && pwd)"
  TARGET="$(readlink "$TARGET")"
  case "$TARGET" in
    /*) ;;
    *) TARGET="$TARGET_DIR/$TARGET" ;;
  esac
done
ROOT="$(cd "$(dirname "$TARGET")" && pwd)"
CLI="$ROOT/app/dist/src/cli.js"
if [ -x "$ROOT/runtime/bin/node" ]; then
  exec "$ROOT/runtime/bin/node" "$CLI" "$@"
fi
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
  echo "[Open Agent API] runtime/bin/node is missing and no node is on PATH. Reinstall the package. / 缺少 runtime/bin/node，PATH 上也没有 node，请重新安装。" >&2
  exit 1
fi
if ! "$NODE" -e "${check}"; then
  echo "[Open Agent API] $NODE is not ${req.text}; reinstall the package to get runtime/bin/node. / $NODE 的版本不符合 ${req.text}，请重新安装以获得 runtime/bin/node。" >&2
  exit 1
fi
exec "$NODE" "$CLI" "$@"
`;
}

export function desktopLauncher() {
  return `#!/bin/sh
# Open Agent API unified Electron desktop launcher (Linux).
TARGET="$0"
while [ -L "$TARGET" ]; do
  TARGET_DIR="$(cd "$(dirname "$TARGET")" && pwd)"
  TARGET="$(readlink "$TARGET")"
  case "$TARGET" in
    /*) ;;
    *) TARGET="$TARGET_DIR/$TARGET" ;;
  esac
done
ROOT="$(cd "$(dirname "$TARGET")" && pwd)"
exec "$ROOT/desktop/open-agent-api" "$@"
`;
}

export function readme(version, arch, req) {
  return `Open Agent API v${version} - Linux (${arch})
========================================================================

This package ships its own ${req.text} runtime (runtime/bin/node) and the unified Electron desktop shell (./open-agent-api-desktop); no separate Node.js is needed.
本安装包自带 ${req.text} 运行时（runtime/bin/node）与统一跨平台桌面端（./open-agent-api-desktop），不需要另装 Node.js；服务器无头环境也可直接用 oaa 命令行与浏览器控制台。

Install / 安装
  sh install.sh                      installs to ~/.local/share/open-agent-api and links ~/.local/bin/oaa
  sh install.sh --prefix /some/dir   installs to /some/dir/share/open-agent-api and links /some/dir/bin/oaa
  sh install.sh --uninstall          removes both (your .oaa data directories are not touched)
Or just run ./oaa from this directory. / 也可以不安装，直接在本目录运行 ./oaa。

First run / 第一步
  oaa quickstart
It initializes a data directory (.oaa in the current directory), starts the gateway in the background
(listening on 127.0.0.1 only), publishes the offline sample agent agent/sample (no model, no network,
no cost), creates a caller key file, makes one real call, and prints the Base URL, model and a curl you
can paste. Running it again does not create anything twice. Stop the gateway with: oaa stop
它会在当前目录初始化 .oaa 数据目录、在后台启动网关（只监听 127.0.0.1）、发布离线示例智能体 agent/sample
（不调用模型、不联网、不花钱）、生成调用方密钥文件并真调一次，最后打印 Base URL、model 和一条可直接运行的 curl。
重复运行不会重复创建；停止网关：oaa stop

Requirements / 要求
  Linux with glibc 2.28 or newer (Debian 10+, Ubuntu 20.04+, RHEL 8+). Alpine (musl) is not supported;
  use the Docker image there. / 需要 glibc 2.28 及以上的 Linux；Alpine（musl）不支持，请改用 Docker 镜像。

The Claude native engine needs @anthropic-ai/claude-agent-sdk installed separately (Anthropic's own
terms; not shipped here). Run oaa doctor to see the install command.
Claude 原生引擎需要另行安装 @anthropic-ai/claude-agent-sdk（受 Anthropic 条款约束，不随本包分发），运行 oaa doctor 可看到安装命令。

Verify the download / 校验下载：sha256sum -c SHA256SUMS --ignore-missing
`;
}
