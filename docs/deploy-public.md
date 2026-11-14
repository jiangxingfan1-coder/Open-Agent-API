# 公网部署手册（P0：受信分发）

> 适用范围：把一个 OAA 网关放到公网，给**你认识、信任的调用方**使用（方案里的「形态 A」，见 `docs/public-deployment.md` §3）。面向陌生人的公开调用需要执行沙箱（P1），现在还不具备。
>
> 本文所有命令和配置都是**示例**，要在你自己的服务器上执行。这个仓库不会替你做任何部署、DNS、证书、防火墙或端口操作。

## 1. 部署前确认

- [ ] 网关上要发布哪些智能体？**不要把原生智能体（Codex、Claude、Antigravity、DSH）开放给不可信的调用方。** 它们继承宿主机的全部权限，调用方能让它们读写这台机器上它们能碰到的任何东西。
- [ ] 模型凭据用的是各厂商的 API key，不是个人订阅的登录态。
- [ ] 目标市场的合规要求已确认，例如 ICP 备案、生成式 AI 服务备案，见方案 §13。
- [ ] 准备两个域名：`api.<域名>` 给调用方，`console.<域名>` 给管理面。下文用 `api.example.com` 和 `console.example.com` 代替。

## 2. 架构

```
调用方 SDK / MCP ──HTTPS──▶ 反向代理（TLS）──▶ 网关 127.0.0.1:8787
管理员浏览器     ──HTTPS──▶ 同一个反向代理（console 域名，限制来源 IP）
发布者的 worker  ──WSS 外连──▶ api.example.com/v1/nodes/connect
```

- 网关只监听 `127.0.0.1`，由同机的反向代理对外提供服务。
- Worker 主动连接网关，所在网络不需要开放任何入站端口。

## 3. 安装网关

需要 Node.js 24.18 及以上的 24.x 版本。

```bash
npm ci --omit=optional --ignore-scripts
```

```bash
npm run build
```

```bash
npm run oaa -- init --dir /srv/oaa/data
```

`init` 会生成 `/srv/oaa/data/config.json` 和 `admin.token`，文件权限只对当前用户可读。`admin.token` 是 owner 级管理员密钥，不要发给任何调用方。

## 4. 网关配置

在 `config.json` 里补充或修改下面这些字段，其余保持 `init` 生成的内容：

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "publicBaseUrl": "https://api.example.com",
  "trustProxy": true,
  "allowedHosts": ["api.example.com", "console.example.com"],
  "allowedOrigins": ["https://console.example.com"],
  "consoleHosts": ["console.example.com"],
  "maxActiveRunsPerSubject": 4,
  "defaultKeyExecution": "workspace"
}
```

| 字段 | 作用 |
|---|---|
| `host: 127.0.0.1` | 只给本机的反向代理访问，不直接暴露 |
| `publicBaseUrl` | `GET /v1/me` 返回的 endpoint 目录按这个地址生成 |
| `trustProxy` | 读取 `X-Forwarded-Proto/Host`，以及 `X-Forwarded-For`（审计记录与开发者平台限流用的来源 IP）。只有前面确实有反向代理时才开启 |
| `allowedHosts` | 只响应这些 Host，其它一律 403 `invalid_host` |
| `consoleHosts` | 控制台和 admin 密钥只在这些域名上可用（见 `docs/protocol.md`「管理面与 API 域名分离」） |
| `maxActiveRunsPerSubject` | 每个调用方最多同时有几个未完成请求；owner 总上限仍是 32 |
| `defaultKeyExecution` | 新建密钥默认只能调用 `workspace` 级智能体，调不了原生智能体、适配器和宿主工具。确实需要时，创建密钥时显式指定 `"execution": "host"`，且只给受信方 |

如果网关自带本地 worker（`localWorker`），而且会启用原生智能体或适配器，建议打开环境变量白名单：

```json
{
  "localWorker": {
    "nativeEnv": { "mode": "allowlist", "allow": ["ANTHROPIC_API_KEY"] }
  }
}
```

白名单模式下，子进程只会拿到以下变量：

- 基础变量：`PATH`、`HOME`、`LANG`、`TMPDIR` 等，以及 `LC_*`。
- 代理变量：`HTTP(S)_PROXY`、`ALL_PROXY`、`NO_PROXY`，原样传递，所以开启前后网络行为不变。
- 你在 `allow` 里列出的变量。

`OAA_*` 在任何模式下都不会传给子进程。默认的 `inherit` 模式和以前一样，会继承其它全部变量。

## 5. 反向代理

要求：

- 支持 HTTP/1.1 Upgrade，worker 的 WSS 连接要用。
- 长连接不超时，或超时时间不短于单次运行的最长时长。网关的 SSE 每 15 秒发一次心跳。
- 请求体上限不小于 24 MiB。
- 原样转发 `Host`，并**覆盖**客户端自带的 `X-Forwarded-*` 头，不能把客户端发来的值透传下去。
- 字体等静态资源随网关提供，字体文件带长缓存头（`immutable`），不需要特殊配置。如果代理只放行固定路径，需要放行 `/styles/`、`/shared/`、`/fonts/`，以及门户下的 `/portal/styles/`、`/portal/shared/`、`/portal/fonts/`。

Caddy 示例（自动申请和续期证书）：

```caddyfile
api.example.com {
    request_body {
        max_size 24MB
    }
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
}

console.example.com {
    @outside not remote_ip 203.0.113.0/24
    respond @outside 403
    reverse_proxy 127.0.0.1:8787
}
```

Nginx 示例（证书配置省略）：

```nginx
server {
    server_name api.example.com;
    client_max_body_size 24m;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
```

Nginx 的 `$connection_upgrade` 需要在 `http` 块里用 `map $http_upgrade $connection_upgrade { default upgrade; '' close; }` 定义。`console.example.com` 照此再写一段，并用 `allow` / `deny` 限制来源 IP。

另外，`oaa tunnel` 可以借助 cloudflared 生成一个临时公网地址，适合演示，不建议长期使用。

## 6. 启动

```bash
npm run oaa -- serve --config /srv/oaa/data/config.json --detach
```

`--detach` 会确认后台进程已经启动，PID 和日志写在数据目录里。需要开机自启的话，用 systemd 之类的进程管理工具运行不带 `--detach` 的 `serve`。

启动后在服务器上检查：

```bash
curl -s http://127.0.0.1:8787/health
```

本机直接访问时会返回 `pid`。通过 `https://api.example.com/health` 访问时没有 `pid`，这是预期行为。

## 7. 分发调用方密钥

每个调用方单独一把密钥，在**控制台域名**上创建：

```bash
curl -s https://console.example.com/v1/keys \
  -H "Authorization: Bearer $(cat /srv/oaa/data/admin.token)" \
  -H 'Content-Type: application/json' \
  -d '{"name":"partner-a","agents":["agent/research"],"scopes":["invoke","read","files"],"quota":{"rpm":60,"maxConcurrentRuns":2}}'
```

- 返回的 `token` 只显示这一次，请通过安全渠道交给对方。
- 默认 `data_scope` 是 `own`：调用方只能看到自己的运行、文件和记忆，彼此隔离（见 `docs/protocol.md`「调用方数据隔离」）。
- 只读监控面板这类需要看到全部调用方数据的密钥，创建时加 `"data_scope": "owner"`，并且只授予 `read` 权限。
- 不要给调用方 `admin` 权限。配置了 `consoleHosts` 后，admin 密钥在 API 域名上也用不了。
- 被拒绝的调用（权限、隔离、配额）会进入审计记录，可以用管理员密钥在控制台域名上通过 `GET /v1/audit` 查看。

调用方的写法：

```python
from openai import OpenAI

client = OpenAI(base_url="https://api.example.com/v1", api_key="分发给他的密钥")
response = client.responses.create(model="agent/research", input="分析这些资料。")
```

如果希望调用方**用自己的模型额度**，在 worker 的提供方配置里加 `"byok": true`（见 `docs/protocol.md`「调用方自带模型密钥」）。调用方在请求头里带上自己的密钥：

```python
client = OpenAI(
    base_url="https://api.example.com/v1",
    api_key="分发给他的密钥",
    default_headers={"X-OAA-Provider-Key": "调用方自己的模型提供方密钥"},
)
```

注意：开启 `byok` 后，调用方的密钥会被发送到这个提供方配置的 `baseUrl`，所以只对你信任的上游地址开启。

### 用开发者平台分发

如果希望开发者自己注册、自己创建密钥，而不是由你逐个发放，可以配置 `platform` 段启用开发者平台（配置与接口见 [platform.md](platform.md)）。这时：

- 开发者在门户 `https://api.example.com/portal/` 注册、兑换点数、创建自己的 API 密钥。门户创建的密钥权限固定为 `invoke`、`read`、`files`，没有 `admin`。执行等级由 `platform.keyExecution` 决定，只能是 `workspace` 或 `sandbox`。
- 开发者只能调用你在控制台「开发者平台」页上架且启用的智能体。
- 点数由你发放（兑换码或手动调整），平台不接支付。
- 不要上架原生智能体（Codex、Claude、Antigravity、DSH）。它们以宿主机权限运行，`workspace` 等级的密钥本来也调不了它们（见第 4 节的 `defaultKeyExecution`）。
- 账号密钥不出现在 `GET /v1/keys` 的列表里。

## 8. 接入远程 worker

1. 在控制台域名上登记节点：`POST /v1/nodes/enroll`，请求体为 `{"node_id":"workstation-2","agents":["agent/research"],"capabilities":["*"]}`。返回的 `token` 是节点凭据，和调用方密钥完全分开。
2. 在 worker 机器上写配置，其中 `gatewayUrl` 填 `https://api.example.com`，`tokenFile` 指向上一步拿到的节点凭据。完整格式见 README「Workers」。
3. 在 worker 机器上运行：

```bash
npm run oaa -- node join --config /private/path/worker.json
```

可以用 `oaa node drain`、`oaa node resume`、`oaa node revoke` 暂停、恢复或吊销节点。

## 9. 备份、升级与回退

- 数据都在数据目录里：`state.sqlite` 加上 `files/`。备份时先停网关，或者用 SQLite 的在线备份（`VACUUM INTO`），不要在网关运行时直接复制正在写入的数据库文件。
- **升级到 schema v4 时会自动备份**，路径是 `<dataDir>/backups/state-v3-before-subjects-<时间戳>.sqlite`。v4 不能被旧网关打开（报 `schema_too_new`）。需要回退时：停掉新网关，把备份复制回 `state.sqlite`，再启动旧版本。
- 升级后，以前创建的非管理员只读密钥默认只能看到自己的数据。需要全局视角的，重新创建并指定 `data_scope: "owner"`。

## 10. 上线检查清单

- [ ] 从外网访问 `https://api.example.com/` 返回 404，`/health` 返回 200 且没有 `pid`。
- [ ] 从外网用 admin 密钥访问 `https://api.example.com/v1/agents`，返回 403 `admin_host_denied`。
- [ ] 用调用方密钥 A 创建一个运行，用密钥 B 读取它，返回 404 `run_not_found`。
- [ ] 用伪造的 Host（例如 `curl -H 'Host: evil.example.net'`）访问，返回 403 `invalid_host`。
- [ ] 至少一个远程 worker 已通过 WSS 接入，并成功完成一次运行。
- [ ] 数据目录已经有一份备份，并实际演练过一次恢复。
- [ ] 用官方 OpenAI SDK 对 `https://api.example.com/v1` 发一次非流式调用，确认结果正常；再调用一个不存在的智能体，确认 SDK 抛出的错误带有 `error.code`。
- [ ] 中途断开一个运行的事件流（例如 `GET /v1/responses/{id}?stream=true` 读到一半关闭），重新连接后能收到终态事件。

## 11. 已知限制（P0 范围外）

- 没有执行沙箱。原生智能体和宿主脚本以宿主机权限运行，这是 P1 要解决的。
- 单网关、SQLite，不能横向扩展，也没有故障切换，这是 P2。
- 每个密钥的 RPM 计数在进程内存里，重启后清零。
- 计费与自助注册只在配置 `platform` 后可用（见 [platform.md](platform.md)）。点数由运营者发放，没有支付渠道，也没有邮件：没有邮箱验证，密码由运营者重置。
