# 本地互联：一键接入本机 IDE 与客户端

[English](../local-connections.md) · 简体中文

控制台的 **「本地互联」** 页面会自动扫描这台电脑上已安装的开发工具与桌面客户端，让你不用手动找配置文件、也不用复制粘贴明文密钥，点几下就能把已发布的智能体接进日常使用的编辑器或聊天客户端。

---

## 支持的双通道自动配置

本地互联针对不同客户端提供两条受管写入通道，统一在变更前展示配置差异预览（Diff），并支持随时无损撤销：

| 接入通道 | 支持的本机客户端 | 写入内容与密钥隔离方式 |
| --- | --- | --- |
| **API 提供方自动接入** | **OpenCode**、**Codex CLI**、**DeepSeek Harness（DSH）** | 自动创建最小权限专用密钥并落盘为私有 `0600` 文件；向 OpenCode 合并 `provider["open-agent-api"]`（通过 `{file:<私有密钥路径>}` 引用），向 Codex 写入独立 `[model_providers.oaa]` 段，向 DSH 写入 `llm-pi-ai.providers.oaa-*` 与本地凭据引用 |
| **MCP 桥一键注入** | **Cursor**、**Windsurf**、**Claude Desktop**、**Claude Code** | 在客户端配置中合并 `mcpServers["open-agent-api"]`，指向本机 `oaa mcp --url <网关地址> --token-file <私有密钥路径>`，可选暴露单个智能体或全部已发布智能体，客户端 JSON 中零明文令牌 |

对于 **Qoder 桌面端** 等暂未开放受管写入的客户端，卡片会提供手动接入向导：选好源智能体与选路后，一键复制服务端点并直达官方自定义模型配置说明（[Codex 配置](https://developers.openai.com/codex/config-advanced/)、[Claude 网关](https://code.claude.com/docs/en/llm-gateway)、[OpenCode 提供方](https://opencode.ai/docs/providers/)、[Qoder 自定义模型](https://docs.qoder.com/qoder/custom-models)）。

---

## 三步完成接入

1. **选择目标客户端**：打开控制台左侧 **「本地互联」**，可通过顶部筛选器切换「已检测到 / 全部」或按名称搜索，点击目标客户端卡片。
2. **选择源智能体与预览变更**：
   - 选择要暴露给该客户端的已发布智能体（MCP 通道可直接选择「全部已发布智能体」）、默认模型选路（如 `auto`、`@fast`、`@best`）以及工具边界模式。
   - 点击预览后，网关会计算即将合并的配置片段，不会在预览阶段提前创建密钥或改动磁盘文件。
3. **确认应用与连通性自检**：
   - 确认应用后，网关签发一把仅含 `read`、`invoke`、`files` 权限（不含 `approve` 或 `admin`）的专属密钥，先将原配置文件备份至网关私有的 `local-connections/backups/` 目录，再通过同目录原子替换写入新条目，完整保留你原有的其他服务商、MCP 服务与注释。
   - 随时可点击卡片上的 **「检查」** 验证回环连通性与密钥有效性，或在发布列表变化后点击 **「同步」** 刷新模型快照。

---

## 安全与防自环保护

- **仅限本机回环管理**：所有本地互联读写接口均要求本机 `127.0.0.1` 直接回环访问、同源请求与所有者管理员权限；经公网或反向代理转发的请求一律拒绝改写宿主机配置文件。
- **自动防自环检测**：如果某个已发布智能体本身底层就由 DSH、OpenCode 或 Codex 驱动（或通过委派链指向它们），网关会自动拦截将该智能体反向写回同一客户端的操作，避免死循环调用。
- **精细化无损断开**：点击 **「断开连接」** 时，网关会立即吊销对应的专用密钥、清理私有密钥文件，并仅移除指纹匹配的受管配置项；如果你在外部手工修改过相关字段，网关会保留你的外部修改并提示冲突，绝不用旧备份粗暴覆盖整份文件。

---

## 管理接口参考

当网关 `GET /health` 包含 `local-connections-v1` 特性时，本机管理端提供以下接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/local/connections` | 返回客户端检测列表（`clients` / `targets`）、可选源智能体与当前连接状态；支持 `?refresh=1` 立即重新扫描安装目录 |
| `POST` | `/v1/local/connections/preview` | 生成变更预览计划：`{target?, channel?, agent?, model?, tool_mode?}` |
| `POST` | `/v1/local/connections/apply` | 提交并原子应用尚未过期的预览计划：`{plan_id, target?, channel?}` |
| `POST` | `/v1/local/connections/{id}/check` | 执行直连回环元数据与密钥可用性快速自检（不消耗模型额度） |
| `DELETE` | `/v1/local/connections/{id}` | 吊销专用密钥、删除私有密钥文件并按指纹清理受管配置项 |
