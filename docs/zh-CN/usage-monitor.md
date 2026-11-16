# 用量与额度

[English](../usage-monitor.md) · 简体中文

控制台沿用 OAA 自己的设计系统，并严格分开三类账本：

- **OAA 消耗**：从保留的网关任务统计已上报的输入、输出、总 Token，按日期和智能体汇总。先扣除父任务中已归集的子任务用量，再合计各次执行，防止重复计算。未上报或部分上报显示为未知或已知下限。时间桶按 UTC 执行开始时间，而不是供应商计费事件时间。已清理或从未上报的历史无法重建。
- **账户额度**：展示 CodexBar 上报的窗口、剩余百分比、重置时间，以及来源提供的余额。百分比不等于剩余 Token 数，共享账户额度不会被虚构地拆到每个模型。保留真实零余额，不把缺失数据当零。忽略上游合成的占位窗口；用量未知的命名窗口不显示成满额。
- **本机 Token**：通过 ccusage 读取各智能体本机历史的每日输入、输出、缓存读取和缓存写入汇总。这可能包含 OAA 调用，因此不与 OAA 账本相加。强制离线、无费用估算模式，避免将 API 价格估算当作订阅实际扣费。

OAA API 密钥限额是**本系统的累计授权**，独立于所选时间段及供应商订阅额度。未设置上限表示不设限，不是零余额。

## 开源组件

2026-11-16 对比了以下上游项目：

| 项目 | 特点 | 选择 |
| --- | --- | --- |
| [CodexBar](https://github.com/steipete/CodexBar) | 账户额度覆盖较广，审阅版本登记 114 个提供方 ID，包括 Codex、Claude、Antigravity、Qoder；提供 CLI JSON 和不含凭据的共享缓存 | 主额度采集接口；登记不代表每个提供方都能实测成功或上报所有指标。 |
| [ccusage](https://github.com/ccusage/ccusage) | 19 种智能体来源的统一 Token 历史及缓存分类 | 补充本机用量。 |
| [Quota](https://github.com/pinkpixel-dev/quota) | 只读账户采集及桌面、编辑器集成 | 已研究，未内嵌。 |
| [clanker-usage](https://github.com/wakamex/clanker-usage) | 较小范围提供方的统一计划、额度接口 | 已研究，未内嵌。 |
| [goso](https://github.com/ainoya/goso) | 聚焦 Claude、Codex、Antigravity，明确区分推导值 | 已研究，未内嵌。 |

两个采用项目的来源版本及完整 MIT 许可见 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)。仅集成机器可读数据，不复制上游界面、不修改上游源码。

## 权限与采集

监控接口仅允许直接回环连接的所有者全域管理员，并要求本地网关及匹配的本机执行节点所有者。拒绝转发、跨来源、受限密钥和其他所有者。公网安全模式不会启动采集器；远程读取密钥不能看到本机账户额度。

采集器**默认关闭**，在数据源页显式开启：

1. CodexBar 可读取其主动共享的私有缓存，或使用明确安装的 CLI。macOS 默认路径为 `~/Library/Application Support/CodexBar/CLIUsageCache/usage.json`，需在 CodexBar 自己的设置中启用共享。该缓存不包含凭据或账户身份。
2. CLI 模式需指定最多八个独立提供方 ID，以及 `cli`、`oauth` 或 `api` 来源，不使用 `auto`、`web`、`all`、`both`。OAA 设置 `CODEXBAR_DISABLE_KEYCHAIN_ACCESS=1`，不发送模型提示，不自行读取浏览器 Cookie。采集器或智能体可能刷新自己的认证状态。当前 CodexBar 的 Qoder 接口需要 Cookie，因此在此权限边界下使用单独准备的额度快照，不悄悄扩大浏览器访问权限。
3. 启用 ccusage 即授权读取本机用量历史。固定执行 `daily --by-agent --json --offline --no-cost`，最近 90 天、UTC 日期，工作目录为 OAA 私有采集目录；不修改原日志。
4. 导入操作支持 CodexBar 用量/缓存 JSON，以及 ccusage 每日 JSON。导入快照只驻留内存，不开启定时采集；导入时间不冒充额度观测时间。

开启后每五分钟刷新，手动刷新有 30 秒冷却。子进程不经过 shell，输出和执行时间有上限，不继承 `OAA_*` 凭据，仅转发基础环境和路径变量。外部可执行文件及上游采集实现是可信本机软件，并非操作系统沙箱。采集失败可保留上次数据，但不会让旧数据变新。超过 15 分钟、已跨越重置时间，或缺少可信观测时间的额度标为上次已知或不可用。

设置采用私有权限、原子替换、版本冲突检查，提交前复核管理员权限。归一化结果不包含原始错误、访问令牌、会话正文、项目路径或会话 ID；账户邮箱会脱敏。

## API

能力 `local-usage-v1` 声明：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/local/usage?days=7` | 1–90 天 OAA 账本、累计密钥限额和采集状态 |
| POST | `/v1/local/usage/settings` | `{settings, revision, confirmed:true}`，配置主动授权的采集器 |
| POST | `/v1/local/usage/refresh` | 刷新已启用的来源，不发起模型生成 |
| POST | `/v1/local/usage/import` | `{collector, snapshot}`，collector 为 `codexbar` 或 `ccusage`；有大小限制的 JSON 导入 |

没有兼容额度接口的提供方继续显示不可用。目录发现、夹具测试和导入成功均不等于真实账户额度或完整计费验证。
