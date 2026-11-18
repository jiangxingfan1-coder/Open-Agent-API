# macOS Legacy Swift Shell (Archived / 已统一归档)

> **Unified into `desktop/cross-platform/`**
>
> All production desktop builds and GitHub Release pipelines for macOS (`arm64` / `x64`), Windows (`x64`), and Linux now use the unified sandboxed Electron shell in [`desktop/cross-platform/`](../cross-platform/).

## Status / 状态说明

- **English**: Every native macOS capability originally built in this Swift / `WKWebView` shell — the 52pt `hiddenInset` title bar with inset traffic lights (`{ x: 20, y: 18 }`), live Dock & menu-bar pending-approval badges, bilingual approval notifications, three-state port-conflict & orphan-gateway ownership verification, isolated runs (`OAA_DESKTOP_HOME` / `OAA_DESKTOP_PORT` / `--home` / `--oaa-data-dir`), and idempotent first-run seeding (`.seeded`) — has been absorbed into [`desktop/cross-platform/`](../cross-platform/), alongside the new Tray Quick Approvals Panel and Launch at Login toggle. The Swift files here are retained solely as an archived reference and for pure-logic parity checks (`test/desktop-shell.test.ts`).
- **中文**：原 macOS Swift / `WKWebView` 外壳的全部成熟体验（52pt 无边框内嵌红绿灯顶栏、Dock 与菜单栏未决审批角标、双语系统通知、端口冲突三态诊断与孤儿网关平滑接管、`OAA_DESKTOP_HOME` / `OAA_DESKTOP_PORT` / `--oaa-data-dir` 隔离运行模式、以及 `.seeded` 首次启动幂等引导）均已完整合入 [`desktop/cross-platform/`](../cross-platform/) 跨平台 Electron 安全沙箱壳，并新增了「系统托盘快捷审批与状态小窗」及「开机自动启动」开关。本目录已退役双线打包维护，仅保留作为历史归档参考与纯逻辑对照测试（`test/desktop-shell.test.ts`）；所有三端桌面构建统一由 `desktop/cross-platform/build.mjs` 与 `scripts/package-all.mjs` 驱动。
