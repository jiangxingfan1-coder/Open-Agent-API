# 开发者平台

[English](../platform.md) · 简体中文

> 适用范围：0.4.0 新增的开发者平台；0.5.0 在此基础上增补了任务记录、试用台、充值专用密钥、重置码与启动对账；0.6.0 修正了中断与恢复时的计费、密钥并发与事件流细节，见「计费规则」与「限制」。只在配置了 `platform` 段时启用。未启用时，本文描述的路由、数据表和页面都不存在，网关的输出与之前相同。
>
> 本文只描述功能、配置和接口，不包含部署步骤。域名、反向代理与证书见 [deploy-public.md](deploy-public.md)。文中的域名（`api.example.com`、`console.example.com`）、管理员密钥路径，以及所有密钥和密码，都是占位符。

## 定位

开发者平台让 Open Agent API 可以交给开发者自助使用：开发者自己注册、自己建密钥、看得到有哪些智能体可以调用，并按用量结算。运营者在控制台上架智能体、定价、发放点数、管理账号。

这一功能借用的是模型中转平台的平台形态（账号、密钥、额度、用量、后台），不借用它们的供给方式。下表只陈述两类产品的差异，不评价任何具体项目。

| | 模型中转平台 | Open Agent API |
| --- | --- | --- |
| 分发的东西 | 模型的推理额度 | 智能体：自带工具、技能、模型线路与权限的完整执行单元 |
| `model` 字段填什么 | 模型名 | 智能体的调用名（如 `agent/research`） |
| 一次调用是什么 | 一次模型补全 | 一个任务：多轮工具循环、审批、检查点、可恢复、有产物 |
| 供给从哪来 | 上游账号 / 订阅池 | 发布者自己的执行机器（主动外连网关），或发布者用 OAA-Lang 定义的智能体 |
| 计价单位 | token | 按次（一个任务）加可选的按 token |
| 目录里列什么 | 模型列表 | 智能体：能做什么、带哪些工具、可用哪些模型线路、调用方工具怎么处理 |
| 凭据 | 汇集的订阅登录态 | 发布者的 API key 或调用方自带密钥（BYOK）；不做订阅池，不中转登录态 |

本产品不做订阅池，也不中转登录态。智能体的执行机器由发布者自己提供，凭据是发布者自己的 API key，或调用方自带的密钥（BYOK，见 [protocol.md「调用方自带模型密钥」](protocol.md#调用方自带模型密钥byokp1)）。

开发者平台是可选功能，默认关闭。平台内的点数只是记账单位，不接支付，见下文 [限制](#限制)。

## 概念

| 概念 | 含义 |
| --- | --- |
| 账号 | 开发者在门户注册（或由运营者创建）的身份，有邮箱、名称、状态和点数余额。邮箱在同一 owner 内唯一，大小写不敏感。 |
| 门户会话 | 账号登录后得到的令牌，形如 `oas_…`，只用于 `/v1/portal/*`。 |
| 账号密钥 | 账号在门户里创建的调用密钥，形如 `sk-oaa-…`（旧的 `oaa_` 开头的密钥继续有效），只用于调用接口，不能访问门户接口。同一账号的多把密钥共享运行、文件与记忆；不同账号之间互相隔离。 |
| 上架 | 运营者把 owner 名下已发布的智能体放进平台目录，设置标题、简介、标签、价格和是否启用。未上架或已停用的智能体，账号密钥看不到，也调不了。 |
| 点数 | 中性的记账单位，1 点 = 1,000,000 微点。由运营者通过兑换码或手动调整发放，不对应任何货币。 |
| 流水 | 余额的每一次变动记一行，类型为 `run`（运行）、`redeem`（兑换）、`grant`（赠送）或 `adjust`（运营者调整）。 |
| 兑换码 | `credit` 类型是点数码，开发者兑换后入账；`invite` 类型是邀请码，注册时使用。码的明文只在生成时返回一次，数据库里只存散列。 |
| 任务记录 | 账号发起的每个任务的记录，在门户「任务」页查看：状态、用量、费用、输出，以及这个任务的执行过程（`timeline`）。 |
| 试用台 | 门户里的「试用」页：选一个已上架的智能体，填入自己的账号密钥，直接在浏览器里调用。试用同样计费。 |
| 充值专用密钥（`billing`） | 权限为 `billing` 的密钥，只能给账号加点数（`credit`）和按邮箱查找账号，供运营者的支付回调使用。除此之外没有其它权限。 |
| 重置码 | 运营者为某个账号生成的一次性密码重置码，24 小时有效。开发者用它在门户里自己设置新密码，运营者不会知道这个密码。 |

流水的 `note` 取值如下：`redeem` 行是 `code <码ID>`（兑换）或 `invite <码ID>`（邀请码注册）；`grant` 行是 `signup`（注册赠送，由 `signupCredits` 配置）或 `operator`（运营者建账号时给的点数）；`adjust` 行是运营者填写的备注；`run` 行没有备注。带外部单号的入账，单号记在流水行的 `reference` 字段里，不写进 `note`，见下文「接入你自己的支付」。

## 启用

### 在控制台里启用（推荐）

打开控制台「接入」分组下的「开发者平台」页，未启用时页面上有「启用」按钮：填站点名、注册方式（`closed` / `invite` / `open`）与新账号赠送的点数，保存即可。设置保存在网关自己的数据库里（`gateway_platform_setup` 表，第一次保存时才建），**不改写 `config.json`**；**重启网关（后台服务）后生效**——网关开始监听后不能再增加路由，所以不在运行中热启用。启用后智能体归属的 `owner` 是保存时所用密钥的 owner；其余字段（`maxKeysPerAccount`、`keyQuota`、`keyExecution`、`sessionTtlHours`）取下表的默认值。

- 修改设置：在同一页改完再保存，同样重启后生效。
- 停用：只关掉开关，重启后平台关闭；已保存的设置与平台的全部数据（账号、流水、上架、兑换码）都保留，再次启用时还在。
- 需要 owner 级管理员密钥（`admin` 权限、`agents` 为 `*`），只在控制台域名上可用，与[运营者接口](#运营者owner-级管理员密钥只在控制台域名上可用)同一档；**设置归首次启用它的 owner**：保存过之后（停用后也一样）只有这个 owner 的管理员能查看和修改，其它 owner 得到 403 `scope_denied`，owner 不随后续保存改变；配置文件管理时只有 `platform.owner` 能查看。修改时没填的字段保持已保存的值。每次保存写一条审计记录（`platform_setup`）。接口是 `GET/PUT /v1/platform/setup`，平台未启用时也可用，`/health` 的 `features` 里有 `platform-setup-v1`。

### 用配置文件启用

配置文件的方式仍然可用，并且**优先**：`config.json` 里写了 `platform` 段时，以配置文件为准，控制台里的设置只读（`PUT /v1/platform/setup` 返回 409 `platform_managed_by_config`）。要改回界面管理，删掉这一段后重启。

在 `config.json` 的顶层增加 `platform` 段（与 [deploy-public.md 第 4 节](deploy-public.md#4-网关配置) 的字段同级）：

```json
{
  "platform": {
    "owner": "owner",
    "siteName": "Open Agent API",
    "registration": "closed",
    "signupCredits": 0,
    "maxKeysPerAccount": 10,
    "keyQuota": { "rpm": 60, "maxConcurrentRuns": 2 },
    "keyExecution": "workspace",
    "sessionTtlHours": 720
  }
}
```

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `owner` | 把哪个 owner 名下已上架的智能体提供给开发者。必填 | — |
| `siteName` | 门户显示的站点名 | `Open Agent API` |
| `registration` | `closed` 只能由运营者建账号；`invite` 注册必须带邀请码；`open` 任何人可注册 | `closed` |
| `signupCredits` | 新账号赠送的点数 | `0` |
| `maxKeysPerAccount` | 每个账号最多几把未删除的密钥 | `10` |
| `keyQuota` | 账号密钥的配额，格式与 `POST /v1/keys` 的 `quota` 相同 | `rpm` 60、`maxConcurrentRuns` 2 |
| `keyExecution` | 账号密钥的执行等级，只能是 `workspace` 或 `sandbox`，不接受 `host`（写成 `host` 会通不过配置校验） | `workspace` |
| `sessionTtlHours` | 门户登录会话的有效期，单位小时 | `720` |

### 启用后的变化

- `/health` 的 `features` 多一项 `platform-v1`。
- 数据：在同一个数据库里建以 `platform_` 开头的表，共 8 张：0.4.0 的 6 张（`platform_accounts`、`platform_sessions`、`platform_listings`、`platform_codes`、`platform_code_uses`（记录哪个账号用过哪张码）、`platform_ledger`），加上 0.5.0 新增的 2 张（`platform_references`，记录运营者的外部单号，用于入账去重；`platform_reset_codes`，保存重置码的散列，每个账号最多一张有效码）。用 `CREATE TABLE IF NOT EXISTS` 在启用时建立。`runs` 等既有表的结构不变，`SCHEMA_VERSION` 仍为 4。旧版网关打开这个库时会忽略这些表。
- 路由：`/v1/portal/*`（门户与开发者接口）和 `/v1/platform/*`（运营者接口），见 [接口一览](#接口一览)。`GET /openapi.json` 在启用平台时才包含这两组路由（`/v1/platform/setup` 始终包含）。
- 页面：`/portal/` 是开发者门户，任何允许的 Host 都能访问。配置了 `consoleHosts` 时，非控制台域名上的 `/` 跳转到 `/portal/`。
- 控制台：「接入」分组下的「开发者平台」页（`#platform`）。未启用时，这一页只显示启用说明。

### 不启用时

不建表，不注册路由，`/health` 的 `features` 没有 `platform-v1`。下面的 `/v1/portal/*` 与 `/v1/platform/*` 路由都返回 404 `route_not_found`；唯一的例外是 `GET/PUT /v1/platform/setup`（用于在控制台里启用）。从没在控制台里保存过设置的网关，数据库里也没有 `gateway_platform_setup` 表。

## 运营者怎么做

运营者有两个入口：控制台的「开发者平台」页（分为「概况与用量」「上架与定价」「开发者」「兑换码」四个标签），以及 `/v1/platform/*` 接口。接口要求 owner 级管理员密钥：带 `admin` 权限、`agents` 为 `*`，且密钥的 owner 等于 `platform.owner`。只被授权了部分智能体的 admin 密钥会得到 403 `scope_denied`。和其它管理接口一样，只能在 `consoleHosts` 配置的控制台域名上使用。唯一的例外是带 `billing` 权限的充值专用密钥，见下文「接入你自己的支付」。下面的示例沿用 [deploy-public.md 第 7 节](deploy-public.md#7-分发调用方密钥) 的写法。

### 上架智能体并定价

上架的智能体必须已经由 `platform.owner` 发布。上架之后，开发者的账号密钥才能看到并调用它。

```bash
curl -s -X PUT https://console.example.com/v1/platform/listings \
  -H "Authorization: Bearer $(cat /srv/oaa/data/admin.token)" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"agent/research","title":"研究助手","summary":"阅读资料并给出分析。","tags":["研究"],"price":{"per_run":2,"per_1k_tokens":0.5},"enabled":true}'
```

上例中的价格只是格式示例，不代表推荐价格。

- `PUT` 有则改、无则建。除 `agent_id` 外的字段都可以省略。智能体不存在时返回 404 `agent_not_found`。
- `price.per_run` 是每个任务的点数，`price.per_1k_tokens` 是每 1000 个 token 的点数，两者都可以为 0，范围是 0 到 1000 点。新建上架记录时 `enabled` 默认为 `true`，标题默认为智能体 ID，价格默认为 0。
- 改价只影响之后提交的任务，进行中的任务按开始时的价格结算（见 [计费规则](#计费规则)）。
- `enabled: false` 保留记录但下架；`DELETE /v1/platform/listings?agent_id=` 移除记录。上架状态的变化立即生效。

### 发放点数

有三种方式：

1. **兑换码**。批量生成后发给开发者，开发者在门户或 `POST /v1/portal/redeem` 中兑换。

    ```bash
    curl -s https://console.example.com/v1/platform/codes \
      -H "Authorization: Bearer $(cat /srv/oaa/data/admin.token)" \
      -H 'Content-Type: application/json' \
      -d '{"kind":"credit","credits":10,"max_uses":1,"count":5,"note":"首批开发者"}'
    ```

    `count` 取 1 到 100；`max_uses` 是每张码的可用次数，默认 1，范围 1 到 1,000,000；`credit` 类型的 `credits` 必须大于 0；`expires_at`（毫秒时间戳）可选，填写时必须是将来的时间。返回的每一项都带有 `code` 明文，只显示这一次，可以整批复制。作废用 `DELETE /v1/platform/codes/:id`。

    兑换码输入不区分大小写，首尾空格会被忽略。`invite` 类型的邀请码可以带 `credits`，注册成功时入账，流水类型为 `redeem`。

2. **直接调整余额**。`POST /v1/platform/accounts/:id/credit`，请求体 `{amount, note}`，`amount` 可正可负，但不能为 0。调整后的余额小于 0 时返回 402 `insufficient_balance`，不做任何改动。`note` 最多 200 个字符。需要按外部单号防重（例如支付回调）时，请求体带上 `reference`，支付回调的做法见下文「接入你自己的支付」。
3. **新账号赠送**。由 `platform.signupCredits` 配置，或在运营者创建账号时通过 `credits` 指定。

### 接入你自己的支付

平台不接支付渠道。支付由你自己接，平台提供接入需要的两样东西：

1. 一把只能加点数的 `billing` 密钥。
2. 按外部单号去重的入账：同一个 `reference` 只会入账一次。

**建这把密钥。** 在控制台「API 密钥」里勾选「充值（billing）」并创建；或者用 `platform.owner` 的管理员密钥调用 `POST /v1/keys`，`scopes` 含 `billing`。这把密钥的 owner 必须等于 `platform.owner`，否则不生效。

```bash
curl -s https://console.example.com/v1/keys \
  -H "Authorization: Bearer $(cat /srv/oaa/data/admin.token)" \
  -H 'Content-Type: application/json' \
  -d '{"name":"支付回调","agents":["agent/research"],"scopes":["billing"]}'
```

现有的密钥校验要求 `agents` 与 `scopes` 都至少有一项，所以示例里仍带着 `agent/research`。它只是占位，这把密钥并不因此获得调用权限：`billing` 密钥只有这一项权限（没有 `invoke`），不能调用智能体。返回的 `token` 只显示这一次，请保存到支付回调服务的环境变量里，下文记为 `$OAA_BILLING_KEY`。

**它能做什么，不能做什么。**

- 能做：`POST /v1/platform/accounts/:id/credit` 给账号加点数，`amount` 必须大于 0；`GET /v1/platform/accounts?query=` 按邮箱找账号。
- 不能做：扣减（扣减仍要 owner 级管理员密钥）；`amount` 小于 0 的入账（403 `scope_denied`）；列出或新建密钥；停用账号、重置密码、查看流水等其它运营操作（同样是 403 `scope_denied`）；调用智能体。
- 它不是 `admin` 密钥，所以不受 `consoleHosts` 限制，可以在 API 域名上使用。支付回调通常跑在服务器上，这一点正好用得上。

**回调里怎么做。** 先用邮箱找到账号：

```bash
curl -s "https://api.example.com/v1/platform/accounts?query=dev@example.com" \
  -H "Authorization: Bearer $OAA_BILLING_KEY"
```

从返回的 `data` 里选出邮箱一致的账号，取它的 `id`（下文记为 `$ACCOUNT_ID`），然后入账。`reference` 填你们自己的外部单号（1 到 200 个字符）。示例金额只是格式，点数与实际收款之间的换算由你决定。

```bash
curl -s "https://api.example.com/v1/platform/accounts/$ACCOUNT_ID/credit" \
  -H "Authorization: Bearer $OAA_BILLING_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"amount":10,"note":"支付回调","reference":"PAY-20261112-000123"}'
```

**重复提交与冲突。**

- 第一次提交：入账，返回 `{account, entry}`，并写入审计 `platform_credit_adjusted`。
- 同一个 `reference` 再次提交：不再入账，直接返回第一次的 `{account, entry}`，多一个字段 `duplicate: true`，也不再写审计。所以支付渠道重复回调不会重复加点。
- 同一个 `reference` 但 `amount` 与第一次不同，或者用于另一个账号：返回 409 `reference_conflict`，需要人工核对单号。
- 单号与入账在同一个事务里写入，记在 `platform_references` 表里（字段为 owner、单号和流水行 ID）。

**注意。** 回调要先验证支付渠道的签名，再调用 `credit`；平台不接支付，也不替你验签。`$OAA_BILLING_KEY` 只放在回调服务的环境变量里，不要放进前端，也不要分享给别人。

### 管理账号

- 创建：`POST /v1/platform/accounts`，请求体 `{email, password, name?, credits?}`，不受 `registration` 限制。
- 查找：`GET /v1/platform/accounts?query=&limit=&cursor=`，返回每个账号的余额、密钥数、任务数、累计消耗和最近活动。
- 停用或启用：`POST /v1/platform/accounts/:id/status`，请求体 `{status}`，取值 `active` 或 `disabled`。停用后，该账号的会话全部作废，它的密钥在下一次鉴权时被拒绝（`account_disabled`，403）。
- 重置密码有两种做法：
  - **生成一次性重置码（推荐）**：`POST /v1/platform/accounts/:id/reset-code`，不需要请求体，返回 201 `{code, expires_at}`。明文只返回这一次，24 小时内有效；再次生成会使旧码失效。把码经其它渠道交给开发者，由他在门户里自己设置新密码（见「开发者怎么做」中的[忘记密码](#忘记密码)）。运营者因此不会知道开发者的密码。码用掉后，该账号的全部会话作废。
  - **直接设置新密码**：`POST /v1/platform/accounts/:id/password`，请求体 `{new_password}`。该账号的会话全部作废。运营者会知道这个新密码。
- 流水与用量：`GET /v1/platform/accounts/:id/ledger`、`GET /v1/platform/usage?days=30`；概况见 `GET /v1/platform/summary`。控制台平台页的「概况与用量」标签里有用量区块，按天、按智能体、按账号查看；`by_account` 最多返回消耗最高的 50 个账号。
- 审计：调整余额、停用或启用账号、重置密码（包括生成重置码）都会写入审计记录。管理员密钥在控制台域名上可以通过 `GET /v1/audit` 查看，见 [protocol.md「审计记录」](protocol.md#审计记录p1)。平台的审计码是 `platform_credit_adjusted`、`platform_account_status`、`platform_password_reset`（生成重置码时，说明为 `reset_code`），记录带 `account_id` 与一句说明（如 `amount=3 balance_after=3`、`status=disabled`），不含密码、备注原文与兑换码，见 [protocol.md「开发者平台」一章](protocol.md#开发者平台)。

## 开发者怎么做

开发者可以在门户 `https://api.example.com/portal/` 完成注册、兑换、建密钥和查看用量，门户默认中文，可切换英文。也可以直接调用 `/v1/portal/*` 接口，下面用 `curl` 给出接口写法。

### 注册与登录

注册方式取决于 `registration`：

- `closed`：返回 403 `registration_closed`，需要联系运营者建账号。
- `invite`：必须带 `invite_code`。缺少时返回 403 `invite_required`；码无效、已用完或已过期时返回 400 `invalid_code`。
- `open`：任何人都可以注册。

```bash
curl -s https://api.example.com/v1/portal/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","password":"你自己的密码（8 到 200 位）"}'
```

注册成功返回 201，响应为 `{ account, session }`。`session.token` 形如 `oas_…`，之后放在 `Authorization: Bearer` 头里，它只能用于 `/v1/portal/*`。已注册的账号用 `POST /v1/portal/login`（请求体 `{email, password}`）登录。邮箱不存在与密码错误统一返回 401 `invalid_credentials`。会话有效期由 `sessionTtlHours` 决定，默认 720 小时。

平台没有邮件，因此没有邮箱验证，也没有邮件找回密码。忘记密码见下文「忘记密码」。

### 兑换点数

```bash
curl -s https://api.example.com/v1/portal/redeem \
  -H "Authorization: Bearer $OAS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"code":"运营者发放的兑换码"}'
```

返回 `{ account, credited }`。同一账号不能重复使用同一张码。

### 创建账号密钥

```bash
curl -s https://api.example.com/v1/portal/keys \
  -H "Authorization: Bearer $OAS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"我的应用"}'
```

返回 201，其中的 `token` 形如 `sk-oaa-…`（`sk-oaa-` 加 48 位字母数字），只显示这一次；旧的 `oaa_` 开头的密钥继续有效。未删除的密钥达到 `maxKeysPerAccount` 时返回 409 `key_limit_reached`。删除用 `DELETE /v1/portal/keys/:id`：密钥立即失效，并且不再出现在密钥列表里。

账号密钥的权限是固定的：`scopes` 为 `invoke`、`read`、`files`，没有 `approve` 和 `admin`。它能看到和调用的智能体，是 owner 名下上架且启用的智能体。执行等级和配额取自 `platform` 配置。同一账号的几把密钥共享运行与文件。

### 查看可调用的智能体

- `GET /v1/portal/agents`：上架且启用的智能体列表。
- `GET /v1/portal/agent?id=agent/research`：单个智能体的详情，包括说明、价格、可选的模型线路（`models`）和接入画像（`conversion`）。未上架时返回 404 `agent_not_found`。
- `GET /v1/me`（用账号密钥调用）：响应中多一个字段 `account: { id, balance }`，可以查看余额。

### 调用

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="https://api.example.com/v1",
    api_key=os.environ["OAA_API_KEY"],  # 账号密钥，形如 sk-oaa-…
)

response = client.responses.create(
    model="agent/research",  # 智能体的调用名
    input="分析这些资料。",
    metadata={"oaa.model": "auto"},  # 可选：模型线路，取值来自该智能体的 models
)
```

- 账号密钥可以用 OpenAI Responses、Chat Completions 与 Claude Messages 等任一兼容入口调用，流式同样可用。
- `model` 填的是智能体的调用名，不是模型名。
- 智能体收费时（两个价格不全为 0），余额不足会返回 402 `insufficient_balance`，任务不会被创建。
- 长任务可以加 `background=True`，之后用 `client.responses.retrieve(response.id)` 查询，写法与 [README 的三分钟跑起来](../../README.zh-CN.md#三分钟跑起来) 相同。
- 非流式调用在任务已经创建、但没有正常结束（失败、取消、中断或待审批）时，Chat Completions、Claude Messages 与 Gemini 返回 422，并带 `x-should-retry: false`，官方 SDK 不会因此自动重试（不会重复提交）。Responses 照常返回带 `status` 的响应对象。各入口的错误形状、重试头与截断时的结束原因，见 [protocol.md「兼容入口的参数、错误与结束原因」](protocol.md#兼容入口的参数错误与结束原因060)。

### 查看任务的过程

门户的「任务」页列出你账号发起的任务，新的在前，可以按智能体过滤，并翻页。点进去是任务详情：状态、起止时间、用量、费用、输出，以及这个任务的执行过程。对应的接口是：

- `GET /v1/portal/runs?limit=20&cursor=&agent=`：返回 `{ data: RunItem[], next_cursor }`。`limit` 取 1 到 200，默认 20；`agent` 可选，按智能体过滤；`next_cursor` 是下一页的游标（数字），没有更多时为 `null`。
- `GET /v1/portal/runs/:id`：返回 `RunDetail`。不是你账号的任务，或任务不存在，都返回 404 `run_not_found`。

```bash
curl -s "https://api.example.com/v1/portal/runs?limit=20" \
  -H "Authorization: Bearer $OAS_TOKEN"
```

详情里的 `timeline` 就是这个任务的执行过程，与 `GET /v1/runs/:id/timeline` 的响应相同。它按段列出排队、模型调用、工具调用、审批等，每一段都有类别、名称、状态，以及相对任务开始时间的起止毫秒数。类别（`kind`）共 8 种：`queue`（排队）、`model`（模型调用）、`tool`（工具调用）、`approval`（审批）、`client_tool`（等调用方执行工具）、`subagent`（子智能体）、`interrupted`（中断）、`native`（原生智能体的运行）。

- `status` 在任务进行中为 `in_progress`，结束后与流水行的状态一致，即运行的最终状态。
- `created_at` 是任务登记的时间，与流水行相同。`completed_at` 是任务结束的时间，进行中为 `null`。
- `charge` 是这个任务已收的点数（正数）。`price` 是任务开始时记下的价格。
- `usage` 是这个任务的用量对象，可能为 `null`；`error` 是 `{code, message}` 或 `null`。
- `output_text` 是各段输出（以空行相接）的文本，超过 200,000 个字符时截断，末尾加省略号（`…`）。
- 如果运行的详细记录已被清理，但流水里还有这一行，详情仍返回流水里有的字段，`timeline`、`usage`、`error` 与 `completed_at` 为 `null`，`output_text` 为空串。

### 在浏览器里试用

门户的「试用」页可以直接在浏览器里调用一个已上架的智能体：选智能体，可选模型线路，填入你自己的一把账号密钥（`sk-oaa-…`），输入任务。输出以流式逐步显示，结束后页面给出这个任务的记录页链接。

- 页面直接调用 `POST /v1/chat/completions`（`stream: true`），模型线路经 `metadata` 的 `oaa.model` 传递。它不需要额外的后端接口。
- 密钥只留在页面内存里，不写入 `localStorage`，离开页面即丢弃。
- 试用同样计费，与正常调用的价格规则相同。
- 试用台适合试一试。正式使用时，请在你自己的服务器上调用 API，不要把密钥放进浏览器页面。

### 用量、流水与密码

- `GET /v1/portal/usage?days=30`：余额，以及近 `days` 天（1 到 90）的合计、按天和按智能体的用量。`totals` 只统计这 `days` 天之内的数据；全部时间的累计见运营者接口 `GET /v1/platform/summary`，以及 `AdminAccount` 的 `runs`、`spent`。
- `GET /v1/portal/ledger?limit=50&cursor=`：流水，新的在前。返回的 `next_cursor` 用于翻页。
- `POST /v1/portal/account/password`，请求体 `{current_password, new_password}`，返回 204。改密码后，该账号的全部会话（包括当前会话）都会失效，需要重新登录。当前密码填错时返回 401 `invalid_credentials`，会话不受影响。
- `POST /v1/portal/logout`，返回 204。

### 忘记密码

平台没有邮件，所以没有通过邮箱自助找回。忘记密码时，先向运营者索取一个一次性重置码，然后二选一：

1. 在门户登录页点「忘记密码？」，进入「用重置码设置新密码」页。
2. 调用 `POST /v1/portal/password-reset`：

```bash
curl -s https://api.example.com/v1/portal/password-reset \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","code":"运营者给你的重置码","new_password":"你自己的新密码"}'
```

返回 204。重置码是 20 个字符，24 小时内有效，只能用一次；运营者重新生成后，旧码失效。新密码为 8 到 200 位。用掉后，这个账号的全部会话都会作废，需要重新登录。码错误、已过期、已用过，或邮箱不存在，都返回 400 `invalid_code`，接口不会泄露邮箱是否存在。这个接口按来源 IP 与邮箱限流，数值与登录相同（每个来源 IP 每 10 分钟 30 次，每个邮箱每 10 分钟 10 次），但计数与登录分开；超限返回 429 `rate_limited`。已登录时修改密码，用 `POST /v1/portal/account/password`，见上文。

## 计费规则

计费以点数记账。一个运行对应一个任务，规则如下：

1. **价格**：每个上架智能体有两个价格，`per_run`（每个任务多少点）和 `per_1k_tokens`（每 1000 个 token 多少点），两者都可以为 0。
2. **计费对象**：只对账号密钥发起的根运行计费。运营者自己的密钥发起的运行不计费。一个运行就是一个任务：用 `previous_response_id` 续接对话时，每次续接都是一次新的调用，按一个新任务计费。调用方工具桥接（任务停下来等调用方执行工具、回传后继续）是同一个运行，只计一次。委托产生的子运行不单独计费，但它们用掉的 token 已并入父运行的用量，所以按 token 计价的部分包含子运行。
3. **提交时检查**：智能体不是免费的（两个价格不全为 0），并且余额小于 `per_run` 或余额小于等于 0 时，拒绝提交，返回 402 `insufficient_balance`，不创建运行。两个价格都为 0 的免费智能体，余额为 0 也可以调用。
4. **开始时登记**：运行开始时，在流水里登记一行 `kind: run`，记下当时的价格。之后改价不影响进行中的任务。这一行在运行进行中时 `status` 为 `in_progress`、`amount` 为 0；结束后 `status` 变为运行状态（`completed`、`failed`、`cancelled`、`interrupted` 或 `incomplete`），`amount` 变为实际金额。
5. **结束时结算**：`completed` 的运行收取 `per_run + per_1k_tokens × total_tokens / 1000`。失败、取消、中断等其它终态只收取 token 部分，不收每次的费用。中断的运行按中断时已用的 token 结算：网关正常关闭时即时结算；网关崩溃留下的进行中行，由下次启动时的对账结算（第 11 条）。金额向上取整到微点。
6. **幂等**：一个运行只对应一行流水。同一运行被多次收尾时（例如中断后恢复、再次完成），按新旧应收金额之差调整余额，不会重复扣费。账号密钥的 token 用量（`PortalKey.usage.used_tokens`）同样只累加差额；升级前已经多记的历史数据不回改。
7. **透支**：token 数在任务结束前无法预知，结算后余额可能短暂变为负数。下一次提交会被第 3 条拒绝。并发上限（`keyQuota.maxConcurrentRuns`、`maxActiveRunsPerSubject`）限制了最坏情况下的透支。
8. **外部智能体可能不报告 token**：`total_tokens` 为 0 或缺失时，只有按次价格生效。token 数不是费用估算，本文不把它当作费用来宣传。
9. **金额精度**：内部以整数微点存储与计算（1 点 = 1,000,000 微点）。接口上的金额以「点」为单位，最多 6 位小数。
10. **不变量**：任一账号的余额恒等于它全部流水 `amount` 之和。
11. **启动对账**：网关启动后（不阻塞启动），核对流水里仍为 `in_progress` 的行。运行已经结束的（包括仍在库里的已中断运行），按第 5 条的终态规则结算，中断的按它已用的 token 结算；运行记录已不存在的，把这一行记为 `interrupted`，按 0 个 token 结算，因此金额为 0（用量已无从得知）；运行仍在排队或等待的不动。对账是幂等的，重复执行不改变结果。
12. **恢复**：恢复一个已中断的运行（`POST /v1/runs/{id}/resume`）前，按提交时的规则重新检查：运行所属的密钥是否仍有效（过期或已删除时拒绝；管理员代为恢复别人的运行时，原密钥失效返回 409 `run_key_inactive`）、账号是否启用（停用返回 403 `account_disabled`）、智能体是否仍对这把密钥可用（上架被下架返回 403 `scope_denied`）、收费智能体的余额（不足返回 402 `insufficient_balance`），以及密钥的并发、token 与运行次数配额。任何一项不通过，运行保持中断，不写入任何东西。通过后，这一行改回 `in_progress`，完成后按差额补结。恢复的运行与网关启动后重新入队的运行，都重新计入所属密钥的并发上限，但不增加运行次数。

## 接口一览

约定：

- 错误响应沿用 `{ "error": { "code", "message", "type" } }`，错误码见 [错误码](#错误码)。
- 金额字段的单位都是「点」。
- 时间都是毫秒时间戳。
- 未配置 `platform` 时，下面的路由都不存在（404 `route_not_found`）。

### 对象

```text
Account      { id, email, name, status, balance, created_at }
Session      { token, expires_at }
PortalKey    { id, name, created_at, revoked（恒为 false）, quota, usage: { used_tokens, used_runs, active_runs } }
Price        { per_run, per_1k_tokens }
ListedAgent  { id, title, summary, tags, description, kind: "kernel" | "external", models, price, updated_at, conversion? }
Listing      { agent_id, title, summary, tags, price, enabled, updated_at, agent_exists }
LedgerEntry  { id, kind, amount, balance_after, agent, run_id, tokens, status, note, reference?, created_at }
Usage        { balance, totals: { runs, tokens, spent }, daily: [{ date, runs, tokens, spent }], by_agent: [{ agent, runs, tokens, spent }] }
RunItem      { id, agent, status, tokens, charge, created_at }
RunDetail    { id, agent, status, created_at, completed_at, usage, error, charge, price: Price, output_text, timeline }
Code         { id, kind, credits, max_uses, used, expires_at, note, revoked, created_at }
AdminAccount = Account + { keys, runs, spent, last_active_at }
```

`models` 是该智能体可选的模型线路名（含 `auto`）。`conversion` 是现有的接入画像对象，原样带出。`daily[].date` 是 UTC 的 `YYYY-MM-DD`，连续不缺日。`spent` 为正数。`charge` 是已收的点数（正数）。`reference?` 只在带外部单号的入账上出现，其它流水行没有这个字段（不是 `null`）。`RunDetail` 各字段的含义见「查看任务的过程」。

### 公开（不需要凭据）

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /v1/portal/site` | — | `{ site_name, registration, base_url, endpoints, version }`（`endpoints` 与 `GET /v1/me` 的目录相同） |
| `GET /v1/portal/agents` | — | `{ data: ListedAgent[] }` |
| `GET /v1/portal/agent?id=` | — | `ListedAgent`；未上架 404 `agent_not_found` |
| `POST /v1/portal/signup` | `{ email, password, name?, invite_code? }` | 201 `{ account, session }` |
| `POST /v1/portal/login` | `{ email, password }` | `{ account, session }` |
| `POST /v1/portal/password-reset` | `{ email, code, new_password }` | 204；码错误、过期、已用或邮箱不存在统一 400 `invalid_code`；按来源 IP 与邮箱限流 |

### 门户会话（`Authorization: Bearer oas_…`）

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `POST /v1/portal/logout` | — | 204 |
| `GET /v1/portal/account` | — | `{ account }` |
| `POST /v1/portal/account/password` | `{ current_password, new_password }` | 204 |
| `GET /v1/portal/keys` | — | `{ data: PortalKey[] }` |
| `POST /v1/portal/keys` | `{ name }` | 201 `PortalKey + { token }`（明文只此一次） |
| `DELETE /v1/portal/keys/:id` | — | 204 |
| `POST /v1/portal/redeem` | `{ code }` | `{ account, credited }` |
| `GET /v1/portal/usage?days=30` | — | `Usage`（`days` 取 1 到 90） |
| `GET /v1/portal/ledger?limit=50&cursor=` | — | `{ data: LedgerEntry[], next_cursor }`（新的在前） |
| `GET /v1/portal/runs?limit=20&cursor=&agent=` | — | `{ data: RunItem[], next_cursor }`（新的在前；`limit` 取 1 到 200，`agent` 可选，按智能体过滤） |
| `GET /v1/portal/runs/:id` | — | `RunDetail`；不是本账号的任务或不存在：404 `run_not_found` |

### 运营者（owner 级管理员密钥，只在控制台域名上可用）

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /v1/platform/setup` | — | `{ enabled, source, managed_by_config, pending_restart, owner, settings, desired }`：`enabled` 当前进程里平台是否在运行；`source` 运行中的平台来自 `"config"`（配置文件）或 `"console"`（界面保存的设置），没在运行为 `null`；`managed_by_config` 配置文件里有 `platform` 段（界面只读）；`pending_restart` 已保存的设置与当前运行状态不一致、重启后才生效；`owner` 启用后智能体归属的 owner；`settings` 为 `{ site_name, registration, signup_credits }`，从没保存过为 `null`；`desired` 已保存的开关。**平台未启用时也可用**；设置归首次启用它的 owner，其它 owner 403 `scope_denied` |
| `PUT /v1/platform/setup` | `{ enabled, site_name?, registration?, signup_credits? }`（多余字段 400；取值范围与配置文件的 `platform` 段相同；`enabled: false` 时其余字段忽略；没给的字段保持已保存的值） | 与 GET 相同；重启后生效；写审计（`platform_setup`）；配置文件里有 `platform` 段时 409 `platform_managed_by_config` |
| `GET /v1/platform/summary` | — | `{ site_name, registration, accounts: { total, active, disabled }, balance_total, spent_total, runs_total, tokens_total, listings }` |
| `GET /v1/platform/accounts?query=&limit=&cursor=` | — | `{ data: AdminAccount[], next_cursor }` |
| `POST /v1/platform/accounts` | `{ email, password, name?, credits? }` | 201 `{ account }`（不受 `registration` 限制） |
| `POST /v1/platform/accounts/:id/status` | `{ status }` | `{ account }` |
| `POST /v1/platform/accounts/:id/credit` | `{ amount, note, reference? }`（可正可负，结果不得小于 0；`reference` 为 1 到 200 个字符的外部单号；`billing` 密钥只能为正数） | `{ account, entry }`；重复提交同一个 `reference` 时多一个 `duplicate: true`，返回第一次的结果 |
| `POST /v1/platform/accounts/:id/password` | `{ new_password }` | 204 |
| `POST /v1/platform/accounts/:id/reset-code` | — | 201 `{ code, expires_at }`（明文只此一次，24 小时有效，生成新的会使旧的失效） |
| `GET /v1/platform/accounts/:id/ledger?limit=&cursor=` | — | `{ data: LedgerEntry[], next_cursor }` |
| `GET /v1/platform/listings` | — | `{ data: Listing[] }` |
| `PUT /v1/platform/listings` | `{ agent_id, title?, summary?, tags?, price?, enabled? }` | `Listing`（有则改、无则建；智能体不存在 404 `agent_not_found`） |
| `DELETE /v1/platform/listings?agent_id=` | — | 204 |
| `GET /v1/platform/codes` | — | `{ data: Code[] }` |
| `POST /v1/platform/codes` | `{ kind, credits?, max_uses?, count?, expires_at?, note? }`（`count` 取 1 到 100） | 201 `{ data: (Code + { code })[] }` |
| `DELETE /v1/platform/codes/:id` | — | 204（作废） |
| `GET /v1/platform/usage?days=30` | — | `Usage + { by_account: [{ account_id, email, runs, tokens, spent }] }` |

另外几点：

- 账号密钥调用 `GET /v1/me` 时，响应多一个字段 `account: { id, balance }`。其它密钥的响应不变。
- `GET /v1/keys`（控制台的密钥列表）不包含账号密钥，输出与之前相同。
- 带 `billing` 权限的充值专用密钥（owner 等于 `platform.owner`）可以调用上表中的 `POST /v1/platform/accounts/:id/credit` 与 `GET /v1/platform/accounts?query=`，不受 `consoleHosts` 限制，但 `credit` 只能加点数（`amount` 必须大于 0）。其它运营者接口仍只接受 owner 级管理员密钥。

## 错误码

以下错误码的类别为 `platform`。完整的错误码目录见 [protocol.md「错误码」](protocol.md#错误码errorcode)。门户接口还可能返回 `run_not_found`、`rate_limited` 等通用码，同样见 protocol.md。

| 码 | 状态 | 含义 |
| --- | --- | --- |
| `registration_closed` | 403 | 这个站点不开放自助注册 |
| `invite_required` | 403 | 注册需要邀请码 |
| `invalid_code` | 400 | 兑换码或邀请码无效、已用完、已过期，或已被本账号用过；重置码的任何一种失败（码错误、过期、已用过，或邮箱不存在）也返回此码 |
| `email_taken` | 409 | 邮箱已注册 |
| `invalid_credentials` | 401 | 邮箱或密码不正确 |
| `session_invalid` | 401 | 门户会话无效或已过期 |
| `account_disabled` | 403 | 账号已停用 |
| `account_not_found` | 404 | 账号不存在 |
| `insufficient_balance` | 402 | 余额不足 |
| `key_limit_reached` | 409 | 账号的密钥数量已到上限 |
| `listing_not_found` | 404 | 该智能体没有上架记录 |
| `code_not_found` | 404 | 兑换码不存在 |
| `reference_conflict` | 409 | 这个外部单号已经用于另一笔金额不同、或另一个账号的入账（`billing` 密钥调用 `credit` 时） |
| `platform_managed_by_config` | 409 | 配置文件里已有 `platform` 段，控制台里不能修改平台设置（`PUT /v1/platform/setup`）；改配置文件后重启，或删掉该段改在控制台里启用 |

## 安全要点

- **两种令牌互不通用**。门户会话（`oas_…`）只能用于 `/v1/portal/*`；账号密钥（`sk-oaa-…`，旧的 `oaa_…` 同样）只能用于调用接口。
- **账号密钥的权限是固定的**。`scopes` 为 `invoke`、`read`、`files`，没有 `approve` 和 `admin`。执行等级只能是 `keyExecution` 配置的 `workspace` 或 `sandbox`，不能是 `host`。执行等级的含义与 [deploy-public.md 第 4 节](deploy-public.md#4-网关配置) 的 `defaultKeyExecution` 相同：`workspace` 级的密钥只能调用 workspace 级智能体，调不了原生智能体、适配器和宿主工具。
- **只能调用上架的智能体**。未上架或已停用的智能体，对账号密钥不可见、不可调。
- **停用即失效**。账号被停用时，它的会话全部作废，它的密钥在鉴权时即被拒绝（`account_disabled`，403）。改密码、被停用、运营者重置密码、用重置码设置新密码时，该账号的全部会话都会作废。
- **密码存储**。使用 `node:crypto` 的 scrypt，参数为 `N=32768, r=8, p=3`，每个账号有独立的随机盐，比较时用 `timingSafeEqual`。参数与盐一起写在存储串里（`scrypt$N$r$p$盐$散列`），以后调整强度不影响已有账号。长度 8 到 200 位。不引入新的依赖。
- **登录失败不泄露邮箱是否存在**。邮箱不存在与密码错误统一返回 401 `invalid_credentials`；对不存在的邮箱也做一次等价的散列计算。
- **限流**。注册每个来源 IP 每小时 10 次；登录与重置密码（`POST /v1/portal/password-reset`）每个来源 IP 每 10 分钟 30 次，每个邮箱每 10 分钟 10 次。超限返回 429 `rate_limited`。不论成败，每次尝试都计数。计数保存在进程内存里，单实例有效。来源 IP 沿用网关已有的规则：只在 `trustProxy` 开启时读取 `X-Forwarded-For`。
- **管理接口的审计**。调整余额、停用或启用账号、重置密码、生成重置码都写入审计记录。
- **兑换码**。明文只在生成时返回一次，数据库里只存散列。同一账号不能重复使用同一张码。
- **充值专用密钥**。`billing` 权限的密钥只能给账号加点数（`credit`，`amount` 必须大于 0）和按邮箱查找账号，没有扣减、管理账号或调用智能体的权限。它不是 `admin` 密钥，所以可以在 API 域名上使用；只有 owner 等于 `platform.owner` 的这类密钥才生效。把它只放在支付回调服务里，并在回调里先验证支付渠道的签名，再调用 `credit`。
- **重置码**。运营者生成的重置码只存散列，绑定到账号，一次有效，24 小时后失效；生成新码会使旧码失效；用掉后该账号的全部会话作废。重置接口对码错误、过期、已用过和邮箱不存在统一返回 400 `invalid_code`，并做一次等价的散列计算，不泄露邮箱是否存在。它的限流数值与登录相同，但计数与登录分开。
- **开放注册的防滥用**。依靠邀请码模式（`registration: invite`）与限流；密码由开发者用重置码自己设置，或由运营者直接设置。
- **门户页面**。沿用控制台同样严格的 CSP，没有内联脚本与内联样式。
- **不要上架原生智能体给不认识的开发者**。Codex、Claude、Antigravity、DSH 等原生智能体以宿主机权限运行，见 [deploy-public.md 第 1 节](deploy-public.md#1-部署前确认)。账号密钥在 `workspace` 等级下本来也调不了它们。

## 限制

以下是当前的明确边界：

- **单网关、SQLite**。不支持多实例、Postgres 和故障切换。
- **不做多发布者**。平台只把 `platform.owner` 名下已上架的智能体提供给开发者，不做多个发布者各自结算。
- **不接真实支付**。点数由运营者发放（兑换码或手动调整）。接哪种支付渠道、用什么货币，由运营者自己决定。
- **没有邮件**，所以重置码要由运营者经其它渠道交给开发者。没有邮箱验证。
- **限流计数在进程内存里**，网关重启后清零。
- **启动对账会扫描流水**。启动对账（见[计费规则](#计费规则)第 11 条）要找出流水里仍标为进行中的行，流水很多时，启动后的这一步会慢一些；它在启动之后异步进行，不阻塞启动。
- **外部智能体可能不报告 token**。这时只有按次价格生效，token 数不是费用估算。
- **余额可能短暂为负**，见 [计费规则](#计费规则) 第 7 条。
- **命令行没有平台管理命令**。运营操作在控制台或 `/v1/platform/*` 接口上完成。
- **反向代理后面必须开启 `trustProxy`**。网关在反向代理后面时，必须开启 `trustProxy`（见 [deploy-public.md 第 4 节](deploy-public.md#4-网关配置)），否则所有访客的来源 IP 都是代理的地址，会共用同一个限流计数。
- **登录按邮箱限流有副作用**。有人反复用错误密码尝试某个邮箱，会让这个邮箱在 10 分钟内无法登录，包括正确的密码。这是防暴力破解的取舍。
- **不支持内联图片**（base64 或 URL）。先经 `POST /v1/files` 上传，再以文件 ID 引用。所有兼容入口都明确拒绝内联图片与音频（400 `unsupported_content`），见 [protocol.md](protocol.md#兼容入口的参数错误与结束原因060)。
- **并发事件流有上限**。每把密钥最多同时保持 64 条运行事件流（`/events`、`/wait`、`GET /v1/responses/{id}?stream=true` 与兼容入口的流式请求），每个 owner 256 条；超限返回 429 `too_many_streams`，并带 `Retry-After`。
- **不做订阅池，不中转登录态**。
