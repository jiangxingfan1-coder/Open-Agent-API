# 五分钟上手：从发布智能体到第一次调用

[English](../quickstart.md) · 简体中文

这篇指南带你走完最核心的三步闭环：**把智能体发布到网关 → 生成专属 API 密钥 → 用现成的官方 SDK 或命令行发起真实调用**。

无论你后面接的是 Python 后端、Next.js 应用、Dify 工作流，还是 Cursor / Claude Desktop，底层都是同一套流程。

---

## 准备工作：启动本机网关

如果你安装了 **macOS / Windows / Linux 桌面应用**，打开应用后本机网关已经在后台运行（默认地址 `http://127.0.0.1:8787`），主窗口就是控制台，直接跳到「第一步」即可。

如果你使用命令行或源码仓库，运行一条命令即可完成初始化并启动后台服务：

```bash
# 已全局安装 oaa 时直接运行 oaa quickstart；源码目录用下面这一行：
npm run oaa -- quickstart
```

`quickstart` 会自动在当前目录创建 `.oaa/` 数据目录、启动只监听 `127.0.0.1:8787` 的网关、发布一个无需模型密钥的离线示例智能体 `agent/sample`，并跑通一次自检调用。浏览器打开 `http://127.0.0.1:8787`，在连接弹窗里选择 `.oaa/admin.token` 即可进入管理控制台。

---

## 第一步：发布你的第一个智能体

根据你手头已有的工具，任选下面最顺手的一种方式：

### 方式 A：发布电脑上已装好的编程智能体（推荐）

如果你的电脑上已经安装并登录了 **Codex CLI**、**Claude Code**、**Antigravity** 或 **Qoder CLI** 等工具，不需要重新配置模型密钥，直接把它们包装成标准 API：

- **在控制台操作**：
  1. 如果是命令行启动的网关，先在左侧 **「执行机器」** 页把检测到的本机引擎开关打开（桌面应用首次启动会自动开启已安装的引擎）。
  2. 点击右上角 **「+ 发布智能体」**，选择对应引擎（例如 `Antigravity` 或 `Codex`），调用名会自动填为 `agent/antigravity` 或 `agent/codex`，点击 **「发布」**。
- **用命令行一步完成**：

  ```bash
  # 自动检测安装状态、在网关启用并发布为 agent/codex（也可填 claude、agy、qoder 等）
  npm run oaa -- connect codex
  ```

### 方式 B：接入本地模型或云端 API（内置内核智能体）

如果你想用网关自带的智能体循环（支持工作区文件读写、SQLite FTS5 项目记忆与 OAA-Lang 编排），只需连上一个模型提供方：

```bash
# 连接本机 Ollama（免密钥，也可以在控制台「执行机器」页扫描自动发现本地运行器）
npm run oaa -- connect ollama

# 或连接云端模型提供方（密钥放入私有文件，不暴露在终端历史里）
npm run oaa -- connect deepseek --key-file ~/.config/deepseek.key
```

执行后会自动配置好提供方并发布通用助手 `agent/assistant`。想自定义提示词、工具权限与多步工作流，可在控制台点击 **「+ 发布智能体」→「OAA-Lang 2.0」** 在线编写发布（详见 [OAA-Lang 语言指南](language.md)）。

---

## 第二步：生成调用方 API 密钥

智能体发布后，调用方不需要管理员令牌，而是使用按智能体限定权限的 API 密钥（形如 `sk-oaa-…`）：

- **在控制台生成**：如果在发布弹窗里勾选了「发布后立即创建 API 密钥」，发布完成后会自动跳出密钥向导；也可以随时进入左侧 **「API 密钥」→「生成密钥」**。勾选允许访问的智能体并点击生成后，弹窗会直接给出调用所需的全部三项信息：
  1. **服务地址**（Base URL）：`http://127.0.0.1:8787/v1`
  2. **API 密钥**（API Key）：`sk-oaa-…`（明文仅展示这一次，支持一键复制）
  3. **模型名**（填入 `model` 字段）：智能体的调用名，例如 `agent/codex` 或 `agent/assistant`
- **用命令行生成**：

  ```bash
  npm run oaa -- key create --name my-app --agent agent/codex \
    --url http://127.0.0.1:8787 --token-file .oaa/admin.token
  ```

  生成的密钥默认以 `0600` 权限保存在 `.oaa/keys/my-app.key`，终端同时会打印一条可直接粘贴验证的 `curl` 命令。

---

## 第三步：在代码或客户端里发起真实调用

现在把上一步拿到的 **Base URL**、**API Key** 和 **智能体调用名** 填进任意官方 SDK，原本调单次模型的写法就直接升级成了调完整智能体任务：

### Python（官方 `openai` SDK）

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key=os.environ["OAA_API_KEY"],  # 填入刚生成的 sk-oaa-…
)

resp = client.responses.create(
    model="agent/codex",                # 填智能体调用名；也可加 @fast / @best / @eco
    input="检查当前目录结构，给出一份模块职责摘要",
)
print(resp.output_text)
```

### Node.js（流式输出与多轮续接）

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8787/v1',
  apiKey: process.env.OAA_API_KEY,
});

const stream = await client.responses.create({
  model: 'agent/codex',
  input: '梳理鉴权模块的错误码定义，列出潜在遗漏项',
  stream: true,
});

let lastId = '';
for await (const event of stream) {
  if (event.type === 'response.output_text.delta') process.stdout.write(event.delta);
  if (event.type === 'response.completed') lastId = event.response.id;
}

// 传入 previous_response_id 即可在同一上下文继续追问
const followUp = await client.responses.create({
  model: 'agent/codex',
  previous_response_id: lastId,
  input: '把刚才提到的第一项补成单元测试用例',
});
console.log('\n', followUp.output_text);
```

### Anthropic Claude SDK 与 Google Gemini SDK

网关同时原生兼容 Claude `/v1/messages` 与 Gemini `v1beta` 协议（注意这两家的 `baseURL` **不带** `/v1` 后缀）：

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  baseURL: 'http://127.0.0.1:8787',
  apiKey: process.env.OAA_API_KEY,
});

const msg = await anthropic.messages.create({
  model: 'agent/codex',
  max_tokens: 2048,
  messages: [{ role: 'user', content: '总结最近一次提交改动了哪些接口' }],
});
console.log(msg.content);
```

---

## 在控制台调试与处理「待审批」任务

- **先在网页里试跑再导代码**：打开控制台左侧的 **「对话工作台」**（`#workbench`），可以直接选智能体发消息、贴图、测试多轮续接，调通后点右上角 **「复制代码」** 就能一键生成带当前参数的 cURL、Python、Node.js、Claude 或 Gemini 代码。
- **遇到写文件或跑命令时的审批暂停**：如果智能体配置了人工审批策略，执行敏感操作时任务不会报错中断，而是稳稳停在 **「待审批」** 状态。你在控制台任务详情、对话工作台行内卡片或桌面端系统托盘小窗里点击 **「批准」**，同一个 HTTP 流就会从挂起点继续往下跑完并返回结果。

---

## 下一步阅读

- **直接复制更多场景代码**（后台长任务、API 自动审批、外层工具桥接、JSON Schema 强约束输出、发图片）：[示例集 Cookbook](../../examples/cookbook/README.zh-CN.md)
- **一键接入本机 IDE 与桌面客户端**（Cursor、Windsurf、Claude Desktop、Claude Code、OpenCode、Codex、DSH）：[本地互联](local-connections.md)
- **多智能体选路、项目记忆与定时工作流**：[智能选路与编排](intelligence.md)、[工作台与工作流](workstation.md)
- **开放给团队成员自助申请密钥**：[开发者平台](platform.md)
