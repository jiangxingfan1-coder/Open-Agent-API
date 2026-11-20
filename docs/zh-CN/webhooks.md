# 运行事件回调（webhooks）

[English](../webhooks.md) · 简体中文

对智能体的一次调用是一个**运行**。运行可能跑很久，也可能中途停下来等人审批。没有回调时，调用方只能轮询或保持长连接，审批也只能在控制台或用 `oaa approve` 处理。事件回调把运行事件推送到你的 HTTPS 地址：长任务结束时主动通知你，需要审批时把请求推到聊天工具或你自己的系统里。

特性标记：`GET /health` 的 `webhooks-v1`。

## 目录

1. [谁能配置](#谁能配置)
2. [事件](#事件)
3. [载荷](#载荷)
4. [签名与请求头](#签名与请求头)
5. [投递](#投递)
6. [出站安全](#出站安全)
7. [接口](#接口)
8. [命令行与控制台](#命令行与控制台)
9. [走查：把审批接进你自己的系统](#走查把审批接进你自己的系统)
10. [限制与未覆盖的情况](#限制与未覆盖的情况)

## 谁能配置

只有 **owner 级管理员密钥**（`admin` 权限且 `agents` 含 `*`）。开发者平台的账号与普通调用方密钥不能配置回调，单次请求里也不能带回调地址：让调用方自选地址，等于让任何调用方都能指使网关向任意地址发请求（SSRF）。端点属于 owner，接收该 owner 全部运行的事件，不论运行由哪个密钥发起。

## 事件

每个事件对应内核状态机（`src/core/run-status.ts`）的一个运行状态，以及运行进入该状态时内核写入的运行事件（`src/core/events.ts`）：

| 回调事件 | 运行状态 | 内核事件 | 何时发出 |
| --- | --- | --- | --- |
| `run.requires_action` | `requires_action` | `run.requires_action` | 出现新的待处理项：审批，或需要调用方回传的工具结果（bridge）。每出现新的待处理项发一次；载荷列出此刻全部待处理项。 |
| `run.completed` | `completed` | `response.completed` | 运行正常结束。 |
| `run.failed` | `failed` | `response.failed` | 运行失败（含审批被拒或过期），原因见 `error.code`。 |
| `run.cancelled` | `cancelled` | `response.cancelled` | 运行被取消。 |
| `run.incomplete` | `incomplete` | `response.incomplete` | 运行在上限处停止：截止时间、轮次或预算。 |
| `run.interrupted` | `interrupted` | `run.interrupted` | 运行被中断，例如网关重启；可以用 `POST /v1/runs/{id}/resume` 恢复。 |

`run.incomplete` 是在最初的事件列表之外补上的：`incomplete` 同样是内核的终态，不发它的话，到达截止时间的任务会悄无声息地结束。

端点订阅一组事件（空表示全部六种），可以限定一组智能体（空表示全部）。每个运行的每种终态事件最多发一次；`run.interrupted` 每个运行也只发一次，即使恢复后再次被中断。

另有 `webhook.test`，只由 `POST /v1/webhooks/{id}/test` 发出。

## 载荷

请求体是 JSON：

```json
{
  "id": "evt_6c1f…",
  "type": "run.requires_action",
  "created_at": 1763101040,
  "data": {
    "object": "run",
    "run_id": "resp_c61d…",
    "agent": "agent/sample",
    "agent_version": "9f2c…（64 位十六进制）",
    "status": "requires_action",
    "error": null,
    "usage": null,
    "key_id": "key_…",
    "subject": "key:key_…",
    "created_at": 1763101039,
    "updated_at": 1763101040,
    "pending_actions": [
      {
        "id": "approval_a7b0…",
        "type": "native",
        "title": "Write outputs/sample-note.txt",
        "status": "pending",
        "expires_at": 1763101340
      }
    ]
  }
}
```

- `id` 是事件编号；同一事件发往多个端点时，它们拿到同一个 `id`。
- `created_at`、`data.created_at`、`data.updated_at`、`expires_at` 都是 Unix 秒。
- `data.error` 是 `{code, message}` 或 `null`；`data.usage` 是 `{input_tokens, output_tokens, total_tokens}` 或 `null`（未知）。
- `data.key_id` 与 `data.subject` 标明发起运行的密钥与调用方分区（`key:<编号>`，开发者平台账号是 `acct:<编号>`）。
- `pending_actions` 只出现在 `run.requires_action` 里。`type` 为 `tool`、`native`、`reconcile` 或 `client_tool`（需要调用方回传的工具结果）。`status` 是构造请求体时该项的状态（通常是 `pending`）。
- **默认不带任务输入与输出正文**（隐私与体积）。端点设了 `include_output: true` 时，运行事件里多一个 `data.output = {text, truncated, bytes}`：最终输出文本，最多 32 KiB（UTF-8）；被截断时 `truncated: true`，`bytes` 是完整大小。
- 需要更多信息时用运行编号去查：`GET /v1/runs/{id}`、`GET /v1/runs/{id}/output`、`GET /v1/runs/{id}/actions`。

请求体在第一次投递时构造，之后固定不变：重试发送的是同样的字节。

## 签名与请求头

每个请求都带：

| 请求头 | 值 |
| --- | --- |
| `X-OAA-Signature` | `t=<Unix 秒>,v1=<hex(HMAC-SHA256(secret, t + "." + 原始请求体))>` |
| `X-OAA-Event` | 事件类型，例如 `run.completed` |
| `X-OAA-Delivery` | 投递编号（`whd_…`）。重试和手动重发时不变，接收方据此去重。 |
| `User-Agent` | `OpenAgentAPI/<版本>` |
| `Content-Type` | `application/json` |

签名密钥（`whsec_…`）只在创建端点和轮换时返回。网关要用它签名，所以把它和端点一起存在自己的数据库里。

校验方法：取**原始**请求体（JSON 解析之前），用密钥对 `t + "." + 请求体` 计算 HMAC-SHA256，与 `v1` 做常量时间比较，并且**拒绝与本机时钟相差超过 5 分钟的 `t`**，防止截获的请求被事后重放。之后按 `X-OAA-Delivery` 去重。

Node：

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=').map((s) => s.trim())));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(/^[0-9a-f]{64}$/.test(parts.v1 ?? '') ? parts.v1 : '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Python：

```python
import hashlib, hmac, time

def verify(secret: str, header: str, raw_body: bytes, tolerance: int = 300) -> bool:
    parts = dict(p.strip().split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        return False
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

## 投递

- **至少一次。** 事件排在网关 SQLite 数据库的队列里（`webhook_deliveries`），重启后仍在；网关停下时没发完的，再启动后继续发。接收方可能收到同一投递不止一次，请按 `X-OAA-Delivery` 去重。
- 审批通知标记与各匹配端点的投递记录一起提交。写队列失败不会留下部分标记，再次收到同一通知时仍可入队。投递保证从**成功入队后**算起；源任务提交后、出站通知监听器运行前发生进程退出，并非所有事件都能自动补发。
- **成功**是 **10 秒**内（连接、发送与应答合计）返回任意 `2xx`。不跟随重定向，`3xx` 算失败。请先应答，再处理。
- **重试。** 失败后分别约在 5 秒、30 秒、2 分钟、10 分钟、30 分钟后重试（各带 ±20% 随机抖动），共 6 次。最后一次仍失败就记为 `failed` 并保留记录。已结束的投递可以用 `POST /v1/webhooks/{id}/deliveries/{delivery}/redeliver` 手动重新排队（投递编号不变，重试次数重新计）。
- **顺序。** 同一端点的投递一次一条、从旧到新，接收方按顺序收到该端点的事件；等待重试的投递会挡住同一端点后面的投递。不同端点互不等待。
- **不妨碍运行。** 入队是在运行状态落库之后的一次小插入，而且只在有匹配端点时才发生。发送在后台进行；接收方慢或不可达，不会拖慢或阻塞任何运行。
- **连续失败的端点**不会被自动删除或停用。端点的 `status` 会显示 `state: "failing"`、`consecutive_failures`、最近的错误与排队数。
- 停用的端点（`enabled: false`）不再收到新事件；已排队的投递等它重新启用后再发。删除端点会一并删除它排队中的投递。
- 每个端点保留最近 200 条已结束的投递。
- 每个端点最多排队 10,000 条投递。超过时（端点持续失败而事件还在不断产生），正在投递的那条之后最早排队的投递会被标为 `failed`（`queue_overflow`）并丢弃，坏掉的接收端不会让数据库无限增长。

## 出站安全

- 地址只能是 `http` 或 `https`，不能带用户名或密码。
- `http` 只接受回环地址（`127.0.0.0/8`、`::1`、`localhost`）。其它地址必须用 `https`，除非端点显式设置 `allow_insecure_http: true`。明文 http 下请求体与签名都不加密，途中可能被读取或篡改；只在你信任的网络里使用。
- `security.profile` 为 `"public"` 时（见 [security-model.md](security-model.md)），端点不能指向回环、私网（`10/8`、`172.16/12`、`192.168/16`、`fc00::/7`）、链路本地（`169.254/16`、`fe80::/10`，包括云元数据地址 `169.254.169.254`）、共享地址（`100.64/10`，包括 `100.100.100.200`）或「本网络」地址，除非端点显式设置 `allow_private_network: true`。保存端点时检查地址；**每次投递时，在这次连接自己的解析里**再检查主机名解析出的每个地址：被检查的地址就是被连接的地址。
- 默认的 `local` 档位不限制地址，本机 `127.0.0.1` 上的接收端开箱即用。
- **关于 DNS 重绑定，如实说明。** 检查发生在连接所用的那次解析里，所以保存时解析到公网、之后改解析到内网的域名，在投递时会被拒绝。没有覆盖的：回调不经过 HTTP 代理（代理会重新解析域名，检查就失效了）；攻击者如果控制着你放行的某个公网地址，当然仍能收到事件。`allow_private_network` 会让该端点完全跳过这项检查。

## 接口

全部要求 owner 级管理员密钥；其它密钥得到 403 `scope_denied`。

| 接口 | 请求体 / 结果 |
| --- | --- |
| `GET /v1/webhooks` | `{data: [endpoint]}` |
| `POST /v1/webhooks` | `{url, events?, agents?, include_output?, enabled?, description?, allow_insecure_http?, allow_private_network?}` → 201 endpoint，外加 `secret`（只在这里出现） |
| `GET /v1/webhooks/{id}` | endpoint |
| `PATCH /v1/webhooks/{id}` | `POST` 中的任意字段 → endpoint |
| `DELETE /v1/webhooks/{id}` | 204；排队中的投递一并删除，正在发送的那条被中止 |
| `POST /v1/webhooks/{id}/rotate-secret` | `{id, secret}`；旧密钥立即失效 |
| `POST /v1/webhooks/{id}/test` | 202 delivery；排入一条 `webhook.test` 事件 |
| `GET /v1/webhooks/{id}/deliveries?limit=20` | `{data: [delivery]}`，新的在前（最多 200） |
| `POST /v1/webhooks/{id}/deliveries/{delivery}/redeliver` | 202 delivery；还在排队时 409 `webhook_delivery_pending` |

**endpoint** 为 `{object: "webhook_endpoint", id, url, events, agents, include_output, enabled, description, allow_insecure_http, allow_private_network, created_at, updated_at, status}`，其中 `status = {state: "ok" | "failing" | "disabled", consecutive_failures, last_success_at, last_failure_at, last_error, pending, latest_delivery}`。时间是 Unix 毫秒，与其它管理接口一致。

**delivery** 为 `{object: "webhook_delivery", id, endpoint_id, event_id, event_type, run_id, status: "pending" | "succeeded" | "failed", attempts, next_attempt_at, http_status, duration_ms, last_error, created_at, updated_at}`。

`events` 只接受上面六种运行事件。每个 owner 最多 20 个端点（409 `webhook_limit_reached`）。错误码：`webhook_not_found`、`webhook_url_invalid`、`webhook_target_denied`、`webhook_limit_reached`、`webhook_delivery_not_found`、`webhook_delivery_pending`（见 [protocol.md](protocol.md#事件回调错误)）。

## 命令行与控制台

```
oaa webhook add URL [--event EVENT]... [--agent AGENT]... [--include-output] [--out SECRET_FILE]
oaa webhook list
oaa webhook remove ID
oaa webhook test ID
oaa webhook deliveries ID [--limit 20]
```

都支持 `--json`，以及和其它命令一样的 `--url` / `--token-file` / `--dir`（见 [cli.md](../cli.md)）。`add` 把签名密钥打印一次；带 `--out FILE` 时改为写入一个新的私有文件（权限 0600）。`test` 最多等 15 秒看第一次投递的结果，失败时退出码为 1。修改端点（启用、停用、过滤条件）与轮换密钥走接口。

控制台「调用地址」页有一个只读的「事件回调」小节，列出端点、状态与最近一次投递。

## 走查：把审批接进你自己的系统

[`examples/webhook-receiver.mjs`](../../examples/webhook-receiver.mjs) 是一个最小的接收端（只用 Node 内置模块）。它校验签名、忽略重复投递、打印每个事件，收到 `run.requires_action` 时列出待处理项；带 `--auto-approve` 时还会用管理员密钥调用 `POST /v1/runs/{id}/actions/{action}` 批准，不带时只打印。换成你自己的逻辑即可：发到聊天工具、开工单、在按钮上批准。

下面全程离线、零成本，用的是随附的示例智能体：任务里带「approve」时它会请求一次审批。

1. 启动带示例智能体的本机网关（监听 `127.0.0.1:8787`）：

   ```bash
   oaa quickstart
   ```

2. 为接收端添加端点，把签名密钥存进私有文件：

   ```bash
   oaa webhook add http://127.0.0.1:8790/ --event run.requires_action \
     --event run.completed --event run.failed --out .oaa/webhook.secret
   ```

3. 在第二个终端启动接收端：

   ```bash
   node examples/webhook-receiver.mjs --secret-file .oaa/webhook.secret \
     --token-file .oaa/admin.token --auto-approve
   ```

4. 发起一个需要审批的任务，然后等它结束：

   ```bash
   oaa invoke agent/sample --input "please approve writing the note" --token-file .oaa/admin.token
   oaa wait RESPONSE_ID --token-file .oaa/admin.token
   ```

接收端的输出（编号已缩短；中文系统下提示语为中文）：

```text
接收端已就绪：http://127.0.0.1:8790/
run.requires_action  resp_c61d…  agent/sample  requires_action
  待处理 approval_a7b0…  native  Write outputs/sample-note.txt  到期 2026-11-14T05:17:20.000Z
  已批准 approval_a7b0…
run.completed  resp_c61d…  agent/sample  completed
```

不带 `--auto-approve` 时，事件下面第二行是「未批准（加 --auto-approve 才会批准）」，运行继续等待；可以用 `oaa approve RESPONSE_ID` 或在控制台批准。`oaa webhook deliveries ID` 能看到两条 HTTP 状态为 204 的投递。`test/webhook-receiver-example.test.ts` 会跑一遍同样的流程。

示例接收端用**管理员密钥**批准；在你自己的系统里，只把密钥交给负责做决定的那个组件，而不是每个接收端，并且尽量用只带 `approve` 权限、只授权相关智能体的密钥。

## 限制与未覆盖的情况

- 每个 owner 的端点数：20。每个端点保留的已结束投递：200。`include_output` 携带的输出：32 KiB。每次尝试的超时：10 秒。尝试次数：6。
- 只有 owner 级管理员密钥能配置回调；没有按账号或按请求的回调。
- HTTPS 端点按 Node.js 信任的证书颁发机构校验证书。自动化测试只用本机明文 http 接收端；投递到真实公网 HTTPS 端点走同一段代码，但不在测试覆盖之内。
- 网关关机或重启时被中断的运行，其 `run.interrupted` 在关机时或下次启动时（本进程启动以来被中断的运行）入队，只发一次。
- 不支持多个网关进程共用一个数据目录（网关的其它部分同样不支持）；那样每个进程都会发送队列。
